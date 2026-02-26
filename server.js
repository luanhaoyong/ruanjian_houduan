const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const cookieParser = require('cookie-parser');

const app = express();
// 配置CORS允许凭证传递（配合cookie登录态）
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// 模拟session存储登录态
let sessions = {}; 
function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// 路径配置
const DB_FILE = path.join(__dirname, 'db.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// 初始化目录和数据库
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({
    users: [
      { username: "admin", password: "123456", role: "admin" }
    ],
    softwares: []
  }, null, 2));
}

// 安全读取数据库
function readDB() {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    if (!data.trim()) {
      return {
        users: [{ username: "admin", password: "123456", role: "admin" }],
        softwares: []
      };
    }
    return JSON.parse(data);
  } catch (err) {
    console.log('数据库解析失败，使用默认数据：', err.message);
    return {
      users: [{ username: "admin", password: "123456", role: "admin" }],
      softwares: []
    };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// 上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});
const upload = multer({ storage });

// ==================== 权限中间件 ====================
function checkLogin(req, res, next) {
  const sessionId = req.cookies?.sessionId;
  if (sessionId && sessions[sessionId]) {
    req.user = sessions[sessionId];
    next();
  } else {
    res.json({ code: -2, msg: "请先登录" });
  }
}

function checkAdmin(req, res, next) {
  if (req.user?.role === "admin") {
    next();
  } else {
    res.json({ code: -3, msg: "仅管理员可操作" });
  }
}

// ==================== 新增：页面访问权限拦截（可选优化） ====================
// 拦截管理员页面的直接访问
app.use(['/admin-list.html', '/admin-add.html'], (req, res, next) => {
  const sessionId = req.cookies?.sessionId;
  const user = sessions[sessionId];
  // 未登录或非管理员，重定向到登录页
  if (!user || user.role !== 'admin') {
    return res.redirect('/index.html');
  }
  next();
});

// 拦截普通用户页面的直接访问
app.use('/user-index.html', (req, res, next) => {
  const sessionId = req.cookies?.sessionId;
  if (!sessions[sessionId]) {
    return res.redirect('/index.html');
  }
  next();
});

// ==================== 登录接口（核心修改：跳转地址） ====================
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.username === username && u.password === password);
  
  if (user) {
    const sessionId = generateSessionId();
    sessions[sessionId] = { 
      username: user.username, 
      role: user.role || "user",
      loginTime: Date.now() 
    };
    res.cookie('sessionId', sessionId, { 
      httpOnly: true, 
      maxAge: 24 * 60 * 60 * 1000 
    });
    return res.json({ 
      code: 0, 
      msg: "登录成功", 
      data: { 
        username: user.username,
        role: user.role || "user",
        // 核心修改：跳转地址从 admin.html 改为 admin-list.html
        redirect: user.role === "admin" ? "/admin-list.html" : "/user-index.html"
      } 
    });
  } else {
    return res.json({ code: -1, msg: "账号或密码错误" });
  }
});

// ==================== 注册接口 ====================
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.json({ code: -1, msg: "账号密码不能为空" });
  }
  const db = readDB();
  const exists = db.users.some(u => u.username === username);
  if (exists) {
    return res.json({ code: -1, msg: "账号已存在" });
  }
  db.users.push({ username, password, role: "user" });
  writeDB(db);
  res.json({ code: 0, msg: "注册成功" });
});

// ==================== 退出登录 ====================
app.post('/api/logout', (req, res) => {
  const sessionId = req.cookies?.sessionId;
  if (sessionId && sessions[sessionId]) {
    delete sessions[sessionId];
  }
  res.clearCookie('sessionId');
  res.json({ code: 0, msg: "退出成功" });
});

// ==================== 获取当前用户信息 ====================
app.get('/api/user/info', checkLogin, (req, res) => {
  res.json({ 
    code: 0, 
    data: { 
      username: req.user.username, 
      role: req.user.role 
    } 
  });
});

// ==================== 管理员专属接口 ====================
app.get('/api/software', checkLogin, checkAdmin, (req, res) => {
  const { page = 1, limit = 10, keyword = '' } = req.query;
  let list = readDB().softwares;
  if (keyword) list = list.filter(s => s.name.includes(keyword) || s.desc.includes(keyword));
  const total = list.length;
  const start = (page - 1) * limit;
  res.json({ total, data: list.slice(start, start + parseInt(limit)) });
});

// ==================== 添加软件接口（优化：返回软件ID） ====================
app.post('/api/software', checkLogin, checkAdmin, upload.single('file'), (req, res) => {
  const { name, version, author, desc } = req.body;
  if (!name || !version) return res.json({ code: -1, msg: "名称和版本必填" });
  const db = readDB();
  // 封装新软件对象，方便返回ID
  const newSoftware = {
    id: Date.now(),
    name, version, author: author || "", desc: desc || "",
    filename: req.file ? req.file.filename : "",
    filepath: req.file ? `/uploads/${req.file.filename}` : "",
    createTime: new Date().toLocaleString(),
    enabled: false
  };
  db.softwares.unshift(newSoftware);
  writeDB(db);
  // 优化：返回添加成功的软件ID，方便前端扩展
  res.json({ code: 0, msg: "添加成功", data: { id: newSoftware.id } });
});

app.delete('/api/software/:id', checkLogin, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDB();
  const soft = db.softwares.find(s => s.id === id);
  if (soft?.filename) {
    const p = path.join(UPLOAD_DIR, soft.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  db.softwares = db.softwares.filter(s => s.id !== id);
  writeDB(db);
  res.json({ code: 0, msg: "删除成功" });
});

app.put('/api/software/:id/toggle', checkLogin, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { enabled } = req.body;
  const db = readDB();
  const item = db.softwares.find(s => s.id === id);
  if (!item) return res.json({ code: -1, msg: "不存在" });
  item.enabled = enabled;
  writeDB(db);
  res.json({ code: 0, msg: enabled ? "已启用" : "已禁用" });
});

app.get('/api/software/:id/status', checkLogin, checkAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const soft = readDB().softwares.find(s => s.id === id);
  if (!soft) return res.json({ code: -1, msg: "不存在" });
  res.json({ code: 0, data: { id: soft.id, enabled: soft.enabled } });
});

// ==================== 普通用户专属：查询软件权限（支持ID/名称） ====================
app.get('/api/software/query', checkLogin, (req, res) => {
  const { keyword } = req.query;
  if (!keyword) {
    return res.json({ code: -1, msg: "请输入软件ID或名称" });
  }

  const db = readDB();
  let results = [];

  // 先尝试按ID查询
  const id = parseInt(keyword);
  if (!isNaN(id)) {
    const byId = db.softwares.find(s => s.id === id);
    if (byId) results.push(byId);
  }

  // 再按名称模糊查询
  const byName = db.softwares.filter(s => 
    s.name.toLowerCase().includes(keyword.toLowerCase())
  );
  results = [...results, ...byName];

  // 去重
  results = Array.from(new Map(results.map(item => [item.id, item]))).map(item => item[1]);

  if (results.length === 0) {
    return res.json({ code: 0, data: { list: [], msg: "未找到匹配的软件" } });
  }

  // 返回权限信息
  const data = results.map(s => ({
    id: s.id,
    name: s.name,
    version: s.version,
    enabled: s.enabled,
    canRun: s.enabled,
    reason: s.enabled ? "已授权" : "已禁用"
  }));

  res.json({ code: 0, data: { list: data, msg: `找到 ${data.length} 个软件` } });
});

// ==================== 公开接口 ====================
app.get('/api/software/:id/permission', (req, res) => {
  const id = parseInt(req.params.id);
  const soft = readDB().softwares.find(s => s.id === id);
  if (!soft) {
    return res.json({ code: -1, data: { canRun: false, reason: "软件未注册" } });
  }
  res.json({
    code: 0,
    data: {
      canRun: soft.enabled,
      reason: soft.enabled ? "已授权" : "已禁用",
      software: { name: soft.name, version: soft.version }
    }
  });
});

// 启动服务
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => { 
  console.log("服务运行在：http://127.0.0.1:3000");
  console.log("外部访问地址：http://你的服务器IP:3000");
  console.log("管理员账号：admin / 123456");
  console.log("普通账号可注册，默认角色为user");
});