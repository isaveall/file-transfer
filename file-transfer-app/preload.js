// ============================================================
// file-transfer/preload.js - 预加载脚本
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 文件选择
  selectFiles: () => ipcRenderer.invoke('select-files'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // 设备
  getDevices: () => ipcRenderer.invoke('get-devices'),
  getLocalInfo: () => ipcRenderer.invoke('get-local-info'),

  // 目标管理
  getDestinations: () => ipcRenderer.invoke('get-destinations'),
  addDestination: (dest) => ipcRenderer.invoke('add-destination', dest),
  deleteDestination: (id) => ipcRenderer.invoke('delete-destination', id),
  updateDestination: (id, updates) => ipcRenderer.invoke('update-destination', id, updates),
  openDestManager: () => ipcRenderer.invoke('open-dest-manager'),

  // 发送
  sendFiles: (opts) => ipcRenderer.invoke('send-files', opts),
  cancelSend: () => ipcRenderer.invoke('cancel-send'),

  // 事件监听
  onDevicesUpdated: (cb) => ipcRenderer.on('devices-updated', (_e, data) => cb(data)),
  onSendProgress: (cb) => ipcRenderer.on('send-progress', (_e, data) => cb(data)),
  onSendFileStart: (cb) => ipcRenderer.on('send-file-start', (_e, data) => cb(data)),
  onSendComplete: (cb) => ipcRenderer.on('send-complete', (_e, data) => cb(data)),
  onSendError: (cb) => ipcRenderer.on('send-error', (_e, data) => cb(data)),
  onSendStatus: (cb) => ipcRenderer.on('send-status', (_e, data) => cb(data)),
  onReceiveProgress: (cb) => ipcRenderer.on('receive-progress', (_e, data) => cb(data)),
  onReceiveComplete: (cb) => ipcRenderer.on('receive-complete', (_e, data) => cb(data)),
  onReceiveError: (cb) => ipcRenderer.on('receive-error', (_e, data) => cb(data)),
  onAddFilesFromContext: (cb) => ipcRenderer.on('add-files-from-context', (_e, data) => cb(data)),

  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),

  // 窗口控制
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  destWindowClose: () => ipcRenderer.send('dest-window-close'),
  
  // 调试日志
  writeDebugLog: (msg) => ipcRenderer.invoke('write-debug-log', msg),
});
