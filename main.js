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

// ---- 配置系统 ----
const CONFIG = {
  // 网络配置
  tcpPort: 34567,
  udpPort: 34568,
  broadcastInterval: 3000,
  
  // 传输配置
  chunkSize: 1024 * 1024, // 1MB 分块大小
  maxRetries: 3,
  connectionTimeout: 15000,
  resumeThreshold: 1024 * 1024, // 1MB以上文件支持断点续传
  
  // 安全配置
  maxFileSize: 10 * 1024 * 1024 * 1024, // 10GB单文件限制
  allowedExtensions: [], // 空数组表示允许所有
  blockedPaths: ['..', '.', '/', '\\'], // 危险路径模式
  
  // 日志配置
  logLevel: 'INFO', // DEBUG, INFO, WARN, ERROR
  maxLogSize: 10 * 1024 * 1024, // 10MB日志文件大小限制
  
  // 文件配置
  destFile: path.join(app.getPath('userData'), 'destinations.json'),
  logFile: path.join(app.getPath('userData'), 'debug.log'),
  saveDir: path.join(os.homedir(), 'Downloads', 'FileTransfer'),
};

// ---- 安全工具函数 ----
const Security = {
  // 路径清理，防止目录遍历攻击
  sanitizePath: (inputPath) => {
    if (!inputPath || typeof inputPath !== 'string') {
      return '';
    }
    
    // 移除危险字符
    let sanitized = inputPath
      .replace(/[<>:"|?*]/g, '') // 移除Windows非法字符
      .replace(/\0/g, '') // 移除空字符
      .trim();
    
    // 防止目录遍历
    const normalized = path.normalize(sanitized);
    const parts = normalized.split(path.sep).filter(part => 
      part && !CONFIG.blockedPaths.includes(part)
    );
    
    // 限制路径深度
    if (parts.length > 20) {
      throw new Error('路径深度超过限制');
    }
    
    return parts.join(path.sep);
  },
  
  // 验证文件名
  validateFileName: (fileName) => {
    if (!fileName || typeof fileName !== 'string') {
      return false;
    }
    
    // 检查文件名长度
    if (fileName.length > 255) {
      return false;
    }
    
    // 检查非法字符
    const illegalChars = /[<>:"|?*\x00-\x1F]/;
    if (illegalChars.test(fileName)) {
      return false;
    }
    
    // 检查保留名称（Windows）
    const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reservedNames.test(fileName.replace(/\.[^.]*$/, ''))) {
      return false;
    }
    
    // 检查扩展名（如果有限制）
    if (CONFIG.allowedExtensions.length > 0) {
      const ext = path.extname(fileName).toLowerCase();
      if (!CONFIG.allowedExtensions.includes(ext)) {
        return false;
      }
    }
    
    return true;
  },
  
  // 验证文件大小
  validateFileSize: (size) => {
    return size >= 0 && size <= CONFIG.maxFileSize;
  },
  
  // 验证IP地址
  validateIP: (ip) => {
    if (!ip || typeof ip !== 'string') {
      return false;
    }
    
    // IPv4验证
    const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (ipv4Pattern.test(ip)) {
      const parts = ip.split('.').map(Number);
      return parts.every(part => part >= 0 && part <= 255);
    }
    
    // 简单的主机名验证
    const hostnamePattern = /^[a-zA-Z0-9.-]+$/;
    return hostnamePattern.test(ip) && ip.length <= 253;
  },
  
  // 验证端口
  validatePort: (port) => {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
  }
};

// ---- 日志系统 ----
const Logger = {
  LEVELS: {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
  },
  
  currentLevel: 0, // 将在初始化时设置
  
  // 初始化日志系统
  init: () => {
    Logger.currentLevel = Logger.LEVELS[CONFIG.logLevel] || Logger.LEVELS.INFO;
    
    // 确保日志目录存在
    const logDir = path.dirname(CONFIG.logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // 检查日志文件大小
    if (fs.existsSync(CONFIG.logFile)) {
      const stats = fs.statSync(CONFIG.logFile);
      if (stats.size > CONFIG.maxLogSize) {
        // 备份旧日志
        const backupFile = CONFIG.logFile + '.' + Date.now() + '.bak';
        fs.renameSync(CONFIG.logFile, backupFile);
      }
    }
  },
  
  // 格式化日志消息
  formatMessage: (level, msg, data = null) => {
    const timestamp = new Date().toISOString();
    let message = `[${timestamp}] [${level}] ${msg}`;
    if (data) {
      try {
        message += ` ${JSON.stringify(data)}`;
      } catch (e) {
        message += ` [数据序列化失败]`;
      }
    }
    return message;
  },
  
  // 写入日志文件
  writeToFile: (message) => {
    try {
      fs.appendFileSync(CONFIG.logFile, message + '\n');
    } catch (e) {
      console.error('写入日志文件失败:', e.message);
    }
  },
  
  // 日志级别方法
  debug: (msg, data = null) => {
    if (Logger.currentLevel <= Logger.LEVELS.DEBUG) {
      const message = Logger.formatMessage('DEBUG', msg, data);
      try {
        console.debug(message);
      } catch (e) {
        // 忽略EPIPE错误
        if (e.code !== 'EPIPE') {
          process.stderr.write(`Logger error: ${e.message}\n`);
        }
      }
      Logger.writeToFile(message);
    }
  },
  
  info: (msg, data = null) => {
    if (Logger.currentLevel <= Logger.LEVELS.INFO) {
      const message = Logger.formatMessage('INFO', msg, data);
      try {
        console.log(message);
      } catch (e) {
        // 忽略EPIPE错误
        if (e.code !== 'EPIPE') {
          process.stderr.write(`Logger error: ${e.message}\n`);
        }
      }
      Logger.writeToFile(message);
    }
  },
  
  warn: (msg, data = null) => {
    if (Logger.currentLevel <= Logger.LEVELS.WARN) {
      const message = Logger.formatMessage('WARN', msg, data);
      try {
        console.warn(message);
      } catch (e) {
        // 忽略EPIPE错误
        if (e.code !== 'EPIPE') {
          process.stderr.write(`Logger error: ${e.message}\n`);
        }
      }
      Logger.writeToFile(message);
    }
  },
  
  error: (msg, data = null) => {
    if (Logger.currentLevel <= Logger.LEVELS.ERROR) {
      const message = Logger.formatMessage('ERROR', msg, data);
      try {
        console.error(message);
      } catch (e) {
        // 忽略EPIPE错误
        if (e.code !== 'EPIPE') {
          process.stderr.write(`Logger error: ${e.message}\n`);
        }
      }
      Logger.writeToFile(message);
    }
  },
  
  // 审计日志（用于安全相关事件）
  audit: (action, result, details = null) => {
    const message = Logger.formatMessage('AUDIT', `${action} - ${result}`, details);
    Logger.writeToFile(message);
  }
};

// 常量保持兼容性
let currentPort = CONFIG.tcpPort; // 当前端口号，可更改
const BROADCAST_PORT = CONFIG.udpPort;
const BROADCAST_INTERVAL = CONFIG.broadcastInterval;
const DEST_FILE = CONFIG.destFile;

let mainWindow = null;
let destWindow = null;
let server = null;
let udpSocket = null;
let ipcServer = null; // Finder扩展IPC服务器
let discoveredDevices = new Map();
let deviceId = crypto.randomBytes(8).toString('hex');
let deviceName = os.hostname();
let sendCancelled = false;  // 取消标志

// ---- 状态管理 ----
const AppState = {
  // 发送状态
  sending: {
    isSending: false,
    currentFileIndex: -1,
    totalFiles: 0,
    totalSize: 0,
    sentBytes: 0,
    startTime: null,
    cancelled: false,
  },
  
  // 接收状态
  receiving: {
    isReceiving: false,
    currentFileIndex: -1,
    totalFiles: 0,
    totalSize: 0,
    receivedBytes: 0,
  },
  
  // 窗口状态
  windows: {
    mainWindow: null,
    destWindow: null,
  },
  
  // 设备状态
  devices: {
    discovered: new Map(),
    destinations: [],
  },
  
  // 重置发送状态
  resetSending: () => {
    AppState.sending = {
      isSending: false,
      currentFileIndex: -1,
      totalFiles: 0,
      totalSize: 0,
      sentBytes: 0,
      startTime: null,
      cancelled: false,
    };
    sendCancelled = false;
  },
  
  // 重置接收状态
  resetReceiving: () => {
    AppState.receiving = {
      isReceiving: false,
      currentFileIndex: -1,
      totalFiles: 0,
      totalSize: 0,
      receivedBytes: 0,
    };
  },
  
  // 更新发送进度
  updateSendProgress: (fileIndex, sentBytes, totalBytes) => {
    if (fileIndex >= 0) {
      AppState.sending.currentFileIndex = fileIndex;
    }
    if (sentBytes !== undefined) {
      AppState.sending.sentBytes = sentBytes;
    }
    if (totalBytes !== undefined) {
      AppState.sending.totalSize = totalBytes;
    }
  },
};

// ---- 公共工具函数 ----
const Utils = {
  // 计算进度百分比
  calculateProgress: (sent, total) => {
    return total > 0 ? Math.round((sent / total) * 100) : 100;
  },
  
  // 格式化文件大小
  formatFileSize: (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  },
  
  // 格式化传输速度
  formatSpeed: (bytesPerSecond) => {
    return Utils.formatFileSize(bytesPerSecond) + '/s';
  },
  
  // 计算剩余时间
  calculateETA: (sentBytes, totalBytes, startTime) => {
    if (sentBytes === 0 || !startTime) return '计算中...';
    
    const elapsed = Date.now() - startTime;
    const speed = sentBytes / elapsed;
    const remaining = totalBytes - sentBytes;
    
    if (speed === 0) return '计算中...';
    
    const etaSeconds = remaining / speed;
    if (etaSeconds < 60) {
      return `${Math.round(etaSeconds)}秒`;
    } else if (etaSeconds < 3600) {
      return `${Math.round(etaSeconds / 60)}分钟`;
    } else {
      return `${Math.round(etaSeconds / 3600)}小时`;
    }
  },
  
  // 安全地创建目录
  safeMkdirSync: (dirPath) => {
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        Logger.debug('创建目录: ' + dirPath);
      }
      return true;
    } catch (error) {
      Logger.error('创建目录失败: ' + dirPath, error.message);
      return false;
    }
  },
  
  // 安全地删除文件
  safeUnlinkSync: (filePath) => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        Logger.debug('删除文件: ' + filePath);
      }
      return true;
    } catch (error) {
      Logger.error('删除文件失败: ' + filePath, error.message);
      return false;
    }
  },
  
  // 生成唯一ID
  generateId: (length = 8) => {
    return crypto.randomBytes(length).toString('hex');
  },
  
  // 检查文件是否存在
  fileExists: (filePath) => {
    try {
      return fs.existsSync(filePath);
    } catch (error) {
      Logger.error('检查文件存在性失败: ' + filePath, error.message);
      return false;
    }
  },
  
  // 获取文件统计信息
  getFileStats: (filePath) => {
    try {
      return fs.statSync(filePath);
    } catch (error) {
      Logger.error('获取文件信息失败: ' + filePath, error.message);
      return null;
    }
  }
};

// ---- 公共函数 ----
// 计算文件夹大小和文件数
function calculateFolderSize(dirPath) {
  let totalSize = 0;
  let fileCount = 0;
  
  function walkDir(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            walkDir(fullPath);
          } else {
            const stat = fs.statSync(fullPath);
            totalSize += stat.size;
            fileCount++;
          }
        } catch (e) {
          Logger.warn('访问文件失败: ' + fullPath, e.message);
        }
      }
    } catch (e) {
      Logger.warn('读取目录失败: ' + dir, e.message);
    }
  }
  
  walkDir(dirPath);
  return { totalSize, fileCount };
}

// 创建进度回调函数
function createProgressCallback(mainWindow, fileIndex, totalFiles, fileSize, sentBytes = 0) {
  return (progress) => {
    if (!mainWindow) return;
    
    const currentFileProgress = Utils.calculateProgress(sentBytes + progress, fileSize);
    const totalProgress = Utils.calculateProgress(
      AppState.sending.sentBytes + sentBytes + progress,
      AppState.sending.totalSize
    );
    
    mainWindow.webContents.send('send-progress', {
      fileIndex: fileIndex + 1,
      totalFiles,
      fileSize,
      sentBytes: sentBytes + progress,
      currentFileProgress,
      totalProgress,
      speed: 0, // 可以在这里计算速度
      eta: '计算中...',
    });
  };
}

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
    if (Utils.fileExists(DEST_FILE)) {
      const content = fs.readFileSync(DEST_FILE, 'utf8');
      const destinations = JSON.parse(content);
      
      // 验证目的地数据格式
      if (!Array.isArray(destinations)) {
        Logger.error('目的地文件格式错误：不是数组');
        return [];
      }
      
      // 验证每个目的地
      const validDestinations = destinations.filter(dest => {
        if (!dest || typeof dest !== 'object') {
          Logger.warn('跳过无效目的地条目', dest);
          return false;
        }
        
        // 必须有type字段
        if (!dest.type || !['local', 'ftp', 'sftp', 'webdav'].includes(dest.type)) {
          Logger.warn('跳过无效目的地类型', { type: dest.type });
          return false;
        }
        
        // 必须有name字段
        if (!dest.name || typeof dest.name !== 'string') {
          Logger.warn('跳过无效目的地名称', { name: dest.name });
          return false;
        }
        
        return true;
      });
      
      Logger.info(`加载了 ${validDestinations.length} 个有效目的地`);
      return validDestinations;
    }
  } catch (e) {
    Logger.error('加载目标失败', { error: e.message, stack: e.stack });
  }
  return [];
}

function saveDestinations(dests) {
  try {
    // 验证数据格式
    if (!Array.isArray(dests)) {
      throw new Error('目的地数据必须是数组');
    }
    
    // 确保目录存在
    const dir = path.dirname(DEST_FILE);
    Utils.safeMkdirSync(dir);
    
    fs.writeFileSync(DEST_FILE, JSON.stringify(dests, null, 2), 'utf8');
    Logger.debug('保存目的地成功', { count: dests.length });
  } catch (e) {
    Logger.error('保存目标失败', { error: e.message });
    throw e;
  }
}

// ---- 解析 URL ----
function parseUrl(url) {
  if (!url || typeof url !== 'string') {
    Logger.warn('URL为空或无效', { url });
    return null;
  }
  
  url = url.trim();
  
  // 本地 IP 格式: 192.168.1.100:8101
  const localIpPattern = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/;
  const localMatch = url.match(localIpPattern);
  if (localMatch) {
    const host = localMatch[1];
    const port = parseInt(localMatch[2]);
    
    // 验证IP和端口
    if (!Security.validateIP(host)) {
      Logger.warn('无效的IP地址', { host });
      return null;
    }
    if (!Security.validatePort(port)) {
      Logger.warn('无效的端口号', { port });
      return null;
    }
    
    return { type: 'local', host, port };
  }
  
  // URL格式
  try {
    const u = new URL(url);
    const type = u.protocol.replace(':', '').toLowerCase();
    
    // 验证协议
    const allowedProtocols = ['ftp', 'sftp', 'http', 'https', 'webdav', 'ftps', 'local'];
    if (!allowedProtocols.includes(type)) {
      Logger.warn('不支持的协议', { type, url });
      return null;
    }
    
    // 将协议映射到类型
    let destType = type;
    if (type === 'http' || type === 'https') {
      destType = 'webdav';
    } else if (type === 'ftps') {
      destType = 'ftp';
    } else if (type === 'local') {
      destType = 'local';
    }
    
    // 验证主机名
    if (!u.hostname) {
      Logger.warn('URL缺少主机名', { url });
      return null;
    }
    
    // 解析端口
    let port;
    if (u.port) {
      port = parseInt(u.port);
      if (!Security.validatePort(port)) {
        Logger.warn('无效的端口号', { port, url });
        return null;
      }
    } else {
      // 默认端口
      switch (type) {
        case 'sftp': port = 22; break;
        case 'ftp':
        case 'ftps': port = 21; break;
        case 'https': port = 443; break;
        case 'http': port = 80; break;
        case 'webdav': port = 80; break;
        case 'local': port = 34567; break;
        default: port = 80;
      }
    }
    
    // 安全地解码用户名和密码
    let user = '', pass = '';
    try {
      user = u.username ? decodeURIComponent(u.username) : '';
    } catch (e) {
      Logger.warn('用户名解码失败', { username: u.username });
      user = u.username || '';
    }
    
    try {
      pass = u.password ? decodeURIComponent(u.password) : '';
    } catch (e) {
      Logger.warn('密码解码失败', { password: '***' });
      pass = u.password || '';
    }
    
    // 清理路径
    let pathname = u.pathname || '/';
    try {
      pathname = Security.sanitizePath(pathname);
      if (!pathname.startsWith('/')) {
        pathname = '/' + pathname;
      }
    } catch (e) {
      Logger.warn('路径清理失败，使用默认路径', { original: u.pathname });
      pathname = '/';
    }
    
    const result = {
      type: destType,
      host: u.hostname,
      port,
      user,
      pass,
      path: pathname,
      protocol: type,
      raw: url
    };
    
    // 设置 TLS/SSL 配置
    if (type === 'ftps') {
      result.tls = 'explicit'; // FTPS 默认使用 Explicit TLS
    } else if (type === 'https') {
      result.tls = 'explicit'; // HTTPS 用于 WebDAV
    }
    
    Logger.debug('URL解析成功', { type: result.type, host: result.host, port: result.port });
    return result;
    
  } catch (e) {
    Logger.warn('URL解析失败', { url, error: e.message });
    return null;
  }
}

// ---- 创建主窗口 ----
function createWindow() {
  Logger.info('创建主窗口');
  
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
  
  // 更新状态管理
  AppState.windows.mainWindow = mainWindow;
  
  mainWindow.loadFile('index.html');
  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    Logger.info('主窗口已显示');
  });
  
  mainWindow.on('closed', () => {
    Logger.info('主窗口已关闭');
    mainWindow = null;
    AppState.windows.mainWindow = null;
  });
  
  // 添加错误处理
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    Logger.error('窗口加载失败', { errorCode, errorDescription });
  });
  
  // 开发工具（仅开发环境）
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

// ---- 创建目标管理窗口 ----
function createDestWindow() {
  Logger.info('创建目标管理窗口');
  
  if (destWindow) {
    Logger.debug('目标管理窗口已存在，聚焦');
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
  
  // 更新状态管理
  AppState.windows.destWindow = destWindow;
  
  destWindow.loadFile('destinations.html')
    .then(() => {
      Logger.debug('目标管理窗口加载完成');
    })
    .catch(err => {
      Logger.error('目标管理窗口加载失败', { error: err.message });
    });
  
  destWindow.webContents.on('did-finish-load', () => {
    Logger.debug('目标管理窗口渲染完成');
  });
  
  destWindow.webContents.on('console-message', (e, level, msg, line) => {
    Logger.debug(`[目标管理控制台] ${msg}`);
  });
  
  destWindow.on('closed', () => {
    Logger.info('目标管理窗口已关闭');
    destWindow = null;
    AppState.windows.destWindow = null;
  });
  
  // 添加错误处理
  destWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    Logger.error('目标管理窗口加载失败', { errorCode, errorDescription });
  });
}

// ---- UDP 设备发现 ----
let currentBroadcastPort = BROADCAST_PORT;  // 当前UDP广播端口
let discoveryServer = null;  // TCP发现服务
const DISCOVERY_PORT = 34570;  // TCP发现服务端口
let currentDiscoveryPort = DISCOVERY_PORT;  // 当前TCP发现服务端口

// TCP设备发现服务
function startTcpDiscovery() {
  discoveryServer = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      try {
        const request = JSON.parse(data);
        if (request.type === 'discover') {
          // 返回本机信息
          const response = JSON.stringify({
            type: 'response',
            deviceId,
            deviceName,
            ip: getLocalIP(),
            port: currentPort,
            timestamp: Date.now()
          });
          socket.write(response);
          socket.end();
        }
      } catch (e) {
        socket.end();
      }
    });
    
    socket.on('error', () => {});
    socket.setTimeout(3000, () => socket.end());
  });
  
  discoveryServer.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      Logger.warn('TCP发现服务端口被占用，正在查找可用端口...', { port: currentDiscoveryPort });
      const newPort = await findAvailablePort(currentDiscoveryPort + 1);
      if (newPort) {
        Logger.info('找到可用TCP发现端口', { newPort });
        currentDiscoveryPort = newPort;
        discoveryServer.close(() => {
          startTcpDiscovery();
        });
      } else {
        Logger.error('无法找到可用TCP发现端口');
      }
    } else {
      Logger.error('TCP发现服务错误', { error: err.message });
    }
  });
  
  discoveryServer.listen(currentDiscoveryPort, '0.0.0.0', () => {
    Logger.info('TCP发现服务已启动', { port: currentDiscoveryPort });
  });
}

// 扫描局域网设备
async function scanLanDevices() {
  const localIP = getLocalIP();
  const ipParts = localIP.split('.');
  const subnet = ipParts.slice(0, 3).join('.');
  
  Logger.info('开始扫描局域网', { subnet });
  
  const devices = [];
  const promises = [];
  
  // 扫描常见端口
  for (let i = 1; i <= 254; i++) {
    const ip = `${subnet}.${i}`;
    if (ip === localIP) continue;
    
    promises.push(scanDevice(ip));
  }
  
  const results = await Promise.allSettled(promises);
  
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      devices.push(result.value);
    }
  }
  
  Logger.info('扫描完成', { found: devices.length });
  return devices;
}

// 扫描单个设备
function scanDevice(ip) {
  return new Promise((resolve) => {
    // 尝试扫描多个可能的发现端口
    const portsToTry = [DISCOVERY_PORT, DISCOVERY_PORT + 1, DISCOVERY_PORT + 2];
    let portIndex = 0;
    
    const tryNextPort = () => {
      if (portIndex >= portsToTry.length) {
        resolve(null);
        return;
      }
      
      const port = portsToTry[portIndex];
      portIndex++;
      
      const socket = new net.Socket();
      let timeout;
      
      socket.on('connect', () => {
        // 发送发现请求
        const request = JSON.stringify({ type: 'discover', deviceId, deviceName });
        socket.write(request);
        
        timeout = setTimeout(() => {
          socket.destroy();
          tryNextPort();
        }, 1000);
      });
      
      socket.on('data', (data) => {
        try {
          const response = JSON.parse(data.toString());
          if (response.type === 'response') {
            clearTimeout(timeout);
            socket.destroy();
            resolve({
              id: response.deviceId,
              name: response.deviceName,
              ip: response.ip,
              port: response.port
            });
          }
        } catch (e) {
          tryNextPort();
        }
      });
      
      socket.on('error', () => {
        clearTimeout(timeout);
        tryNextPort();
      });
      
      socket.connect(port, ip);
    };
    
    tryNextPort();
  });
}

function startDiscovery() {
  Logger.info('启动设备发现服务');
  
  // 启动TCP发现服务
  startTcpDiscovery();
  
  try {
    udpSocket = dgram.createSocket('udp4');
    
    udpSocket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        
        // 验证消息格式
        if (!data || typeof data !== 'object') {
          Logger.debug('收到无效的UDP消息', { address: rinfo.address });
          return;
        }
        
        if (data.type === 'discover' && data.deviceId !== deviceId) {
          // 发现请求，回复我们的信息
          const localIP = getLocalIP();
          const reply = JSON.stringify({ 
            type: 'response', 
            deviceId, 
            deviceName, 
            ip: localIP,
            port: currentPort,  // 添加TCP端口
            broadcastPort: currentBroadcastPort,  // 添加UDP广播端口
            timestamp: Date.now()
          });
          
          udpSocket.send(reply, rinfo.port, rinfo.address, (err) => {
            if (err) {
              Logger.warn('发送UDP回复失败', { error: err.message });
            }
          });
          
          Logger.debug('回复设备发现请求', { from: rinfo.address, ip: localIP, port: currentPort });
          
        } else if (data.type === 'response') {
          // 收到设备响应
          const deviceInfo = {
            name: data.deviceName || '未知设备',
            ip: data.ip,
            port: data.port || 34567,  // 保存TCP端口，默认34567
            lastSeen: Date.now(),
            timestamp: data.timestamp
          };
          
          discoveredDevices.set(data.deviceId, deviceInfo);
          AppState.devices.discovered.set(data.deviceId, deviceInfo);
          
          Logger.debug('发现设备', { id: data.deviceId, name: deviceInfo.name, ip: deviceInfo.ip, port: deviceInfo.port });
          
          // 更新主窗口的设备列表
          if (mainWindow) {
            const devices = [
              { id: 'manual', name: '手动输入 IP...', ip: '', url: '' },
              ...Array.from(discoveredDevices.entries()).map(([id, info]) => ({
                id, 
                name: `${info.name} (${info.ip}:${info.port})`, 
                ip: info.ip,
                port: info.port,
                url: info.ip,
              })),
            ];
            
            mainWindow.webContents.send('devices-updated', devices);
          }
        }
      } catch (e) {
        Logger.debug('处理UDP消息失败', { error: e.message, address: rinfo.address });
      }
    });
    
    udpSocket.on('error', async (err) => {
      if (err.code === 'EADDRINUSE') {
        Logger.warn('UDP端口被占用，正在查找可用端口...', { port: currentBroadcastPort });
        const newPort = await findAvailablePort(currentBroadcastPort + 1);
        if (newPort) {
          Logger.info('找到可用UDP端口', { newPort });
          currentBroadcastPort = newPort;
          udpSocket.close(() => {
            udpSocket = dgram.createSocket('udp4');
            // 重新绑定到新端口
            udpSocket.bind(currentBroadcastPort, () => {
              Logger.info('UDP设备发现服务已重启', { port: currentBroadcastPort });
            });
          });
        } else {
          Logger.error('无法找到可用UDP端口');
        }
      } else {
        Logger.error('UDP套接字错误', { error: err.message });
      }
    });
    
    udpSocket.on('close', () => {
      Logger.info('UDP套接字已关闭');
    });
    
    udpSocket.bind(currentBroadcastPort, () => {
      Logger.info('UDP设备发现服务已启动', { port: currentBroadcastPort });
      
      // 定期发送发现广播
      setInterval(() => {
        try {
          const msg = JSON.stringify({ 
            type: 'discover', 
            deviceId, 
            deviceName,
            timestamp: Date.now()
          });
          
          udpSocket.send(msg, currentBroadcastPort, '255.255.255.255', (err) => {
            if (err) {
              Logger.warn('发送UDP广播失败', { error: err.message });
            }
          });
        } catch (err) {
          Logger.warn('UDP广播失败', { error: err.message });
        }
      }, BROADCAST_INTERVAL);
      
      // 发送初始发现广播
      const initMsg = JSON.stringify({ 
        type: 'discover', 
        deviceId, 
        deviceName,
        timestamp: Date.now()
      });
      
      udpSocket.send(initMsg, currentBroadcastPort, '255.255.255.255', (err) => {
        if (err) {
          Logger.warn('发送初始UDP广播失败', { error: err.message });
        }
      });
    });
    
  } catch (err) {
    Logger.error('启动UDP设备发现失败', { error: err.message });
  }
}

// ---- TCP 接收服务器 ----
// 检查端口是否可用
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.close(() => resolve(true));
      })
      .listen(port, '0.0.0.0');
  });
}

// 查找可用端口
async function findAvailablePort(startPort) {
  for (let port = startPort; port <= 65535; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  return null;
}

function startServer() {
  Logger.info('启动TCP接收服务器');
  
  const saveDir = CONFIG.saveDir;
  
  // 确保保存目录存在
  Utils.safeMkdirSync(saveDir);
  
  server = net.createServer((socket) => {
    const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    Logger.info('新的TCP连接', { client: clientAddress });
    
    // 更新接收状态
    AppState.receiving.isReceiving = true;
    AppState.receiving.startTime = Date.now();
    
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
              Logger.warn('不支持的协议版本', { proto, client: clientAddress });
              socket.end();
              return;
            }
            fileCount = handshakeBuffer.readUInt32BE(2);
            Logger.debug('开始接收文件', { fileCount, client: clientAddress });
            
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
              
              // 验证文件名和大小
              if (!Security.validateFileName(name)) {
                Logger.warn('无效的文件名', { name, client: clientAddress });
                socket.end();
                return;
              }
              if (!Security.validateFileSize(size)) {
                Logger.warn('文件大小超限', { name, size, client: clientAddress });
                socket.end();
                return;
              }
              
              files.push({ name, size });
            }
            
            if (parsed) {
              // 更新接收状态
              AppState.receiving.totalFiles = fileCount;
              AppState.receiving.totalSize = files.reduce((sum, f) => sum + f.size, 0);
              
              // 发送断点续传响应：每个文件的已接收大小
              const resumeInfo = Buffer.alloc(8 * fileCount);
              for (let i = 0; i < fileCount; i++) {
                const f = files[i];
                const filePath = path.join(saveDir, f.name);
                let existingSize = 0;
                try {
                  if (Utils.fileExists(filePath)) {
                    const stat = Utils.getFileStats(filePath);
                    if (stat) {
                      existingSize = stat.size;
                      // 如果大小不匹配，从头开始
                      if (existingSize > f.size) existingSize = 0;
                    }
                  }
                } catch(e) {
                  Logger.warn('检查文件失败', { filePath, error: e.message });
                }
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
        Logger.error('处理TCP数据错误', { error: err.message, client: clientAddress });
        if (mainWindow) mainWindow.webContents.send('receive-error', { message: err.message });
        socket.end();
      }
    });
    
    function processNextFile() {
      if (currentFileIndex >= fileCount) {
        state = 'done';
        
        // 更新接收状态
        AppState.receiving.isReceiving = false;
        AppState.receiving.currentFileIndex = currentFileIndex;
        
        Logger.info('文件接收完成', { totalFiles: fileCount, client: clientAddress });
        
        if (mainWindow) mainWindow.webContents.send('receive-complete', { totalFiles: fileCount });
        socket.end();
        return;
      }
      
      const f = files[currentFileIndex];
      fileName = f.name;
      fileSize = f.size;
      receivedBytes = 0;
      
      // 更新接收状态
      AppState.receiving.currentFileIndex = currentFileIndex;
      
      const filePath = path.join(saveDir, fileName);
      
      // 安全地创建目录
      try {
        const dir = path.dirname(filePath);
        Utils.safeMkdirSync(dir);
      } catch (e) {
        Logger.error('创建目录失败', { dir: path.dirname(filePath), error: e.message });
        socket.end();
        return;
      }
      
      // 空目录占位
      if (fileName.endsWith('/.keep')) {
        try {
          const dirPath = filePath.replace(/\.keep$/, '');
          Utils.safeMkdirSync(dirPath);
          Logger.debug('创建空目录', { dir: dirPath });
        } catch (e) {
          Logger.warn('创建空目录失败', { filePath, error: e.message });
        }
        currentFileIndex++;
        processNextFile();
        return;
      }
      
      // 检查是否续传
      let existingSize = 0;
      try {
        if (Utils.fileExists(filePath)) {
          const stat = Utils.getFileStats(filePath);
          if (stat) {
            existingSize = stat.size;
            if (existingSize > fileSize) existingSize = 0;
          }
        }
      } catch(e) {
        Logger.warn('检查文件失败', { filePath, error: e.message });
      }
      
      // 打开文件（续传用追加模式，新文件用写入模式）
      try {
        if (existingSize > 0) {
          fileWriteStream = fs.createWriteStream(filePath, { flags: 'a' });
          receivedBytes = existingSize;
          Logger.debug('续传文件', { file: fileName, existingSize, totalSize: fileSize });
        } else {
          fileWriteStream = fs.createWriteStream(filePath);
          Logger.debug('开始接收新文件', { file: fileName, size: fileSize });
        }
      } catch (e) {
        Logger.error('创建文件流失败', { filePath, error: e.message });
        socket.end();
        return;
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
        
        // 更新接收状态
        AppState.receiving.receivedBytes += chunk.length;
        
        if (fileWriteStream) {
          try {
            fileWriteStream.write(chunk);
          } catch (e) {
            Logger.error('写入文件失败', { filePath: path.join(saveDir, f.name), error: e.message });
            fileWriteStream.destroy();
            fileWriteStream = null;
            socket.end();
            return;
          }
        }
        
        if (mainWindow) {
          mainWindow.webContents.send('receive-progress', {
            fileName: f.name,
            receivedBytes,
            totalBytes: f.size,
            progress: f.size > 0 ? Math.round((receivedBytes / f.size) * 100) : 100,
            currentFile: currentFileIndex + 1,
            totalFiles: fileCount,
          });
        }
      }
      
      if (receivedBytes >= f.size) {
        if (fileWriteStream) { 
          fileWriteStream.end(); 
          fileWriteStream = null; 
        }
        Logger.debug('文件接收完成', { file: f.name, size: f.size });
        currentFileIndex++;
        processNextFile();
      }
    }
    
    socket.on('error', (err) => {
      Logger.error('TCP连接错误', { error: err.message, client: clientAddress });
      if (fileWriteStream) { 
        fileWriteStream.destroy(); 
        fileWriteStream = null; 
      }
      if (mainWindow) mainWindow.webContents.send('receive-error', { message: err.message });
    });
    
    socket.on('close', () => {
      Logger.info('TCP连接关闭', { client: clientAddress });
      if (fileWriteStream) { 
        fileWriteStream.destroy(); 
        fileWriteStream = null; 
      }
    });
  });
  
  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      Logger.warn('端口被占用，正在查找可用端口...', { port: currentPort });
      const newPort = await findAvailablePort(currentPort + 1);
      if (newPort) {
        Logger.info('找到可用端口', { newPort });
        currentPort = newPort;
        server.close(() => {
          startServer();
          // 广播端口变化
          if (mainWindow) {
            mainWindow.webContents.send('port-changed', { port: currentPort });
          }
        });
      } else {
        Logger.error('无法找到可用端口');
      }
    } else {
      Logger.error('TCP服务器错误', { error: err.message });
    }
  });
  
  server.listen(currentPort, '0.0.0.0', () => {
    Logger.info('接收服务器已启动', { port: currentPort });
    console.log(`接收服务器监听端口 ${currentPort}`);
  });
}

// 启动Finder扩展IPC服务器
function startIPCServer() {
  Logger.info('启动Finder扩展IPC服务器');
  
  const ipcPort = 34569; // Finder扩展使用的端口
  
  // 先检查端口是否被占用
  isPortAvailable(ipcPort).then((available) => {
    if (!available) {
      Logger.error('IPC端口被占用，无法启动IPC服务器', { port: ipcPort });
      console.error('[IPC] 端口34569被占用，请关闭占用该端口的进程');
      return;
    }

    ipcServer = net.createServer((socket) => {
      const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
      Logger.info('Finder扩展连接', { client: clientAddress });
      try {
        console.log('[IPC] 新连接:', clientAddress);
      } catch (e) {
        if (e.code !== 'EPIPE') {
          process.stderr.write(`[IPC] 新连接: ${clientAddress}\n`);
        }
      }
      
      let dataBuffer = Buffer.alloc(0);
      
      socket.on('data', (chunk) => {
        try {
          console.log('[IPC] 收到数据块:', chunk.length, '字节');
          console.log('[IPC] 数据内容:', chunk.toString('utf8'));
          console.log('[IPC] 数据内容长度:', chunk.toString('utf8').length);
        } catch (e) {
          if (e.code !== 'EPIPE') {
            process.stderr.write(`[IPC] 收到数据块: ${chunk.length} 字节\\n`);
          }
        }
        try {
          dataBuffer = Buffer.concat([dataBuffer, chunk]);
          Logger.info('收到数据', { length: chunk.length, totalLength: dataBuffer.length });
          try {
            console.log('[IPC] 缓冲区总长度:', dataBuffer.length);
          } catch (e) {
            if (e.code !== 'EPIPE') {
              process.stderr.write(`[IPC] 缓冲区总长度: ${dataBuffer.length}\\n`);
            }
          }
          
          // 尝试解析JSON数据
          const dataStr = dataBuffer.toString('utf8');
          Logger.info('收到数据内容', { content: dataStr });
          try {
            console.log('[IPC] 数据内容:', dataStr);
          } catch (e) {
            if (e.code !== 'EPIPE') {
              process.stderr.write(`[IPC] 数据内容: ${dataStr}\n`);
            }
          }
          
          try {
            const message = JSON.parse(dataStr);
            Logger.info('收到Finder扩展消息', { message });
            try {
              console.log('[IPC] 解析成功:', JSON.stringify(message));
            } catch (e) {
              if (e.code !== 'EPIPE') {
                process.stderr.write(`[IPC] 解析成功: ${JSON.stringify(message)}\n`);
              }
            }
            
            // 处理addFiles动作
            if (message.action === 'addFiles' && Array.isArray(message.files)) {
              Logger.info('从Finder扩展收到文件', { count: message.files.length, files: message.files });
              
              // 验证文件路径
              const validFiles = [];
              for (const filePath of message.files) {
                if (typeof filePath === 'string' && fs.existsSync(filePath)) {
                  const stat = fs.statSync(filePath);
                  if (stat.isFile() || stat.isDirectory()) {
                    validFiles.push({
                      path: filePath,
                      name: path.basename(filePath),
                      size: stat.isFile() ? stat.size : 0,
                      isFolder: stat.isDirectory()
                    });
                  }
                }
              }
              
              if (validFiles.length > 0) {
                // 如果主窗口不存在，创建它
                if (!mainWindow) {
                  Logger.info('主窗口不存在，重新创建');
                  createWindow();

                  const sendFiles = () => {
                    if (mainWindow) {
                      mainWindow.show();
                      mainWindow.focus();
                      mainWindow.setAlwaysOnTop(true);
                      setTimeout(() => mainWindow.setAlwaysOnTop(false), 500);
                      mainWindow.webContents.send('add-files-from-context', validFiles);
                      Logger.info('已将文件发送到渲染进程（新窗口）', { count: validFiles.length });
                    }
                  };

                  if (mainWindow.webContents.isLoading()) {
                    mainWindow.webContents.once('did-finish-load', sendFiles);
                  } else {
                    // 页面已加载完成（极少见），直接发送
                    sendFiles();
                  }
                } else {
                  // 窗口已存在，直接发送
                  mainWindow.show();
                  mainWindow.focus();
                  mainWindow.setAlwaysOnTop(true);
                  setTimeout(() => mainWindow.setAlwaysOnTop(false), 500);
                  mainWindow.webContents.send('add-files-from-context', validFiles);
                  Logger.info('已将文件发送到渲染进程', { count: validFiles.length });
                }
              }
            }
            
            // 清空缓冲区
            dataBuffer = Buffer.alloc(0);
          } catch (e) {
            // JSON解析失败，可能数据不完整，继续等待
            Logger.debug('等待更多数据...', { bufferLength: dataBuffer.length });
          }
        } catch (e) {
          Logger.error('处理Finder扩展数据失败', { error: e.message });
        }
      });
      
      socket.on('error', (err) => {
        Logger.warn('Finder扩展socket错误', { error: err.message });
      });
      
      socket.on('close', () => {
        Logger.debug('Finder扩展连接关闭', { client: clientAddress });
      });
    });
    
    ipcServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        Logger.error('IPC端口被占用，无法启动', { port: ipcPort, error: err.message });
        console.error('[IPC] 端口34569被占用，请关闭占用该端口的进程');
      } else {
        Logger.error('IPC服务器错误', { error: err.message });
      }
    });
    
    // 绑定到所有网络接口，确保Quick Action可以连接
    ipcServer.listen(ipcPort, '0.0.0.0', () => {
      Logger.info('Finder扩展IPC服务器已启动', { port: ipcPort });
      try {
        console.log('[IPC] 服务器监听在端口', ipcPort);
      } catch (e) {
        if (e.code !== 'EPIPE') {
          process.stderr.write(`[IPC] 服务器监听在端口 ${ipcPort}\n`);
        }
      }
    });
  });
}

// 重启服务器（更改端口后调用）
function restartServer(newPort) {
  if (server) {
    server.close(() => {
      Logger.info('TCP服务器已关闭', { port: currentPort });
      currentPort = newPort;
      startServer();
      // 广播端口变化
      if (mainWindow) {
        mainWindow.webContents.send('port-changed', { port: currentPort });
      }
    });
  } else {
    currentPort = newPort;
    startServer();
  }
}

// ---- 远程传输函数 ----

// 辅助函数：将回调转换为Promise
function ftpConnect(client) {
  return new Promise((resolve, reject) => {
    Logger.debug('FTP连接开始');
    client.connect((err) => {
      if (err) {
        Logger.error('FTP连接失败', { error: err.message, code: err.code });
        reject(err);
      } else {
        Logger.debug('FTP连接成功');
        resolve();
      }
    });
  });
}

function ftpPut(client, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    Logger.debug('FTP put开始', { local: localPath, remote: remotePath });
    client.ftp.put(localPath, remotePath, (err) => {
      if (err) {
        Logger.error('FTP put失败', { local: localPath, remote: remotePath, error: err.message, code: err.code });
        reject(err);
      } else {
        Logger.debug('FTP put成功', { local: localPath, remote: remotePath });
        resolve();
      }
    });
  });
}

function ftpMkdir(client, path) {
  return new Promise((resolve, reject) => {
    Logger.debug('FTP mkdir开始', { path });
    client.ftp.mkdir(path, true, (err) => {  // true表示递归创建
      if (err) {
        Logger.error('FTP mkdir失败', { path, error: err.message, code: err.code });
        reject(err);
      } else {
        Logger.debug('FTP mkdir成功', { path });
        resolve();
      }
    });
  });
}

// FTP 上传
async function uploadFtp(filePaths, destInfo) {
  Logger.info('开始FTP上传', { host: destInfo.host, port: destInfo.port, fileCount: filePaths.length });
  
  // 验证目标信息
  if (!Security.validateIP(destInfo.host)) {
    throw new Error('无效的FTP服务器地址');
  }
  if (!Security.validatePort(destInfo.port)) {
    throw new Error('无效的FTP服务器端口');
  }
  
  if (mainWindow) mainWindow.webContents.send('send-status', { icon: '🔗', text: '正在连接...', detail: `${destInfo.host}:${destInfo.port}`, status: 'connecting' });
  
  // 构建FTP客户端配置
  const ftpConfig = {
    host: destInfo.host,
    port: destInfo.port,
    user: destInfo.user,
    password: destInfo.pass
  };
  
  // 处理匿名登录
  if (destInfo.anonymous) {
    ftpConfig.user = 'anonymous';
    ftpConfig.password = 'anonymous@';
    Logger.debug('使用匿名登录', { host: destInfo.host });
  }
  
  // 处理连接模式 (主动/被动)
  if (destInfo.ftpMode === 'active') {
    ftpConfig.passive = false;
    Logger.debug('使用主动模式', { host: destInfo.host });
  } else {
    // 默认被动模式
    ftpConfig.passive = true;
    Logger.debug('使用被动模式', { host: destInfo.host });
  }
  
  // 处理TLS/SSL配置
  if (destInfo.tls && destInfo.tls !== 'none') {
    ftpConfig.secure = destInfo.tls === 'explicit' ? 'explicit' : 'implicit';
    Logger.debug('启用TLS/SSL', { host: destInfo.host, secure: ftpConfig.secure });
  }
  
  const client = new FTPClient(ftpConfig, { logging: 'debug' });
  
  try {
    await ftpConnect(client);
    Logger.info('FTP连接成功', { host: destInfo.host });
  } catch (err) {
    Logger.error('FTP连接失败', { host: destInfo.host, error: err.message });
    throw new Error(`FTP连接失败: ${err.message}`);
  }
  
  if (mainWindow) mainWindow.webContents.send('send-status', { icon: '✅', text: '连接验证成功', detail: `已连接到 ${destInfo.host}`, status: 'connected' });
  let remoteDir = destInfo.path || '/';
  // 确保远程目录以斜杠开头
  if (!remoteDir.startsWith('/')) {
    remoteDir = '/' + remoteDir;
  }
  Logger.debug('远程目录', { remoteDir });
  
  // 更新发送状态
  AppState.sending.isSending = true;
  AppState.sending.startTime = Date.now();
  AppState.sending.totalFiles = filePaths.length;
  AppState.sending.totalSize = filePaths.reduce((sum, f) => sum + f.size, 0);
  AppState.sending.sentBytes = 0;
  
  for (let i = 0; i < filePaths.length; i++) {
    // 检查是否取消
    if (sendCancelled || AppState.sending.cancelled) {
      Logger.info('FTP上传被用户取消');
      client.ftp.end();
      throw new Error('用户取消发送');
    }
    
    const fp = filePaths[i];
    
    // 验证文件名
    if (!Security.validateFileName(fp.name)) {
      Logger.warn('跳过无效文件名', { name: fp.name });
      continue;
    }
    
    const remotePath = path.posix.join(remoteDir, fp.name);
    const remoteDirForFile = path.posix.dirname(remotePath);
    
    // 确保目标目录存在
    if (remoteDirForFile !== '/') {
      try {
        // 先尝试切换到目录，如果失败则创建
        await new Promise((resolve, reject) => {
          client.ftp.cwd(remoteDirForFile, (err) => {
            if (err) {
              Logger.debug('FTP cwd失败，尝试创建目录', { dir: remoteDirForFile, error: err.message });
              // 目录不存在，尝试创建
              client.ftp.mkdir(remoteDirForFile, true, (err2) => {
                if (err2) {
                  Logger.error('FTP mkdir失败', { dir: remoteDirForFile, error: err2.message });
                  reject(err2);
                } else {
                  Logger.debug('FTP mkdir成功', { dir: remoteDirForFile });
                  // 创建成功后再次尝试切换
                  client.ftp.cwd(remoteDirForFile, (err3) => {
                    if (err3) {
                      Logger.error('FTP cwd再次失败', { dir: remoteDirForFile, error: err3.message });
                      reject(err3);
                    } else {
                      Logger.debug('FTP cwd成功', { dir: remoteDirForFile });
                      resolve();
                    }
                  });
                }
              });
            } else {
              Logger.debug('FTP cwd成功', { dir: remoteDirForFile });
              resolve();
            }
          });
        });
      } catch(e) {
        Logger.error('FTP目录准备失败', { dir: remoteDirForFile, error: e.message });
        throw new Error(`无法切换到远程目录: ${e.message}`);
      }
    }
    
    // 空目录占位：只创建目录不上传文件
    if (fp.isEmptyDir) {
      Logger.debug('跳过空目录', { dir: fp.name });
      if (mainWindow) {
        mainWindow.webContents.send('send-file-start', { fileName: fp.name, currentFile: i + 1, totalFiles: filePaths.length });
        mainWindow.webContents.send('send-progress', { 
          fileName: fp.name, 
          fileProgress: 100, 
          totalProgress: Utils.calculateProgress(i + 1, filePaths.length), 
          sentBytes: filePaths.slice(0, i + 1).reduce((s, f) => s + f.size, 0), 
          totalBytes: filePaths.reduce((s, f) => s + f.size, 0), 
          currentFile: i + 1, 
          totalFiles: filePaths.length 
        });
      }
      continue;
    }
    
    if (mainWindow) {
      mainWindow.webContents.send('send-file-start', { fileName: fp.name, currentFile: i + 1, totalFiles: filePaths.length });
    }
    
    // 空文件处理 - 现在支持0字节文件上传
    if (fp.size === 0) {
      Logger.debug('上传空文件', { file: fp.name });
    }
    
    Logger.debug('开始上传文件', { file: fp.name, size: fp.size, remote: remotePath });
    
    try {
      await ftpPut(client, fp.path, remotePath);
      
      Logger.debug('文件上传完成', { file: fp.name });
      
      if (mainWindow) {
        mainWindow.webContents.send('send-progress', {
          fileName: fp.name, 
          fileProgress: 100, 
          totalProgress: Utils.calculateProgress(i + 1, filePaths.length),
          sentBytes: filePaths.slice(0, i + 1).reduce((s, f) => s + f.size, 0),
          totalBytes: filePaths.reduce((s, f) => s + f.size, 0),
          currentFile: i + 1, 
          totalFiles: filePaths.length,
        });
      }
    } catch (err) {
      Logger.error('FTP上传失败', { file: fp.name, error: err.message });
      throw new Error(`FTP上传失败: ${err.message}`);
    }
  }
  
  client.ftp.end();
  Logger.info('FTP上传完成', { host: destInfo.host });
}

// SFTP 上传
async function uploadSftp(filePaths, destInfo) {
  Logger.info('开始SFTP上传', { host: destInfo.host, port: destInfo.port, fileCount: filePaths.length });

  // 验证目标信息
  if (!Security.validateIP(destInfo.host)) {
    throw new Error('无效的SFTP服务器地址');
  }
  if (!Security.validatePort(destInfo.port)) {
    throw new Error('无效的SFTP服务器端口');
  }

  if (mainWindow) mainWindow.webContents.send('send-status', { icon: '🔗', text: '正在连接...', detail: `${destInfo.host}:${destInfo.port}`, status: 'connecting' });

  // ---- 优化参数 ----
  const HIGH_WATER_MARK = 1024 * 1024;            // 1MB 流缓冲区（从默认64KB提升）
  const KEEPALIVE_INTERVAL = 10000;                // 10秒心跳

  return new Promise((resolve, reject) => {
    const conn = new SSHClient();

    conn.on('ready', () => {
      Logger.info('SFTP连接成功', { host: destInfo.host });
      if (mainWindow) mainWindow.webContents.send('send-status', { icon: '✅', text: '连接验证成功', detail: `已连接到 ${destInfo.host}`, status: 'connected' });

      conn.sftp(async (err, sftp) => {
        if (err) {
          Logger.error('SFTP通道创建失败', { error: err.message });
          if (mainWindow) mainWindow.webContents.send('send-status', { icon: '❌', text: 'SFTP 通道失败', detail: err.message, status: 'error' });
          conn.end();
          reject(err);
          return;
        }

        // 更新发送状态
        AppState.sending.isSending = true;
        AppState.sending.startTime = Date.now();
        AppState.sending.totalFiles = filePaths.length;
        AppState.sending.totalSize = filePaths.reduce((sum, f) => sum + f.size, 0);
        AppState.sending.sentBytes = 0;

        // 辅助函数：递归创建远程目录（先收集所有唯一路径，一次性创建）
        const ensureRemoteDirs = async (allDirs) => {
          // 扁平化所有目录路径组件
          const partsSet = new Set();
          for (const dir of allDirs) {
            const parts = dir.split('/').filter(p => p);
            let current = '';
            for (const part of parts) {
              current += '/' + part;
              partsSet.add(current);
            }
          }
          const sorted = [...partsSet].sort();
          for (const dir of sorted) {
            if (sendCancelled || AppState.sending.cancelled) break;
            try {
              await new Promise((r) => sftp.mkdir(dir, () => r()));
            } catch(e) {
              // 忽略目录已存在等错误
            }
          }
        };

        // 上传单个文件
        const uploadFile = async (fp, index) => {
          if (sendCancelled || AppState.sending.cancelled) return;

          const remotePath = path.posix.join(destInfo.path || '/', fp.name);

          // 空目录占位
          if (fp.isEmptyDir) {
            if (mainWindow) {
              mainWindow.webContents.send('send-file-start', { fileName: fp.name, currentFile: index + 1, totalFiles: filePaths.length });
              mainWindow.webContents.send('send-progress', {
                fileName: fp.name,
                fileProgress: 100,
                totalProgress: Utils.calculateProgress(AppState.sending.sentBytes, AppState.sending.totalSize),
                sentBytes: AppState.sending.sentBytes,
                totalBytes: AppState.sending.totalSize,
                currentFile: index + 1,
                totalFiles: filePaths.length
              });
            }
            return;
          }

          if (mainWindow) {
            mainWindow.webContents.send('send-file-start', { fileName: fp.name, currentFile: index + 1, totalFiles: filePaths.length });
          }

          Logger.debug('开始上传文件', { file: fp.name, size: fp.size, remote: remotePath });

          await new Promise((res, rej) => {
            const readStream = fs.createReadStream(fp.path, { highWaterMark: HIGH_WATER_MARK });
            const writeStream = sftp.createWriteStream(remotePath, {
              highWaterMark: HIGH_WATER_MARK
            });
            let sent = 0;

            readStream.on('data', (chunk) => {
              if (sendCancelled || AppState.sending.cancelled) {
                readStream.destroy();
                writeStream.destroy();
                rej(new Error('用户取消发送'));
                return;
              }
              sent += chunk.length;
              AppState.sending.sentBytes += chunk.length;

              const progress = fp.size > 0 ? Math.round((sent / fp.size) * 100) : 100;
              if (mainWindow) {
                mainWindow.webContents.send('send-progress', {
                  fileName: fp.name,
                  fileProgress: progress,
                  totalProgress: Utils.calculateProgress(AppState.sending.sentBytes, AppState.sending.totalSize),
                  sentBytes: AppState.sending.sentBytes,
                  totalBytes: AppState.sending.totalSize,
                  currentFile: index + 1,
                  totalFiles: filePaths.length,
                });
              }
            });

            writeStream.on('close', () => {
              Logger.debug('文件上传完成', { file: fp.name, size: fp.size });
              res();
            });

            writeStream.on('error', (err) => {
              Logger.error('SFTP写入流错误', { file: fp.name, error: err.message });
              rej(err);
            });

            readStream.on('error', (err) => {
              Logger.error('SFTP读取流错误', { file: fp.name, error: err.message });
              rej(err);
            });

            readStream.pipe(writeStream);
          });
        };

        try {
          // 第一步：收集所有需要创建的远程目录，一次性创建
          const allDirs = new Set();
          for (const fp of filePaths) {
            const remotePath = path.posix.join(destInfo.path || '/', fp.name);
            const remoteDir = path.posix.dirname(remotePath);
            if (remoteDir && remoteDir !== '.') {
              allDirs.add(remoteDir);
            }
          }
          await ensureRemoteDirs(allDirs);

          // 第二步：串行上传（稳定可靠）
          for (let i = 0; i < filePaths.length; i++) {
            if (sendCancelled || AppState.sending.cancelled) {
              Logger.info('SFTP上传被用户取消');
              conn.end();
              reject(new Error('用户取消发送'));
              return;
            }

            const fp = filePaths[i];
            if (!Security.validateFileName(fp.name)) {
              Logger.warn('跳过无效文件名', { name: fp.name });
              continue;
            }

            await uploadFile(fp, i);
          }

          conn.end();
          Logger.info('SFTP上传完成', { host: destInfo.host, totalFiles: filePaths.length });
          resolve();
        } catch (err) {
          conn.end();
          Logger.error('SFTP上传失败', { error: err.message });
          reject(err);
        }
      });
    });

    conn.on('error', (err) => {
      Logger.error('SFTP连接错误', { host: destInfo.host, error: err.message });
      reject(err);
    });

    conn.connect({
      host: destInfo.host,
      port: destInfo.port,
      username: destInfo.user,
      password: destInfo.pass,
      // 性能优化：增大连接超时、启用心跳
      readyTimeout: 30000,
      keepaliveInterval: KEEPALIVE_INTERVAL,
      keepaliveCountMax: 3,
      // 启用压缩（若服务器支持）
      compress: true,
      // TLS/SSL配置
      secure: destInfo.tls && destInfo.tls !== 'none' ? destInfo.tls : false,
    });
  });
}

// WebDAV 上传
async function uploadWebDAV(filePaths, destInfo) {
  Logger.info('开始WebDAV上传', { host: destInfo.host, port: destInfo.port, fileCount: filePaths.length });
  
  // 验证目标信息
  if (!Security.validateIP(destInfo.host)) {
    throw new Error('无效的WebDAV服务器地址');
  }
  if (!Security.validatePort(destInfo.port)) {
    throw new Error('无效的WebDAV服务器端口');
  }
  
  if (mainWindow) mainWindow.webContents.send('send-status', { icon: '🔗', text: '正在连接...', detail: `${destInfo.host}:${destInfo.port}`, status: 'connecting' });
  
  loadWebDAV();
  if (!createWebDAVClient) {
    Logger.error('WebDAV模块加载失败');
    if (mainWindow) mainWindow.webContents.send('send-status', { icon: '❌', text: 'WebDAV 模块加载失败', detail: '请检查依赖安装', status: 'error' });
    throw new Error('WebDAV 模块加载失败');
  }
  
  // 确定协议：WebDAV 使用 http 或 https
  const protocol = destInfo.port === 443 ? 'https' : 'http';
  const client = createWebDAVClient(`${protocol}://${destInfo.host}:${destInfo.port}${destInfo.path || '/'}`, {
    username: destInfo.user,
    password: destInfo.pass,
  });
  
  try {
    // 测试连接
    await client.getDirectoryContents('/');
    Logger.info('WebDAV连接成功', { host: destInfo.host });
  } catch (err) {
    Logger.error('WebDAV连接失败', { host: destInfo.host, error: err.message });
    throw new Error(`WebDAV连接失败: ${err.message}`);
  }
  
  if (mainWindow) mainWindow.webContents.send('send-status', { icon: '✅', text: '连接验证成功', detail: `已连接到 ${destInfo.host}`, status: 'connected' });
  
  // 更新发送状态
  AppState.sending.isSending = true;
  AppState.sending.startTime = Date.now();
  AppState.sending.totalFiles = filePaths.length;
  AppState.sending.totalSize = filePaths.reduce((sum, f) => sum + f.size, 0);
  AppState.sending.sentBytes = 0;
  
  for (let i = 0; i < filePaths.length; i++) {
    // 检查是否取消
    if (sendCancelled || AppState.sending.cancelled) {
      Logger.info('WebDAV上传被用户取消');
      throw new Error('用户取消发送');
    }
    
    const fp = filePaths[i];
    
    // 验证文件名
    if (!Security.validateFileName(fp.name)) {
      Logger.warn('跳过无效文件名', { name: fp.name });
      continue;
    }
    
    if (mainWindow) {
      mainWindow.webContents.send('send-file-start', { fileName: fp.name, currentFile: i + 1, totalFiles: filePaths.length });
    }
    
    // 确保目录存在（递归创建）
    const dirPath = path.posix.dirname(fp.name);
    if (dirPath && dirPath !== '.') {
      const parts = dirPath.split('/').filter(p => p);
      let cur = '';
      for (const part of parts) { 
        cur += '/' + part; 
        try { 
          await client.createDirectory(cur);
          Logger.debug('创建WebDAV目录', { dir: cur });
        } catch(e) {
          // 目录可能已存在，忽略错误
          Logger.debug('WebDAV目录创建失败（可能已存在）', { dir: cur, error: e.message });
        }
      }
    }
    
    // 空目录占位：只创建目录不上传文件
    if (fp.isEmptyDir) {
      Logger.debug('跳过空目录', { dir: fp.name });
      if (mainWindow) {
        mainWindow.webContents.send('send-progress', { 
          fileName: fp.name, 
          fileProgress: 100, 
          totalProgress: Utils.calculateProgress(i + 1, filePaths.length), 
          sentBytes: filePaths.slice(0, i + 1).reduce((s, f) => s + f.size, 0), 
          totalBytes: filePaths.reduce((s, f) => s + f.size, 0), 
          currentFile: i + 1, 
          totalFiles: filePaths.length 
        });
      }
      continue;
    }
    
    // 空文件处理 - 支持0字节文件上传
    if (fp.size === 0) {
      Logger.debug('上传空文件', { file: fp.name });
    }
    
    Logger.debug('开始上传文件', { file: fp.name, size: fp.size });
    
    try {
      // 使用流式上传，避免内存问题
      if (fp.size > CONFIG.chunkSize) {
        // 大文件使用流式上传
        const fileStream = fs.createReadStream(fp.path);
        await client.putFileContents(fp.name, fileStream, {
          onUploadProgress: (progress) => {
            if (progress.loaded && progress.total) {
              const fileProgress = Utils.calculateProgress(progress.loaded, progress.total);
              AppState.sending.sentBytes = (i * fp.size) + progress.loaded;
              
              if (mainWindow) {
                mainWindow.webContents.send('send-progress', {
                  fileName: fp.name,
                  fileProgress,
                  totalProgress: Utils.calculateProgress(AppState.sending.sentBytes, AppState.sending.totalSize),
                  sentBytes: AppState.sending.sentBytes,
                  totalBytes: AppState.sending.totalSize,
                  currentFile: i + 1,
                  totalFiles: filePaths.length,
                });
              }
            }
          }
        });
      } else {
        // 小文件使用普通上传
        const fileData = fs.readFileSync(fp.path);
        await client.putFileContents(fp.name, fileData);
        AppState.sending.sentBytes += fp.size;
      }
      
      Logger.debug('文件上传完成', { file: fp.name, size: fp.size });
      
      if (mainWindow) {
        mainWindow.webContents.send('send-progress', {
          fileName: fp.name, 
          fileProgress: 100,
          totalProgress: Utils.calculateProgress(i + 1, filePaths.length),
          sentBytes: filePaths.slice(0, i + 1).reduce((s, f) => s + f.size, 0),
          totalBytes: filePaths.reduce((s, f) => s + f.size, 0),
          currentFile: i + 1, 
          totalFiles: filePaths.length,
        });
      }
    } catch (err) {
      Logger.error('WebDAV上传失败', { file: fp.name, error: err.message });
      throw new Error(`WebDAV上传失败: ${err.message}`);
    }
  }
  
  Logger.info('WebDAV上传完成', { host: destInfo.host });
}

// 本地 IP 传输（TCP）
async function uploadLocal(filePaths, destInfo) {
  Logger.info('开始本地IP传输', { host: destInfo.host, port: destInfo.port, fileCount: filePaths.length });
  
  // 验证目标信息
  if (!Security.validateIP(destInfo.host)) {
    throw new Error('无效的目标地址');
  }
  if (!Security.validatePort(destInfo.port)) {
    throw new Error('无效的目标端口');
  }
  
  if (mainWindow) mainWindow.webContents.send('send-status', { icon: '🔗', text: '正在连接...', detail: `${destInfo.host}:${destInfo.port}`, status: 'connecting' });
  
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let fileReadStream = null;
    
    socket.on('error', (err) => {
      Logger.error('TCP连接错误', { host: destInfo.host, error: err.message });
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
    
    // 更新发送状态
    AppState.sending.isSending = true;
    AppState.sending.startTime = Date.now();
    AppState.sending.totalFiles = filePaths.length;
    AppState.sending.totalSize = totalSize;
    AppState.sending.sentBytes = 0;
    
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

ipcMain.handle('set-default-destination', (e, id) => {
  let dests = loadDestinations();
  // 清除所有默认标记
  dests.forEach(d => d.isDefault = false);
  // 如果id不为空，设置新的默认目标
  if (id) {
    const idx = dests.findIndex(d => d.id === id);
    if (idx >= 0) {
      dests[idx].isDefault = true;
    }
  }
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

// 拖拽文件路径验证
ipcMain.handle('validate-drag-file', (event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return null;
    }
    // 尝试直接使用路径
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        return {
          path: filePath,
          name: path.basename(filePath),
          size: stat.size,
        };
      }
    }
    // 如果直接路径不存在，尝试常见位置
    const basename = path.basename(filePath);
    const commonPaths = [
      path.join(app.getPath('desktop'), basename),
      path.join(app.getPath('downloads'), basename),
      path.join(app.getPath('documents'), basename),
      path.join(app.getPath('home'), basename),
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.isFile()) {
          return { path: p, name: path.basename(p), size: stat.size };
        }
      }
    }
    return null;
  } catch (e) {
    return null;
  }
});

// 拖拽文件夹路径验证
ipcMain.handle('validate-drag-folder', (event, folderInfo) => {
  try {
    let { folderPath, folderName } = folderInfo;
    if (!folderPath && !folderName) {
      return null;
    }
    
    // 如果提供了完整路径，直接验证
    if (folderPath && fs.existsSync(folderPath)) {
      const stat = fs.statSync(folderPath);
      if (stat.isDirectory()) {
        let totalSize = 0;
        let fileCount = 0;
        function walkDir(dir) {
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) { walkDir(fullPath); }
              else {
                totalSize += fs.statSync(fullPath).size;
                fileCount++;
              }
            }
          } catch(e) {}
        }
        walkDir(folderPath);
        return { path: folderPath, name: folderName || path.basename(folderPath), totalSize, fileCount };
      }
    }
    
    // 如果路径不存在或无效，尝试常见位置
    if (folderName) {
      const cleanName = folderName.replace(/\/$/, '');
      const commonPaths = [
        path.join(app.getPath('desktop'), cleanName),
        path.join(app.getPath('downloads'), cleanName),
        path.join(app.getPath('documents'), cleanName),
        path.join(app.getPath('home'), cleanName),
      ];
      for (const p of commonPaths) {
        if (fs.existsSync(p)) {
          const stat = fs.statSync(p);
          if (stat.isDirectory()) {
            let totalSize = 0;
            let fileCount = 0;
            function walkDir(dir) {
              try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                  const fullPath = path.join(dir, entry.name);
                  if (entry.isDirectory()) { walkDir(fullPath); }
                  else {
                    totalSize += fs.statSync(fullPath).size;
                    fileCount++;
                  }
                }
              } catch(e) {}
            }
            walkDir(p);
            return { path: p, name: cleanName, totalSize, fileCount };
          }
        }
      }
    }
    return null;
  } catch (e) {
    return null;
  }
});

// 检查右键菜单是否已安装
ipcMain.handle('check-context-menu-installed', async () => {
  try {
    const workflowPath = path.join(os.homedir(), 'Library', 'Services', 'Transfer to 文件传输.workflow');
    return fs.existsSync(workflowPath);
  } catch (e) {
    return false;
  }
});

// 安装右键菜单功能
ipcMain.handle('install-context-menu', async () => {
  try {
    const { execSync } = require('child_process');
    const workflowName = 'Transfer to 文件传输.workflow';
    const servicesDir = path.join(os.homedir(), 'Library', 'Services');
    const workflowPath = path.join(servicesDir, workflowName);
    const contentsDir = path.join(workflowPath, 'Contents');

    // 先清理旧版本
    const disabledPath = workflowPath + '.disabled';
    if (fs.existsSync(workflowPath)) {
      fs.rmSync(workflowPath, { recursive: true, force: true });
    }
    if (fs.existsSync(disabledPath)) {
      fs.rmSync(disabledPath, { recursive: true, force: true });
    }

    Utils.safeMkdirSync(contentsDir);

    // ---- Info.plist ----
    // 简化 NSServices 声明，移除 NSRequiredContext 和 NSSendTypes
    // 以提高在 macOS 15+ 上的兼容性
    fs.writeFileSync(path.join(contentsDir, 'Info.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '\t<key>CFBundleDevelopmentRegion</key>',
      '\t<string>en</string>',
      '\t<key>CFBundleIdentifier</key>',
      '\t<string>com.xiamu.filetransfer.quickaction</string>',
      '\t<key>CFBundleInfoDictionaryVersion</key>',
      '\t<string>6.0</string>',
      '\t<key>CFBundleName</key>',
      '\t<string>Transfer to 文件传输</string>',
      '\t<key>CFBundlePackageType</key>',
      '\t<string>BNDL</string>',
      '\t<key>CFBundleShortVersionString</key>',
      '\t<string>1.0</string>',
      '\t<key>CFBundleVersion</key>',
      '\t<string>1</string>',
      '\t<key>NSServices</key>',
      '\t<array>',
      '\t\t<dict>',
      '\t\t\t<key>NSMenuItem</key>',
      '\t\t\t<dict>',
      '\t\t\t\t<key>default</key>',
      '\t\t\t\t<string>Transfer to 文件传输</string>',
      '\t\t\t</dict>',
      '\t\t\t<key>NSMessage</key>',
      '\t\t\t<string>runWorkflowAsService</string>',
      '\t\t\t<key>NSSendFileTypes</key>',
      '\t\t\t<array>',
      '\t\t\t\t<string>public.item</string>',
      '\t\t\t</array>',
      '\t\t</dict>',
      '\t</array>',
      '</dict>',
      '</plist>',
    ].join('\n'));

    // ---- 自包含 shell 脚本 ----
    // 既支持参数传入(automator PassInput=as arguments)也支持 stdin
    // 日志写入 /tmp/file-transfer-quick-action.log 方便调试
    const shellScript = [
      '#!/bin/bash',
      'QA_LOG="/tmp/file-transfer-quick-action.log"',
      'echo "=== $(date) ===" >> "$QA_LOG"',
      'echo "argc=$#  args=$*" >> "$QA_LOG"',
      '',
      '# 收集文件路径',
      'FILE_ARGS=()',
      'if [ $# -gt 0 ]; then',
      '    FILE_ARGS=("$@")',
      '    echo "source=args  count=${#FILE_ARGS[@]}" >> "$QA_LOG"',
      'else',
      '    # 从 stdin 读取（automator CLI 和部分 Quick Action 用 stdin）',
      '    while IFS= read -r line || [ -n "$line" ]; do',
      '        [ -n "$line" ] && FILE_ARGS+=("$line")',
      '    done',
      '    echo "source=stdin  count=${#FILE_ARGS[@]}" >> "$QA_LOG"',
      'fi',
      '',
      'echo "files: ${FILE_ARGS[*]}" >> "$QA_LOG"',
      '[ ${#FILE_ARGS[@]} -eq 0 ] && echo "NO FILES, exit" >> "$QA_LOG" && exit 0',
      '',
      '# 如果应用未运行则启动',
      'APP_NAME="文件传输"',
      'if ! pgrep -fl "$APP_NAME" >> "$QA_LOG" 2>&1; then',
      '    echo "App not running, starting..." >> "$QA_LOG"',
      '    open -a "$APP_NAME"',
      '    for i in $(seq 1 30); do',
      '        sleep 0.5',
      '        pgrep -fl "$APP_NAME" > /dev/null 2>&1 && break',
      '    done',
      '    echo "Waiting for IPC server..." >> "$QA_LOG"',
      '    # 等待 IPC 服务器端口就绪（最多 10 秒）',
      '    for i in $(seq 1 20); do',
      '        (echo >/dev/tcp/127.0.0.1/34569) 2>/dev/null && break',
      '        sleep 0.5',
      '    done',
      '    sleep 1',
      'fi',
      '',
      '# 通过 Python 发送文件路径到 IPC 服务器',
      'python3 -c \'',
      'import json,socket,sys,time',
      'log=open("/tmp/file-transfer-quick-action.log","a")',
      'f=sys.argv[1:]',
      'log.write("python: files="+str(f)+"\\n")',
      'log.flush()',
      'if not f:sys.exit(0)',
      'm=json.dumps({"action":"addFiles","files":f,"timestamp":int(time.time())})',
      'for i in range(10):',
      ' try:',
      '  s=socket.socket(socket.AF_INET,socket.SOCK_STREAM)',
      '  s.settimeout(3)',
      '  s.connect(("127.0.0.1",34569))',
      '  s.sendall(m.encode("utf-8"))',
      '  s.shutdown(socket.SHUT_WR)',
      '  s.close()',
      '  log.write("python: sent OK\\n")',
      '  log.flush()',
      '  sys.exit(0)',
      ' except Exception as e:',
      '  log.write("python: attempt "+str(i)+" failed: "+str(e)+"\\n")',
      '  log.flush()',
      '  try:s.close()',
      '  except:pass',
      '  time.sleep(1)',
      'log.write("python: FAILED all attempts\\n")',
      'sys.exit(1)',
      '\' "${FILE_ARGS[@]}"',
      'echo "=== done exit=$? ===" >> "$QA_LOG"',
    ].join('\n');

    // ---- document.wflow ----
    // 使用与真实 Automator 创建的 workflow 一致的精简结构
    // 移除了 InputSourceTypes/OutputSourceTypes 等会导致 Service 不触发的字段
    const documentWflow = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '\t<key>actions</key>',
      '\t<array>',
      '\t\t<dict>',
      '\t\t\t<key>action</key>',
      '\t\t\t<dict>',
      '\t\t\t\t<key>AMAccepts</key>',
      '\t\t\t\t<dict>',
      '\t\t\t\t\t<key>Container</key>',
      '\t\t\t\t\t<string>List</string>',
      '\t\t\t\t\t<key>Optional</key>',
      '\t\t\t\t\t<true/>',
      '\t\t\t\t\t<key>Types</key>',
      '\t\t\t\t\t<array>',
      '\t\t\t\t\t\t<string>com.apple.cocoa.string</string>',
      '\t\t\t\t\t</array>',
      '\t\t\t\t</dict>',
      '\t\t\t\t<key>AMActionVersion</key>',
      '\t\t\t\t<string>2.0.3</string>',
      '\t\t\t\t<key>AMBundleIdentifier</key>',
      '\t\t\t\t<string>com.apple.RunShellScript</string>',
      '\t\t\t\t<key>ActionParameters</key>',
      '\t\t\t\t<dict>',
      '\t\t\t\t\t<key>COMMAND_STRING</key>',
      '\t\t\t\t\t<string>' + shellScript.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</string>',
      '\t\t\t\t\t<key>Shell</key>',
      '\t\t\t\t\t<string>/bin/bash</string>',
      '\t\t\t\t\t<key>inputMethod</key>',
      '\t\t\t\t\t<integer>0</integer>',
      '\t\t\t\t</dict>',
      '\t\t\t\t<key>AMProvides</key>',
      '\t\t\t\t<dict>',
      '\t\t\t\t\t<key>Container</key>',
      '\t\t\t\t\t<string>List</string>',
      '\t\t\t\t\t<key>Types</key>',
      '\t\t\t\t\t<array>',
      '\t\t\t\t\t\t<string>com.apple.cocoa.string</string>',
      '\t\t\t\t\t</array>',
      '\t\t\t\t</dict>',
      '\t\t\t\t<key>BundleIdentifier</key>',
      '\t\t\t\t<string>com.apple.RunShellScript</string>',
      '\t\t\t\t<key>PassInput</key>',
      '\t\t\t\t<string>as arguments</string>',
      '\t\t\t</dict>',
      '\t\t</dict>',
      '\t</array>',
      '\t<key>connectors</key>',
      '\t<dict/>',
      '\t<key>workflowMetaData</key>',
      '\t<dict>',
      '\t\t<key>applicationBundleID</key>',
      '\t\t<string>com.apple.finder</string>',
      '\t\t<key>workflowTypeIdentifier</key>',
      '\t\t<string>com.apple.Automator.servicesMenuWorkflow</string>',
      '\t</dict>',
      '</dict>',
      '</plist>',
    ].join('\n');
    fs.writeFileSync(path.join(contentsDir, 'document.wflow'), documentWflow);

    // 刷新服务缓存
    try {
      execSync('/System/Library/CoreServices/pbs -flush', { timeout: 5000 });
    } catch (e) {
      Logger.warn('刷新服务缓存失败', { error: e.message });
    }

    Logger.info('右键菜单功能安装成功', { path: workflowPath });
    return { success: true, path: workflowPath };
  } catch (e) {
    Logger.error('安装右键菜单功能失败', { error: e.message });
    return { success: false, error: e.message };
  }
});

// 检查右键菜单是否已启用
ipcMain.handle('check-context-menu-enabled', async () => {
  try {
    const workflowPath = path.join(os.homedir(), 'Library', 'Services', 'Transfer to 文件传输.workflow');
    const disabledPath = workflowPath + '.disabled';
    
    // 如果.workflow文件夹存在且.disabled文件不存在，则已启用
    return fs.existsSync(workflowPath) && !fs.existsSync(disabledPath);
  } catch (e) {
    return false;
  }
});

// 启用右键菜单
ipcMain.handle('enable-context-menu', async () => {
  try {
    const servicesDir = path.join(os.homedir(), 'Library', 'Services');
    const disabledPath = path.join(servicesDir, 'Transfer to 文件传输.workflow.disabled');
    const enabledPath = path.join(servicesDir, 'Transfer to 文件传输.workflow');
    
    // 如果.disabled文件存在，重命名为.workflow
    if (fs.existsSync(disabledPath)) {
      fs.renameSync(disabledPath, enabledPath);
      
      // 刷新服务缓存
      try {
        const { execSync } = require('child_process');
        execSync('/System/Library/CoreServices/pbs -flush', { timeout: 5000 });
      } catch (e) {
        Logger.warn('刷新服务缓存失败', { error: e.message });
      }
      
      Logger.info('右键菜单功能已启用');
      return { success: true, enabled: true };
    } else if (fs.existsSync(enabledPath)) {
      // 已经是启用状态
      return { success: true, enabled: true };
    } else {
      // 文件不存在，需要先安装
      return { success: false, error: '右键菜单未安装，请先安装' };
    }
  } catch (e) {
    Logger.error('启用右键菜单失败', { error: e.message });
    return { success: false, error: e.message };
  }
});

// 禁用右键菜单
ipcMain.handle('disable-context-menu', async () => {
  try {
    const servicesDir = path.join(os.homedir(), 'Library', 'Services');
    const enabledPath = path.join(servicesDir, 'Transfer to 文件传输.workflow');
    const disabledPath = path.join(servicesDir, 'Transfer to 文件传输.workflow.disabled');
    
    // 如果.workflow文件夹存在，重命名为.disabled
    if (fs.existsSync(enabledPath)) {
      fs.renameSync(enabledPath, disabledPath);
      
      // 刷新服务缓存
      try {
        const { execSync } = require('child_process');
        execSync('/System/Library/CoreServices/pbs -flush', { timeout: 5000 });
      } catch (e) {
        Logger.warn('刷新服务缓存失败', { error: e.message });
      }
      
      Logger.info('右键菜单功能已禁用');
      return { success: true, enabled: false };
    } else if (fs.existsSync(disabledPath)) {
      // 已经是禁用状态
      return { success: true, enabled: false };
    } else {
      // 文件不存在
      return { success: false, error: '右键菜单未安装' };
    }
  } catch (e) {
    Logger.error('禁用右键菜单失败', { error: e.message });
    return { success: false, error: e.message };
  }
});

// 卸载右键菜单
ipcMain.handle('uninstall-context-menu', async () => {
  try {
    const servicesDir = path.join(os.homedir(), 'Library', 'Services');
    const workflowPath = path.join(servicesDir, 'Transfer to 文件传输.workflow');
    const disabledPath = workflowPath + '.disabled';

    let removed = false;
    if (fs.existsSync(workflowPath)) {
      fs.rmSync(workflowPath, { recursive: true, force: true });
      removed = true;
    }
    if (fs.existsSync(disabledPath)) {
      fs.rmSync(disabledPath, { recursive: true, force: true });
      removed = true;
    }

    // 清理辅助脚本
    const helperDir = path.join(app.getPath('userData'), 'quick-action-helper');
    if (fs.existsSync(helperDir)) {
      fs.rmSync(helperDir, { recursive: true, force: true });
    }

    if (removed) {
      try {
        const { execSync } = require('child_process');
        execSync('/System/Library/CoreServices/pbs -flush', { timeout: 5000 });
      } catch (e) {
        Logger.warn('刷新服务缓存失败', { error: e.message });
      }
      Logger.info('右键菜单功能已卸载');
      return { success: true };
    } else {
      return { success: true };
    }
  } catch (e) {
    Logger.error('卸载右键菜单失败', { error: e.message });
    return { success: false, error: e.message };
  }
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
    await uploadLocal(filePaths, { type: 'local', host: targetIp, port: currentPort });
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

ipcMain.handle('get-local-info', () => ({ 
  name: deviceName, 
  ip: getLocalIP(),
  port: currentPort
}));

// 扫描局域网设备
ipcMain.handle('scan-lan-devices', async () => {
  Logger.info('收到扫描局域网请求');
  const devices = await scanLanDevices();
  return devices;
});

// 更改监听端口
ipcMain.handle('change-port', async (event, newPort) => {
  if (!Security.validatePort(newPort)) {
    throw new Error('无效的端口号');
  }
  
  if (newPort === currentPort) {
    return { success: true, port: currentPort, message: '端口未变化' };
  }
  
  // 检查端口是否被占用
  const available = await isPortAvailable(newPort);
  if (!available) {
    throw new Error(`端口 ${newPort} 已被占用`);
  }
  
  restartServer(newPort);
  return { success: true, port: newPort };
});

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

// 处理 macOS open-file 事件（通过"打开方式"或拖拽到 Dock 图标）
const pendingOpenFiles = [];
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  Logger.info('收到 open-file 事件', { filePath });
  if (app.isReady() && mainWindow) {
    // 应用已就绪，直接处理
    processArgs([filePath]);
  } else {
    // 应用未就绪，暂存文件路径
    pendingOpenFiles.push(filePath);
  }
});

// 单实例锁 - 禁用以允许多实例运行
// const gotTheLock = app.requestSingleInstanceLock();
// if (!gotTheLock) {
//   // 没有获取锁，直接退出
//   app.exit(0);
// } else {
//   app.on('second-instance', (event, commandLine) => {
//     log('second-instance: ' + JSON.stringify(commandLine));
//     if (mainWindow) {
//       mainWindow.show();
//       mainWindow.focus();
//       mainWindow.setAlwaysOnTop(true);
//       setTimeout(() => mainWindow.setAlwaysOnTop(false), 500);
//     }
//     // 处理第二个实例传入的参数
//     const args = commandLine.slice(1).filter(a => !a.includes('electron') && !a.startsWith('--'));
//     processArgs(args);
//   });
// }

// 如果没有锁，不继续执行
// if (!gotTheLock) {
//   process.exit(0);
// }
const gotTheLock = true; // 允许多实例

// ---- 生命周期 ----
app.whenReady().then(() => {
  // 初始化日志系统
  Logger.init();
  Logger.info('应用程序启动');
  
  createWindow();
  startServer();
  startDiscovery();
  startIPCServer(); // 启动Finder扩展IPC服务器
  
  // 处理命令行参数
  // 开发模式: argv = [electron, main.js, ...userArgs]
  // 打包模式: argv = [exe, ...userArgs]
  Logger.info('应用程序就绪', { argv: process.argv });
  
  // 找到用户参数（跳过 exe 和 electron 相关参数）
  const args = process.argv.slice(1).filter(a => !a.includes('electron') && !a.startsWith('--') && !a.endsWith('.asar') && !a.endsWith('.js'));
  Logger.debug('过滤后的参数', { args });
  processArgs(args);

  // 处理在 app ready 之前收到的 open-file 事件
  if (pendingOpenFiles.length > 0) {
    Logger.info('处理暂存的 open-file 事件', { count: pendingOpenFiles.length });
    processArgs(pendingOpenFiles.splice(0));
  }
});
app.on('window-all-closed', () => { 
  Logger.info('所有窗口关闭'); 
  if (server) server.close(); 
  if (udpSocket) udpSocket.close(); 
  if (ipcServer) ipcServer.close(); // 关闭IPC服务器
  app.quit(); 
});
app.on('activate', () => { 
  Logger.info('应用程序激活');
  if (BrowserWindow.getAllWindows().length === 0) createWindow(); 
});
