// 应用软件启动前的权限检查（可直接集成到你的软件中）
const http = require('http');

// 替换为从管理后台复制的软件ID
const SOFTWARE_ID = 1772012861583; 
// 权限服务器地址（管理后台地址）
const PERMISSION_SERVER = '47.86.27.237:3000';

/**
 * 检查软件运行权限
 * @returns {Promise<{canRun: boolean, reason: string, software?: object}>}
 */
async function checkSoftwarePermission() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: PERMISSION_SERVER.split(':')[0],
      port: PERMISSION_SERVER.split(':')[1] || 80,
      path: `/api/software/${SOFTWARE_ID}/permission`,
      method: 'GET',
      timeout: 5000 // 5秒超时
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      
      // 接收响应数据
      res.on('data', (chunk) => {
        responseData += chunk.toString();
      });
      
      // 响应结束
      res.on('end', () => {
        try {
          const result = JSON.parse(responseData);
          
          // 统一返回格式
          resolve({
            canRun: result.data?.canRun || false,
            reason: result.data?.reason || result.msg || '未知错误',
            software: result.data?.software || null
          });
        } catch (parseErr) {
          reject(new Error('权限接口响应解析失败：' + parseErr.message));
        }
      });
    });

    // 超时处理
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('权限服务器连接超时'));
    });

    // 错误处理
    req.on('error', (err) => {
      reject(new Error('连接权限服务器失败：' + err.message));
    });

    req.end();
  });
}

// 软件启动主逻辑
async function startMySoftware() {
  console.log(`[权限检查] 正在验证软件ID: ${SOFTWARE_ID} 的运行权限...`);
  
  try {
    const permissionResult = await checkSoftwarePermission();
    
    if (permissionResult.canRun) {
      console.log(`[启动成功] ✅ ${permissionResult.reason}`);
      console.log(`[软件信息] 名称：${permissionResult.software?.name} 版本：${permissionResult.software?.version}`);
      // ========================
      // 这里写你的软件核心业务逻辑
      // ========================
    } else {
      console.log(`[启动失败] ❌ ${permissionResult.reason}`);
      process.exit(1); // 无权限则退出程序
    }
  } catch (error) {
    console.log(`[启动失败] ❌ ${error.message}`);
    process.exit(1); // 连接失败也退出程序
  }
}

// 执行启动
startMySoftware();