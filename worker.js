// Cloudflare Worker for Software Admin

// 环境变量类型提示（运行时会被忽略）
// Env: {
//   SOFTWARE_ADMIN_DB: KVNamespace;
//   SOFTWARE_ADMIN_UPLOADS: R2Bucket;
// }

// 模拟session存储（在生产环境中应使用KV或JWT）
let sessions = {};

// 生成session ID
function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// 读取数据库
async function readDB(env) {
  try {
    const data = await env.SOFTWARE_ADMIN_DB.get('db');
    if (!data) {
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

// 写入数据库
async function writeDB(env, data) {
  await env.SOFTWARE_ADMIN_DB.put('db', JSON.stringify(data));
}

// 处理文件上传到R2
async function handleFileUpload(env, request) {
  const formData = await request.formData();
  const file = formData.get('file');
  
  if (!file) {
    return null;
  }
  
  const filename = Date.now() + '.' + file.name.split('.').pop();
  const buffer = await file.arrayBuffer();
  
  await env.SOFTWARE_ADMIN_UPLOADS.put(filename, buffer);
  
  return {
    filename: filename,
    filepath: `/uploads/${filename}`
  };
}

// 检查登录状态
function checkLogin(request) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) {
    return null;
  }
  
  const sessionIdMatch = cookieHeader.match(/sessionId=([^;]+)/);
  if (!sessionIdMatch) {
    return null;
  }
  
  const sessionId = sessionIdMatch[1];
  return sessions[sessionId] || null;
}

// 处理API请求
async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  
  // 处理登录
  if (path === '/api/login' && method === 'POST') {
    const body = await request.json();
    const { username, password } = body;
    
    const db = await readDB(env);
    const user = db.users.find(u => u.username === username && u.password === password);
    
    if (user) {
      const sessionId = generateSessionId();
      sessions[sessionId] = {
        username: user.username,
        role: user.role || "user",
        loginTime: Date.now()
      };
      
      const response = new Response(JSON.stringify({
        code: 0,
        msg: "登录成功",
        data: {
          username: user.username,
          role: user.role || "user",
          redirect: user.role === "admin" ? "/admin-list.html" : "/user-index.html"
        }
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': `sessionId=${sessionId}; HttpOnly; Max-Age=86400; Path=/`
        }
      });
      
      return response;
    } else {
      return new Response(JSON.stringify({ code: -1, msg: "账号或密码错误" }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 处理注册
  if (path === '/api/register' && method === 'POST') {
    const body = await request.json();
    const { username, password } = body;
    
    if (!username || !password) {
      return new Response(JSON.stringify({ code: -1, msg: "账号密码不能为空" }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const db = await readDB(env);
    const exists = db.users.some(u => u.username === username);
    
    if (exists) {
      return new Response(JSON.stringify({ code: -1, msg: "账号已存在" }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    db.users.push({ username, password, role: "user" });
    await writeDB(env, db);
    
    return new Response(JSON.stringify({ code: 0, msg: "注册成功" }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // 处理退出登录
  if (path === '/api/logout' && method === 'POST') {
    const user = checkLogin(request);
    if (user) {
      const cookieHeader = request.headers.get('Cookie');
      const sessionIdMatch = cookieHeader.match(/sessionId=([^;]+)/);
      if (sessionIdMatch) {
        const sessionId = sessionIdMatch[1];
        delete sessions[sessionId];
      }
    }
    
    return new Response(JSON.stringify({ code: 0, msg: "退出成功" }), {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': 'sessionId=; HttpOnly; Max-Age=0; Path=/'
      }
    });
  }
  
  // 需要登录的接口
  const user = checkLogin(request);
  if (!user) {
    return new Response(JSON.stringify({ code: -2, msg: "请先登录" }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // 获取当前用户信息
  if (path === '/api/user/info' && method === 'GET') {
    return new Response(JSON.stringify({
      code: 0,
      data: {
        username: user.username,
        role: user.role
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // 管理员专属接口
  if (user.role !== 'admin') {
    return new Response(JSON.stringify({ code: -3, msg: "仅管理员可操作" }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // 获取软件列表
  if (path === '/api/software' && method === 'GET') {
    const { page = 1, limit = 10, keyword = '' } = Object.fromEntries(url.searchParams);
    let list = (await readDB(env)).softwares;
    
    if (keyword) {
      list = list.filter(s => s.name.includes(keyword) || s.desc.includes(keyword));
    }
    
    const total = list.length;
    const start = (parseInt(page) - 1) * parseInt(limit);
    
    return new Response(JSON.stringify({ 
      total, 
      data: list.slice(start, start + parseInt(limit)) 
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // 添加软件
  if (path === '/api/software' && method === 'POST') {
    const formData = await request.formData();
    const name = formData.get('name');
    const version = formData.get('version');
    const author = formData.get('author') || '';
    const desc = formData.get('desc') || '';
    
    if (!name || !version) {
      return new Response(JSON.stringify({ code: -1, msg: "名称和版本必填" }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const fileResult = await handleFileUpload(env, request);
    
    const db = await readDB(env);
    const newSoftware = {
      id: Date.now(),
      name, version, author, desc,
      filename: fileResult?.filename || "",
      filepath: fileResult?.filepath || "",
      createTime: new Date().toLocaleString(),
      enabled: false
    };
    
    db.softwares.unshift(newSoftware);
    await writeDB(env, db);
    
    return new Response(JSON.stringify({ 
      code: 0, 
      msg: "添加成功", 
      data: { id: newSoftware.id } 
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // 删除软件
  if (path.match(/^\/api\/software\/\d+$/)) {
    const id = parseInt(path.split('/').pop());
    
    if (method === 'DELETE') {
      const db = await readDB(env);
      const soft = db.softwares.find(s => s.id === id);
      
      if (soft?.filename) {
        await env.SOFTWARE_ADMIN_UPLOADS.delete(soft.filename);
      }
      
      db.softwares = db.softwares.filter(s => s.id !== id);
      await writeDB(env, db);
      
      return new Response(JSON.stringify({ code: 0, msg: "删除成功" }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 切换软件状态
  if (path.match(/^\/api\/software\/\d+\/toggle$/)) {
    if (method === 'PUT') {
      const id = parseInt(path.split('/')[3]);
      const body = await request.json();
      const { enabled } = body;
      
      const db = await readDB(env);
      const item = db.softwares.find(s => s.id === id);
      
      if (!item) {
        return new Response(JSON.stringify({ code: -1, msg: "不存在" }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      item.enabled = enabled;
      await writeDB(env, db);
      
      return new Response(JSON.stringify({ 
        code: 0, 
        msg: enabled ? "已启用" : "已禁用" 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 获取软件状态
  if (path.match(/^\/api\/software\/\d+\/status$/)) {
    if (method === 'GET') {
      const id = parseInt(path.split('/')[3]);
      const soft = (await readDB(env)).softwares.find(s => s.id === id);
      
      if (!soft) {
        return new Response(JSON.stringify({ code: -1, msg: "不存在" }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(JSON.stringify({ 
        code: 0, 
        data: { id: soft.id, enabled: soft.enabled } 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 普通用户查询软件权限
  if (path === '/api/software/query' && method === 'GET') {
    const { keyword } = Object.fromEntries(url.searchParams);
    
    if (!keyword) {
      return new Response(JSON.stringify({ code: -1, msg: "请输入软件ID或名称" }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const db = await readDB(env);
    let results = [];
    
    // 按ID查询
    const id = parseInt(keyword);
    if (!isNaN(id)) {
      const byId = db.softwares.find(s => s.id === id);
      if (byId) results.push(byId);
    }
    
    // 按名称查询
    const byName = db.softwares.filter(s => 
      s.name.toLowerCase().includes(keyword.toLowerCase())
    );
    results = [...results, ...byName];
    
    // 去重
    results = Array.from(new Map(results.map(item => [item.id, item]))).map(item => item[1]);
    
    if (results.length === 0) {
      return new Response(JSON.stringify({ 
        code: 0, 
        data: { list: [], msg: "未找到匹配的软件" } 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
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
    
    return new Response(JSON.stringify({ 
      code: 0, 
      data: { list: data, msg: `找到 ${data.length} 个软件` } 
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // 公开接口：获取软件权限
  if (path.match(/^\/api\/software\/\d+\/permission$/)) {
    if (method === 'GET') {
      const id = parseInt(path.split('/')[3]);
      const soft = (await readDB(env)).softwares.find(s => s.id === id);
      
      if (!soft) {
        return new Response(JSON.stringify({ 
          code: -1, 
          data: { canRun: false, reason: "软件未注册" } 
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(JSON.stringify({
        code: 0,
        data: {
          canRun: soft.enabled,
          reason: soft.enabled ? "已授权" : "已禁用",
          software: { name: soft.name, version: soft.version }
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  
  // 未找到的接口
  return new Response(JSON.stringify({ code: -4, msg: "接口不存在" }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// 处理静态文件
async function handleStaticFile(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // 处理上传文件的访问
  if (path.startsWith('/uploads/')) {
    const filename = path.split('/').pop();
    const object = await env.SOFTWARE_ADMIN_UPLOADS.get(filename);
    
    if (!object) {
      return new Response('File not found', { status: 404 });
    }
    
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    
    return new Response(object.body, { headers });
  }
  
  // 这里可以添加静态文件服务逻辑
  // 或者重定向到Cloudflare Pages
  return new Response('Not found', { status: 404 });
}

// 主处理函数
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 设置CORS头
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie',
      'Access-Control-Allow-Credentials': 'true'
    };
    
    // 处理OPTIONS请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders
      });
    }
    
    // 处理API请求
    if (path.startsWith('/api/')) {
      const response = await handleApiRequest(request, env);
      
      // 添加CORS头
      for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, value);
      }
      
      return response;
    }
    
    // 处理静态文件
    const staticResponse = await handleStaticFile(request, env);
    
    // 添加CORS头
    for (const [key, value] of Object.entries(corsHeaders)) {
      staticResponse.headers.set(key, value);
    }
    
    return staticResponse;
  }
};
