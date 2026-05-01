// ============================================================
// file-transfer/main.js - Electron 主进程
// 局域网文件传输工具 v2.0 - Win11 风格
// 支持: 本地IP / FTP / SFTP / WebDAV
// ============================================================

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ---- 远程传输依赖 ----
const { Client: SSHClient } = require('ssh2');
const FTPClient = require('ftp-client');
let createWebDAVClient = null;
function loadWebDAV() {
  if (createWebDAVClient) return;
  try { createWebDAVClient = require('webdav').createClient; } catch(e) {
    try { createWebDAVClient = require('webdav/dist/node/index.js').createClient; } catch(e2) { console.log('[WARN] webdav not available'); }
  }
}

const PORT = 34567;
const BROADCAST_PORT = 34568;
const BROADCAST_INTERVAL = 3000;
const DEST_FILE = path.join(app.getPath('userData'), 'destinations.json');

let mainWindow = null;
let destWindow = null;
let server = null;
let udpSocket = null;
let discoveredDevices = new Map();
let deviceId = crypto.randomBytes(8).toString('hex');
let deviceName = os.hostname();
let sendCancelled = false;  // 取消标志

// ---- 获取本机 IP ----
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ---- 目标管理 ----
function loadDestinations() {
  try {
    if (fs.existsSync(DEST_FILE)) {
      return JSON.parse(fs.readFileSync(DEST_FILE, 'utf8'));
    }
  } catch (e) { console.error('加载目标失败:', e); }
  return [];
}

function saveDestinations(dests) {
  fs.writeFileSync(DEST_FILE, JSON.stringify(dests, null, 2), 'utf8');
}

// ---- 解析 URL ----
function parseUrl(url) {
  // sftp://user:pass@host:port/path/
  // ftp://user:pass@host:port/path/
  // http://user:pass@host:port/path/
  // 192.168.1.100:8101 (本地IP)
  
  // 本地 IP 格式
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(url)) {
    const [host, port] = url.split(':');
    return { type: 'local', host, port: parseInt(port) };
  }
  
  try {
    const u = new URL(url);
    const type = u.protocol.replace(':', ''); // ftp, sftp, http, https
    return {
      type,
      host: u.hostname,
      port: u.port ? parseInt(u.port) : (type === 'sftp' ? 22 : type === 'ftp' ? 21 : 80),
      user: decodeURIComponent(u.username || ''),
      pass: decodeURIComponent(u.password || ''),
      path: u.pathname || '/',
    };
  } catch (e) {
    return null;
  }
}

// ---- 创建主窗口 ----
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 700,
    minHeight: 450,
    title: '文件传输',
    frame: false,
    backgroundColor: '#191919',
    show: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

// ---- 创建目标管理窗口 ----
function createDestWindow() {
  console.log('[Dest] createDestWindow called');
  if (destWindow) {
    console.log('[Dest] window exists, focusing');
    destWindow.focus();
    return;
  }
  destWindow = new BrowserWindow({
    width: 750,
    height: 500,
    title: '传输目标管理',
    parent: mainWindow,
    modal: false,
    frame: false,
    backgroundColor: '#191919',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  destWindow.loadFile('destinations.html').then(() => { console.log('[Dest] loaded OK'); }).catch(err => { console.error('[Dest] load error:', err); });
  destWindow.webContents.on('did-finish-load', () => { console.log('[Dest] finished loading'); });
  destWindow.webContents.on('console-message', (e, level, msg, line) => { console.log(`[Dest-Console] ${msg}`); });
  destWindow.on('closed', () => { console.log('[Dest] closed'); destWindow = null; });
}

// ---- UDP 设备发现 ----
function startDiscovery() {
  udpSocket = dgram.createSocket('udp4');
  udpSocket.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'discover' && data.deviceId !== deviceId) {
        const reply = JSON.stringify({ type: 'response', deviceId, deviceName, ip: getLocalIP() });
        udpSocket.send(reply, rinfo.port, rinfo.address);
      } else if (data.type === 'response') {
        discoveredDevices.set(data.deviceId, { name: data.deviceName, ip: data.ip, lastSeen: Date.now() });
        if (mainWindow) {
          const devices = [
            { id: 'manual', name: '手动输入 IP...', ip: '', url: '' },
            ...Array.from(discoveredDevices.entries()).map(([id, info]) => ({
              id, name: `${info.name} (${info.ip})`, ip: info.ip, url: info.ip,
            })),
          ];
          mainWindow.webContents.send('devices-updated', devices);
        }
      }
    } catch (e) {}
  });
  udpSocket.bind(BROADCAST_PORT, () => {
    setInterval(() => {
      const msg = JSON.stringify({ type: 'discover', deviceId, deviceName });
      udpSocket.send(msg, BROADCAST_PORT, '255.255.255.255');
    }, BROADCAST_INTERVAL);
    const msg = JSON.stringify({ type: 'discover', deviceId, deviceName });
    udpSocket.send(msg, BROADCAST_PORT, '255.255.255.255');
  });
}

// ---- TCP 接收服务器 ----
function startServer() {
  const saveDir = path.join(os.homedir(), 'Downloads', 'FileTransfer');
  
  server = net.createServer((socket) => {
    let receivedBytes = 0;
    let fileName = '';
    let fileSize = 0;
    let fileCount = 0;
    let currentFileIndex = 0;
    let files = [];
    let fileWriteStream = null;
    let state = 'handshake'; // handshake -> file-info -> file-data -> done
    let handshakeBuffer = Buffer.alloc(0);
    let dataBuffer = Buffer.alloc(0);
    
    // 协议 v2: 先握手交换信息，再逐文件传输
    // 握手包: [protocol:2][fileCount:4][每个文件: [nameLen:4][name][size:8]]
    // 响应包: [每个文件: [offset:8]] (支持断点续传)
    // 文件数据包: [data...]
    
    socket.on('data', (chunk) => {
      try {
        if (state === 'handshake') {
          handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
          // 尝试解析握手包
          if (handshakeBuffer.length >= 6) {
            const proto = handshakeBuffer.readUInt16BE(0);
            if (proto !== 2) {
              socket.end();
              return;
            }
            fileCount = handshakeBuffer.readUInt32BE(2);
            let offset = 6;
            files = [];
            let parsed = true;
            for (let i = 0; i < fileCount; i++) {
              if (handshakeBuffer.length < offset + 4) { parsed = false; break; }
              const nameLen = handshakeBuffer.readUInt32BE(offset); offset += 4;
              if (handshakeBuffer.length < offset + nameLen) { parsed = false; break; }
              const name = handshakeBuffer.slice(offset, offset + nameLen).toString('utf8'); offset += nameLen;
              if (handshakeBuffer.length < offset + 8) { parsed = false; break; }
              const size = Number(handshakeBuffer.readBigUInt64BE(offset)); offset += 8;
              files.push({ name, size });
            }
            
            if (parsed) {
              // 发送断点续传响应：每个文件的已接收大小
              const resumeInfo = Buffer.alloc(8 * fileCount);
              for (let i = 0; i < fileCount; i++) {
                const f = files[i];
                const filePath = path.join(saveDir, f.name);
                let existingSize = 0;
                try {
                  if (fs.existsSync(filePath)) {
                    existingSize = fs.statSync(filePath).size;
                    // 如果大小不匹配，从头开始
                    if (existingSize > f.size) existingSize = 0;
                  }
                } catch(e) {}
                resumeInfo.writeBigUInt64BE(BigInt(existingSize), i * 8);
              }
              socket.write(resumeInfo);
              
              // 开始接收第一个文件
              currentFileIndex = 0;
              state = 'file-info';
              dataBuffer = handshakeBuffer.slice(offset);
              processNextFile();
            }
          }
        } else if (state === 'file-info' || state === 'file-data') {
          dataBuffer = Buffer.concat([dataBuffer, chunk]);
          processFileData();
        }
      } catch (err) {
        console.error('[Receiver] Error:', err);
        if (mainWindow) mainWindow.webContents.send('receive-error', { message: err.message });
        socket.end();
      }
    });
    
    function processNextFile() {
      if (currentFileIndex >= fileCount) {
        state = 'done';
        if (mainWindow) mainWindow.webContents.send('receive-complete', { totalFiles: fileCount });
        socket.end();
        return;
      }
      
      const f = files[currentFileIndex];
      fileName = f.name;
      fileSize = f.size;
      receivedBytes = 0;
      
      const filePath = path.join(saveDir, fileName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      
      // 空目录占位
      if (fileName.endsWith('/.keep')) {
        fs.mkdirSync(filePath.replace(/\.keep$/, ''), { recursive: true });
        currentFileIndex++;
        processNextFile();
        return;
      }
      
      // 检查是否续传
      let existingSize = 0;
      try {
        if (fs.existsSync(filePath)) {
          existingSize = fs.statSync(filePath).size;
          if (existingSize > fileSize) existingSize = 0;
        }
      } catch(e) {}
      
      // 打开文件（续传用追加模式，新文件用写入模式）
      if (existingSize > 0) {
        fileWriteStream = fs.createWriteStream(filePath, { flags: 'a' });
        receivedBytes = existingSize;
      } else {
        fileWriteStream = fs.createWriteStream(filePath);
      }
      
      state = 'file-data';
      processFileData();
    }
    
    function processFileData() {
      if (currentFileIndex >= fileCount) return;
      
      const f = files[currentFileIndex];
      const remaining = f.size - receivedBytes;
      
      if (dataBuffer.length > 0 && remaining > 0) {
        const toWrite = Math.min(dataBuffer.length, remaining);
        const chunk = dataBuffer.slice(0, toWrite);
        dataBuffer = dataBuffer.slice(toWrite);
        receivedBytes += chunk.length;
        if (fileWriteStream) fileWriteStream.write(chunk);
        
        if (mainWindow) {
          mainWindow.webContents.send('receive-progress', {
            fileName, receivedBytes, totalBytes: fileSize,
            progress: fileSize > 0 ? Math.round((receivedBytes / fileSize) * 100) : 100,
            currentFile: currentFileIndex + 1, totalFiles: fileCount,
          });
        }
      }
      
      if (receivedBytes >= fileSize) {
        if (fileWriteStream) { fileWriteStream.end(); fileWriteStream = null; }
        currentFileIndex++;
        processNextFile();
      }
    }
    
    socket.on('error', (err) => {
      if (fileWriteStream) { fileWriteStream.end(); fileWriteStream = null; }
      if (mainWindow) mainWindow.webContents.send('receive-error', { message: err.message });
    });
  });
  server.listen(PORT, '0.0.0.0', () => { console.log(`接收服务器监听端口 ${PORT}`); });
}

// ---- 远程传输函数 ----

// FTP 上传
async function uploadFtp(filePaths, destInfo) {
  if (mainWindow) mainWindow.webContents.send('send-status', { icon: '🔗', text: '正在连接...', detail: `${destInfo.host}:${destInfo.port}`, status: 'connecting' });
  const client = new FTPClient({ host: destInfo.host, port: destInfo.port });
  await client.connect({ user: destInfo.user, password: destInfo.pass });
  if (mainWindow) mainWindow.webContents.send('send-status', { icon: '✅', text: '连接验证成功', detail: `已连接到 ${destInfo.host}`, status: 'connected' });
  const remoteDir = destInfo.path || '/';
  
  for (let i = 0; i < filePaths.length; i++) {
    if (sendCancelled) { client.close(); throw new Error('用户取消发送'); }
    const fp = filePaths[i];
    const remotePath = path.posix.join(remoteDir, fp.name);
    const remoteDirForFile = path.posix.dirname(remotePath);
    // 递归创建目录
    const dirParts = remoteDirForFile.split('/').filter(p => p);
    let curPath = '';
    for (const part of dirParts) { curPath += '/' + part; try { await client.mkdir(curPath); } catch(e) {} }
    // 空目录占位：只创建目录不上传文件
    if (fp.isEmptyDir) {
      if (mainWindow) {
        mainWindow.webContents.send('send-file-start', { fileName: fp.name, currentFile: i + 1, totalFiles: filePaths.length });
        mainWindow.webContents.send('send-progress', { fileName: fp.name, fileProgress: 100, totalProgress: Math.round(((i + 1) / filePaths.length) * 100), sentBytes: filePaths.slice(0, i + 1).reduce((s, f) => s + f.size, 0), totalBytes: filePaths.reduce((s, f) => s + f.size, 0), currentFile: i + 1, totalFiles: filePaths.length });
      }
      continue;
    }
    if (mainWindow) {
      mainWindow.webContents.send('send-file-start', { fileName: fp.name, currentFile: i + 1, totalFiles: filePaths.length });
    }
    // 空文件处理
    if (fp.size === 0) {
      if (mainWindow) {
        mainWindow.webContents.send('send-progress', { fileName: fp.name, fileProgress: 100, totalProgress: Math.round(((i + 1) / filePaths.length) * 100), sentBytes: filePaths.slice(0, i + 1).reduce((s, f) => s + f.size, 0), totalBytes: filePaths.reduce((s, f) => s + f.size, 0), currentFile: i + 1, totalFiles: filePaths.length });
      }
      continue;
    }
    await client.upload({
      local: fp.path,
      remote: remotePath,
    }, (res) => {
      // progress callback
    });
    if (mainWindow) {
      mainWindow.webContents.send('send-progress', {
        fileName: fp.name, fileProgress: 100, totalProgress: Math.round(((i + 1) / filePaths.length) * 100),
        sentBytes: filePaths.slice(0, i + 1).reduce((s, f) => s + f.size, 0),
        totalBytes: filePaths.reduce((s, f) => s + f.size, 0),
        currentFile: i + 1, totalFiles: filePaths.length,
      });
    }
  }
  client.close();
}

// SFTP 上传
async function uploadSftp(filePaths, destInfo) {
  if (mainWindow) mainWindow.webContents.send('send-status', { icon: '🔗', text: '正在连接...', detail: `${destInfo.host}:${destInfo.port}`, status: 'connecting' });
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    conn.on('ready', () => {
      if (mainWindow) mainWindow.webContents.send('send-status', { icon: '✅', text: '连接验证成功', detail: `已连接到 ${destInfo.host}`, status: 'connected' });
      conn.sftp(async (err, sftp) => {
        if (err) { if (mainWindow) mainWindow.webContents.send('send-status', { icon: '❌', text: 'SFTP 通道失败', detail: err.message, status: 'error' }); conn.end(); reject(err); return; }
        
        // 辅助函数：递归创建远程目录
        const mkdirRecursive = async (dirPath) => {
          const parts = dirPath.split('/').filter(p => p);
          let current = '';
          for (const part of parts) {
            current += '/' + part;
            try { await new Promise((r) => sftp.mkdir(current, (e) => r())); } catch(e) {}
          }
        };

        for (let i = 0; i < filePaths.length; i++) {
          // 检查是否取消
          if (sendCancelled) {
            conn.end();
            reject(new Error('用户取消发送'));
            return;
          }

          const fp = filePaths[i];
          const remotePath = path.posix.join(destInfo.path || '/', fp.name);
          const remoteDir = path.posix.dirname(remotePath);
          
          if (remoteDir && remoteDir !== '.') {
            await mkdirRecursive(remoteDir);
          }
          
          // 空目录占位：只创建目录不上传文件
          if (fp.isEmptyDir) {
            if (mainWindow) {
              mainWindow.webContents.send('send-file-start', { fileName: fp.name, currentFile: i + 1, totalFiles: filePaths.length });
              mainWindow.webContents.send('send-progress', { fileName: fp.name, fileProgress: 100, totalProgress: Math.round(((i + 1) / filePaths.length) * 100), sentBytes: filePaths.slice(0, i + 1).reduce((s, f) => s + f.size, 0), totalBytes: filePaths.reduce((s, f) => s + f.size, 0), currentFile: i + 1, totalFiles: filePaths.length });
            }
            continue;
          }
          
          if (mainWindow) {
            mainWindow.webContents.send('send-file-start', { fileName: fp.name, currentFile: i + 1, totalFiles: filePaths.length });
          }
          
          // 空文件处理
          if (fp.size === 0) {
            if (mainWindow) {
              mainWindow.webContents.send('send-progress', { fileName: fp.name, fileProgress: 100, totalProgress: Math.round(((i + 1) / filePaths.length) * 100), sentBytes: filePaths.slice(0, i + 1).reduce((s, f) => s + f.size, 0), totalBytes: filePaths.reduce((s, f) => s + f.size, 0), currentFile: i + 1, totalFiles: filePaths.length });
            }
            continue;
          }
          
          await new Promise((res, rej) => {
            const readStream = fs.createReadStream(fp.path);
            const writeStream = sftp.createWriteStream(remotePath);
            let sent = 0;
            readStream.on('data', (chunk) => {
              if (sendCancelled) { readStream.destroy(); writeStream.destroy(); rej(new Error('用户取消发送')); return; }
              sent += chunk.length;
              const progress = fp.size > 0 ? Math.round((sent / fp.size) * 100) : 100;
              if (mainWindow) {
                mainWindow.webContents.send('send-progress', {
                  fileName: fp.name, fileProgress: progress,
                  totalProgress: Math.round(((i + sent / fp.size) / filePaths.length) * 100),
                  sentBytes: filePaths.slice(0, i).reduce((s, f) => s + f.size, 0) + sent,
                  totalBytes: filePaths.reduce((s, f) => s + f.size, 0),
                  currentFile: i + 1, totalFiles: filePaths.length,
                });
              }
            });
            writeStream.on('close', res);
            writeStream.on('error', rej);
            readStream.on('error', rej);
            readStream.pipe(writeStream);
          });
        }
        conn.end();
        resolve();
      });
    });
    conn.on('error', reject);
    conn.connect({
      host: destInfo.host,
      port: destInfo.port,
      username: destInfo.user,
      password: destInfo.pass,
    });
  });
}

// WebDAV 上传
async function uploadWebDAV(filePaths, destInfo) {
  if (mainWindow) mainWindow.webContents.send('send-status', { icon: '🔗', text: '正在连接...', detail: `${destInfo.host}:${destInfo.port}`, status: 'connecting' });
  loadWebDAV();
  if (!createWebDAVClient) {
    if (mainWindow) mainWindow.webContents.send('send-status', { icon: '❌', text: 'WebDAV 模块加载失败', detail: '请检查依赖安装', status: 'error' });
    throw new Error('WebDAV 模块加载失败');
  }
  const protocol = destInfo.type === 'https' ? 'https' : 'http';
  const client = createWebDAVClient(`${protocol}://${destInfo.host}:${destInfo.port}${destInfo.path || '/'}`, {
    username: destInfo.user,
    password: destInfo.pass,
  });
  if (mainWindow) mainWindow.webContents.send('send-status', { icon: '✅', text: '连接验证成功', detail: `已连接到 ${destInfo.host}`, status: 'connected' });
  
  for (let i = 0; i < filePaths.length; i++) {
    if (sendCancelled) throw new Error('用户取消发送');
    const fp = filePaths[i];
    if (mainWindow) {
      mainWindow.webContents.send('send-file-start', { fileName: fp.name, currentFile: i + 1, totalFiles: filePaths.length });
    }
    
    // 确保目录存在（递归创建）
    const dirPath = path.posix.dirname(fp.name);
    if (dirPath && dirPath !== '.') {
      const parts = dirPath.split('/').filter(p => p);
      let cur = '';
      for (const part of parts) { cur += '/' + part; try { await client.createDirectory(cur); } catch(e) {} }
    }
    // 空目录占位：只创建目录不上传文件
    if (fp.isEmptyDir) {
      if (mainWindow) {
        mainWindow.webContents.send('send-progress', { fileName: fp.name, fileProgress: 100, totalProgress: Math.round(((i + 1) / filePaths.length) * 100), sentBytes: filePaths.slice(0, i + 1).reduce((s, f) => s + f.size, 0), totalBytes: filePaths.reduce((s, f) => s + f.size, 0), currentFile: i + 1, totalFiles: filePaths.length });
      }
      continue;
    }
    // 空文件处理
    if (fp.size === 0) {
      if (mainWindow) {
        mainWindow.webContents.send('send-progress', { fileName: fp.name, fileProgress: 100, totalProgress: Math.round(((i + 1) / filePaths.length) * 100), sentBytes: filePaths.slice(0, i + 1).reduce((s, f) => s + f.size, 0), totalBytes: filePaths.reduce((s, f) => s + f.size, 0), currentFile: i + 1, totalFiles: filePaths.length });
      }
      continue;
    }
    const fileData = fs.readFileSync(fp.path);
    await client.putFileContents(fp.name, fileData);
    
    if (mainWindow) {
      mainWindow.webContents.send('send-progress', {
        fileName: fp.name, fileProgress: 100,
        totalProgress: Math.round(((i + 1) / filePaths.length) * 100),
        sentBytes: filePaths.slice(0, i + 1).reduce((s, f) => s + f.size, 0),
        totalBytes: filePaths.reduce((s, f) => s + f.size, 0),
        currentFile: i + 1, totalFiles: filePaths.length,
      });
    }
  }
}

// 本地 IP 传输（TCP）
async function uploadLocal(filePaths, destInfo) {
  if (mainWindow) mainWindow.webContents.send('send-status', { icon: '🔗', text: '正在连接...', detail: `${destInfo.host}:${destInfo.port}`, status: 'connecting' });
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let fileReadStream = null;
    socket.on('error', (err) => {
      if (mainWindow) mainWindow.webContents.send('send-status', { icon: '❌', text: '连接失败', detail: err.message, status: 'error' });
      if (fileReadStream) fileReadStream.destroy();
      reject(err);
    });
    let totalSent = 0;
    const totalSize = filePaths.reduce((s, f) => s + f.size, 0);
    let currentFileIndex = 0;
    let currentFileSent = 0;
    let resumeOffsets = [];
    let handshakeReceived = false;
    let handshakeBuffer = Buffer.alloc(0);
    
    // 协议 v2: [proto:2][count:4][文件1: nameLen:4 + name + size:8]...
    const handshakeBuffers = [];
    handshakeBuffers.push(Buffer.alloc(2).writeUInt16BE(2) ? Buffer.alloc(2) : Buffer.alloc(2));
    handshakeBuffers[0].writeUInt16BE(2);
    const countBuf = Buffer.alloc(4);
    countBuf.writeUInt32BE(filePaths.length);
    handshakeBuffers.push(countBuf);
    for (const file of filePaths) {
      const nameBuf = Buffer.from(file.name, 'utf8');
      const nameLenBuf = Buffer.alloc(4);
      nameLenBuf.writeUInt32BE(nameBuf.length);
      handshakeBuffers.push(nameLenBuf, nameBuf);
      const sizeBuf = Buffer.alloc(8);
      sizeBuf.writeBigUInt64BE(BigInt(file.size));
      handshakeBuffers.push(sizeBuf);
    }

    socket.setTimeout(15000);
    socket.on('timeout', () => {
      if (mainWindow) mainWindow.webContents.send('send-status', { icon: '❌', text: '连接超时', detail: '目标设备未响应', status: 'error' });
      socket.destroy();
      reject(new Error('连接超时'));
    });
    
    socket.connect(destInfo.port, destInfo.host, () => {
      if (mainWindow) mainWindow.webContents.send('send-status', { icon: '✅', text: '连接成功', detail: `已连接到 ${destInfo.host}`, status: 'connected' });
      socket.write(Buffer.concat(handshakeBuffers));
    });
    
    socket.on('data', (chunk) => {
      if (!handshakeReceived) {
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const expectedSize = 8 * filePaths.length;
        if (handshakeBuffer.length >= expectedSize) {
          handshakeReceived = true;
          resumeOffsets = [];
          let totalResumed = 0;
          for (let i = 0; i < filePaths.length; i++) {
            const offset = Number(handshakeBuffer.readBigUInt64BE(i * 8));
            resumeOffsets.push(offset);
            totalResumed += offset;
          }
          totalSent = totalResumed;
          const resumeCount = resumeOffsets.filter(o => o > 0).length;
          if (resumeCount > 0 && mainWindow) {
            mainWindow.webContents.send('send-status', { icon: '🔄', text: '断点续传', detail: `${resumeCount} 个文件续传`, status: 'connecting' });
          }
          setTimeout(() => sendNext(), 10);
        }
      }
    });

    function sendNext() {
      if (sendCancelled) {
        if (fileReadStream) fileReadStream.destroy();
        socket.end();
        reject(new Error('用户取消发送'));
        return;
      }
      if (currentFileIndex >= filePaths.length) {
        if (mainWindow) {
          mainWindow.webContents.send('send-progress', {
            fileName: '', fileProgress: 100, totalProgress: 100,
            sentBytes: totalSize, totalBytes: totalSize,
            currentFile: filePaths.length, totalFiles: filePaths.length,
          });
        }
        socket.end();
        resolve();
        return;
      }
      const file = filePaths[currentFileIndex];
      const resumeOffset = resumeOffsets[currentFileIndex] || 0;
      currentFileSent = resumeOffset;
      
      if (mainWindow) {
        mainWindow.webContents.send('send-file-start', { fileName: file.name, currentFile: currentFileIndex + 1, totalFiles: filePaths.length });
      }

      if (file.size === 0 || file.isEmptyDir) {
        totalSent += file.size;
        currentFileIndex++;
        if (mainWindow) {
          mainWindow.webContents.send('send-progress', {
            fileName: file.name, fileProgress: 100,
            totalProgress: totalSize > 0 ? Math.round((totalSent / totalSize) * 100) : 100,
            sentBytes: totalSent, totalBytes: totalSize,
            currentFile: currentFileIndex, totalFiles: filePaths.length,
          });
        }
        setTimeout(() => sendNext(), 10);
        return;
      }
      
      if (resumeOffset >= file.size) {
        totalSent += file.size;
        currentFileIndex++;
        setTimeout(() => sendNext(), 10);
        return;
      }
      
      fileReadStream = fs.createReadStream(file.path, { highWaterMark: 1024 * 1024, start: resumeOffset });
      fileReadStream.on('data', (chunk) => {
        if (sendCancelled) { fileReadStream.destroy(); socket.end(); reject(new Error('用户取消发送')); return; }
        const canWrite = socket.write(chunk);
        if (!canWrite) { fileReadStream.pause(); socket.once('drain', () => fileReadStream.resume()); }
        currentFileSent += chunk.length;
        totalSent += chunk.length;
        if (mainWindow) {
          mainWindow.webContents.send('send-progress', {
            fileName: file.name,
            fileProgress: file.size > 0 ? Math.round((currentFileSent / file.size) * 100) : 100,
            totalProgress: totalSize > 0 ? Math.round((totalSent / totalSize) * 100) : 100,
            sentBytes: totalSent, totalBytes: totalSize,
            currentFile: currentFileIndex + 1, totalFiles: filePaths.length,
          });
        }
      });
      fileReadStream.on('end', () => { currentFileIndex++; setTimeout(() => sendNext(), 50); });
      fileReadStream.on('error', (err) => { socket.end(); reject(err); });
    }
  });
}

// ---- IPC 处理 ----

ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
  if (result.canceled) return [];
  return result.filePaths.map((fp) => ({ path: fp, name: path.basename(fp), size: fs.statSync(fp).size }));
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled) return [];
  const dirPath = result.filePaths[0];
  const folderName = path.basename(dirPath);
  // 计算文件夹总大小和文件数
  let totalSize = 0;
  let fileCount = 0;
  function calcSize(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) { calcSize(full); }
          else { totalSize += fs.statSync(full).size; fileCount++; }
        } catch(e) {}
      }
    } catch(e) {}
  }
  calcSize(dirPath);
  console.log('[Folder] 选中:', dirPath, '文件数:', fileCount, '大小:', totalSize);
  // 返回文件夹作为单个项目，标记为 isFolder
  return [{ path: dirPath, name: folderName + '/', size: totalSize, isFolder: true, fileCount: fileCount }];
});

// ---- 目标管理 IPC ----
ipcMain.handle('get-destinations', () => loadDestinations());

ipcMain.handle('add-destination', (e, dest) => {
  const dests = loadDestinations();
  dest.id = crypto.randomBytes(4).toString('hex');
  dests.push(dest);
  saveDestinations(dests);
  return dests;
});

ipcMain.handle('delete-destination', (e, id) => {
  let dests = loadDestinations();
  dests = dests.filter(d => d.id !== id);
  saveDestinations(dests);
  return dests;
});

ipcMain.handle('update-destination', (e, id, updates) => {
  let dests = loadDestinations();
  const idx = dests.findIndex(d => d.id === id);
  if (idx >= 0) { dests[idx] = { ...dests[idx], ...updates }; }
  saveDestinations(dests);
  return dests;
});

ipcMain.handle('open-dest-manager', () => { console.log('[IPC] open-dest-manager'); createDestWindow(); });
ipcMain.handle('cancel-send', () => { sendCancelled = true; });

// 调试日志 IPC
ipcMain.handle('write-debug-log', (event, msg) => {
  log('[Renderer] ' + msg);
  return true;
});

ipcMain.on('dest-window-close', () => { if (destWindow) destWindow.close(); });

// ---- 发送文件（支持所有协议） ----
ipcMain.handle('send-files', async (event, { targetIp, targetUrl, files }) => {
  sendCancelled = false;
  
  // 展开文件夹为文件列表
  const filePaths = [];
  for (const f of files) {
    if (f.isFolder) {
      const dirPath = f.path;
      const folderName = f.name.replace(/\/$/, '');
      function walk(dir) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            try {
              if (entry.isDirectory()) { walk(full); }
              else {
                const relPath = folderName + '/' + path.relative(dirPath, full).replace(/\\/g, '/');
                filePaths.push({ path: full, name: relPath, size: fs.statSync(full).size });
              }
            } catch(e) {}
          }
        } catch(e) {}
      }
      walk(dirPath);
    } else {
      filePaths.push({ path: f.path, name: f.name, size: f.size });
    }
  }
  console.log('[send-files] files after expand folders:', filePaths.length);
  
  // 判断目标类型
  if (targetUrl) {
    const info = parseUrl(targetUrl);
    if (!info) throw new Error(`无法解析目标地址: ${targetUrl}`);
    
    switch (info.type) {
      case 'local':
        await uploadLocal(filePaths, info);
        break;
      case 'ftp':
        await uploadFtp(filePaths, info);
        break;
      case 'sftp':
        await uploadSftp(filePaths, info);
        break;
      case 'http':
      case 'https':
        await uploadWebDAV(filePaths, info);
        break;
      default:
        throw new Error(`不支持的协议: ${info.type}`);
    }
  } else if (targetIp) {
    await uploadLocal(filePaths, { type: 'local', host: targetIp, port: PORT });
  } else {
    throw new Error('未指定目标');
  }
  
  // 发送完成事件（非TCP协议需要在这里发送，TCP协议在uploadLocal内部发送）
  if (mainWindow) {
    mainWindow.webContents.send('send-status', { icon: '🎉', text: '发送完成', detail: `共 ${filePaths.length} 个文件`, status: 'success' });
    mainWindow.webContents.send('send-complete', { totalFiles: filePaths.length });
  }
  return { success: true };
});

ipcMain.handle('get-local-info', () => ({ name: deviceName, ip: getLocalIP() }));

// 窗口控制
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
ipcMain.on('window-close', () => mainWindow?.close());

// 日志文件
const logFile = path.join(app.getPath('userData'), 'debug.log');
function log(msg) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logFile, `[${timestamp}] ${msg}\n`);
}

// 处理文件/文件夹路径
function processArgs(args) {
  log('processArgs called with: ' + JSON.stringify(args));
  console.log('[DEBUG] processArgs called with:', args);
  for (const arg of args) {
    log('checking arg: ' + arg + ' exists: ' + fs.existsSync(arg));
    console.log('[DEBUG] checking arg:', arg, 'exists:', fs.existsSync(arg));
    if (!arg.startsWith('-') && !arg.includes('electron') && fs.existsSync(arg)) {
      setTimeout(() => {
        if (!mainWindow) { log('ERROR: mainWindow null in setTimeout'); return; }
        log('setTimeout processing: ' + arg);
        const stat = fs.statSync(arg);
        if (stat.isDirectory()) {
          // 文件夹作为单个项目添加
          const folderName = path.basename(arg) + '/';
          let totalSize = 0;
          let fileCount = 0;
          function calcSize(dir) {
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                const full = path.join(dir, entry.name);
                try {
                  if (entry.isDirectory()) { calcSize(full); }
                  else { totalSize += fs.statSync(full).size; fileCount++; }
                } catch(e) {}
              }
            } catch(e) {}
          }
          calcSize(arg);
          const folderItem = { path: arg, name: folderName, size: totalSize, isFolder: true, fileCount: fileCount };
          if (mainWindow) {
            log('sending add-files-from-context (folder): ' + folderName + ', files: ' + fileCount);
            mainWindow.show();
            mainWindow.focus();
            mainWindow.setAlwaysOnTop(true);
            setTimeout(() => mainWindow.setAlwaysOnTop(false), 500);
            mainWindow.webContents.send('add-files-from-context', [folderItem]);
          } else {
            log('ERROR: mainWindow is null (folder)!');
          }
        } else {
          const file = { path: arg, name: path.basename(arg), size: fs.statSync(arg).size };
          if (mainWindow) {
            log('sending add-files-from-context: ' + JSON.stringify([file]));
            mainWindow.show();
            mainWindow.focus();
            mainWindow.setAlwaysOnTop(true);
            setTimeout(() => mainWindow.setAlwaysOnTop(false), 500);
            mainWindow.webContents.send('add-files-from-context', [file]);
          } else {
            log('ERROR: mainWindow is null!');
          }
        }
      }, 2000);
    }
  }
}

// 单实例锁
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // 没有获取锁，直接退出
  app.exit(0);
} else {
  app.on('second-instance', (event, commandLine) => {
    log('second-instance: ' + JSON.stringify(commandLine));
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.setAlwaysOnTop(true);
      setTimeout(() => mainWindow.setAlwaysOnTop(false), 500);
    }
    // 处理第二个实例传入的参数
    const args = commandLine.slice(1).filter(a => !a.includes('electron') && !a.startsWith('--'));
    processArgs(args);
  });
}

// 如果没有锁，不继续执行
if (!gotTheLock) {
  process.exit(0);
}

// ---- 生命周期 ----
app.whenReady().then(() => {
  createWindow();
  startServer();
  startDiscovery();
  // 处理命令行参数
  // 开发模式: argv = [electron, main.js, ...userArgs]
  // 打包模式: argv = [exe, ...userArgs]
  log('app ready, process.argv: ' + JSON.stringify(process.argv));
  console.log('[DEBUG] process.argv:', process.argv);
  // 找到用户参数（跳过 exe 和 electron 相关参数）
  const args = process.argv.slice(1).filter(a => !a.includes('electron') && !a.startsWith('--') && !a.endsWith('.asar') && !a.endsWith('.js'));
  console.log('[DEBUG] filtered args:', args);
  log('args to process: ' + JSON.stringify(args));
  processArgs(args);
});
app.on('window-all-closed', () => { if (server) server.close(); if (udpSocket) udpSocket.close(); app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
