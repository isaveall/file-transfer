// ============================================================
// file-transfer/renderer.js - 渲染进程（UI 逻辑）v3
// ============================================================

// ---- 状态 ----
let files = [];
let selectedIndex = -1;
let isSending = false;
let destinations = [];
let sendCompleted = false;
let currentSendingIndex = -1;

// ---- DOM ----
const $ = (sel) => document.querySelector(sel);
const targetSelect = $('#targetSelect');
const btnDestManager = $('#btnDestManager');
const localInfo = $('#localInfo');
const fileList = $('#fileList');
const dropZone = $('#dropZone');
const btnAddFile = $('#btnAddFile');
const btnAddFolder = $('#btnAddFolder');
const btnRemove = $('#btnRemove');
const btnCancel = $('#btnCancel');
const btnSend = $('#btnSend');
const btnClearAll = $('#btnClearAll');
const receiveBar = $('#receiveBar');
const receiveFile = $('#receiveFile');
const receiveProgressFill = $('#receiveProgressFill');
const receivePercent = $('#receivePercent');

const tagLocal = $('#tagLocal');
const tagFtp = $('#tagFtp');
const tagSftp = $('#tagSftp');
const tagWebdav = $('#tagWebdav');
const typeIcons = { local: '🌐', ftp: '📁', sftp: '🔒', webdav: '☁️' };

// ---- 事件监听（只注册一次）----
window.api.onSendFileStart((data) => {
  currentSendingIndex = data.currentFile - 1;
  if (currentSendingIndex >= 0 && currentSendingIndex < files.length) {
    files[currentSendingIndex].status = '📤 连接中...';
    renderFileList();
  }
});

window.api.onSendStatus((data) => {
  if (data.status === 'connecting') {
    if (currentSendingIndex >= 0 && currentSendingIndex < files.length) {
      files[currentSendingIndex].status = '🔗 ' + data.text;
      renderFileList();
    }
  } else if (data.status === 'connected') {
    if (currentSendingIndex >= 0 && currentSendingIndex < files.length) {
      files[currentSendingIndex].status = '✅ 已连接';
      renderFileList();
    }
  } else if (data.status === 'success') {
    sendCompleted = true;
    files.forEach(f => { f.progress = 100; f.status = '✅ 完成'; });
    renderFileList();
    isSending = false;
    updateButtons();
  } else if (data.status === 'error') {
    sendCompleted = true;
    if (currentSendingIndex >= 0 && currentSendingIndex < files.length) {
      files[currentSendingIndex].status = '❌ ' + (data.detail || data.text || '错误');
    }
    renderFileList();
    isSending = false;
    updateButtons();
  }
});

window.api.onSendProgress((data) => {
  if (sendCompleted) return;
  const idx = data.currentFile - 1;
  if (idx >= 0 && idx < files.length) {
    files[idx].progress = data.fileProgress;
    if (data.fileProgress >= 100) {
      files[idx].status = '✅ 完成';
    } else {
      files[idx].status = '📤 发送中 ' + data.fileProgress + '%';
    }
    renderFileList();
  }
});

window.api.onSendComplete((data) => {
  files.forEach(f => {
    if (!f.status.startsWith('❌')) {
      f.progress = 100;
      f.status = '✅ 完成';
    }
  });
  renderFileList();
  isSending = false;
  sendCompleted = true;
  updateButtons();
  // 提示可继续添加文件
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const totalSize = totalBytes > 1024 * 1024 ? (totalBytes / 1024 / 1024).toFixed(1) + ' MB' : (totalBytes / 1024).toFixed(1) + ' KB';
  document.title = '文件传输 - 完成 (' + files.length + '个文件, ' + totalSize + ')';
  // 2秒后自动恢复到添加文件状态
  setTimeout(() => {
    files = [];
    selectedIndex = -1;
    sendCompleted = false;
    dropZone.style.display = 'flex';
    document.title = '文件传输';
    renderFileList();
    updateButtons();
  }, 2000);
});

window.api.onSendError((data) => {
  if (currentSendingIndex >= 0 && currentSendingIndex < files.length) {
    files[currentSendingIndex].status = '❌ ' + (data.message || '发送失败');
  }
  renderFileList();
  isSending = false;
  updateButtons();
});

// 右键菜单添加的文件
window.api.onAddFilesFromContext((newFiles) => {
  console.log('[Renderer] onAddFilesFromContext:', JSON.stringify(newFiles));
  window.api.writeDebugLog('[Renderer] onAddFilesFromContext: ' + JSON.stringify(newFiles)).catch(e => console.error(e));
  if (newFiles && newFiles.length > 0) {
    if (sendCompleted) {
      files.forEach(f => { f.progress = 0; f.status = '等待'; });
      sendCompleted = false;
    }
    // 检查重复：按路径去重
    const existingPaths = new Set(files.map(f => f.path));
    const newUniqueFiles = newFiles.filter(f => !existingPaths.has(f.path));
    if (newUniqueFiles.length === 0) {
      window.api.writeDebugLog('[Renderer] all files already exist, skipped').catch(e => console.error(e));
      return;
    }
    files.push(...newUniqueFiles.map(f => ({ ...f, progress: 0, status: '等待' })));
    dropZone.style.display = 'none';
    renderFileList();
    updateButtons();
    window.api.writeDebugLog('[Renderer] files added: ' + newUniqueFiles.length + ', total: ' + files.length).catch(e => console.error(e));
  }
});

// ---- 初始化 ----
async function init() {
  $('#btnMin').addEventListener('click', () => window.api.minimize());
  $('#btnMax').addEventListener('click', () => window.api.maximize());
  $('#btnClose').addEventListener('click', () => window.api.close());

  const info = await window.api.getLocalInfo();
  localInfo.textContent = `本机: ${info.name} (${info.ip})`;

  await loadTargets();

  window.api.onDevicesUpdated((devices) => {
    buildTargetList(destinations, devices);
  });

  targetSelect.addEventListener('change', updateProtocolTags);
  btnDestManager.addEventListener('click', () => window.api.openDestManager());
  btnAddFile.addEventListener('click', addFiles);
  btnAddFolder.addEventListener('click', addFolder);
  btnRemove.addEventListener('click', removeSelected);
  btnCancel.addEventListener('click', cancelTransfer);
  btnSend.addEventListener('click', sendFiles);
  btnClearAll.addEventListener('click', clearAllFiles);

  setupDragDrop();

  window.api.onReceiveProgress((data) => {
    receiveBar.style.display = 'flex';
    receiveFile.textContent = `${data.fileName} (${data.currentFile}/${data.totalFiles})`;
    receiveProgressFill.style.width = `${data.progress}%`;
    receivePercent.textContent = `${data.progress}%`;
  });
  window.api.onReceiveComplete((data) => {
    receiveFile.textContent = `✅ 完成! 共 ${data.totalFiles} 个文件`;
    receiveProgressFill.style.width = '100%';
    receivePercent.textContent = '100%';
    setTimeout(() => { receiveBar.style.display = 'none'; }, 5000);
  });
  window.api.onReceiveError((data) => {
    receiveFile.textContent = `❌ 接收失败: ${data.message}`;
    setTimeout(() => { receiveBar.style.display = 'none'; }, 5000);
  });

  setInterval(async () => {
    const newDests = await window.api.getDestinations();
    if (JSON.stringify(newDests) !== JSON.stringify(destinations)) {
      destinations = newDests;
      buildTargetList(destinations);
    }
  }, 3000);
}

async function loadTargets() {
  destinations = await window.api.getDestinations();
  buildTargetList(destinations);
}

function buildTargetList(savedDests, discoveredDevices) {
  targetSelect.innerHTML = '';

  if (savedDests && savedDests.length > 0) {
    const groupSaved = document.createElement('optgroup');
    groupSaved.label = '📡 已保存的目标';
    for (const d of savedDests) {
      const opt = document.createElement('option');
      opt.value = `dest:${d.id}`;
      opt.textContent = `${typeIcons[d.type] || '❓'} ${d.name}`;
      opt.dataset.dest = JSON.stringify(d);
      groupSaved.appendChild(opt);
    }
    targetSelect.appendChild(groupSaved);
  }

  const groupLan = document.createElement('optgroup');
  groupLan.label = '🌐 局域网设备';

  const optManual = document.createElement('option');
  optManual.value = 'manual:';
  optManual.textContent = '✏️ 手动输入 IP...';
  groupLan.appendChild(optManual);

  if (discoveredDevices) {
    for (const dev of discoveredDevices) {
      if (dev.id === 'manual') continue;
      const opt = document.createElement('option');
      opt.value = `lan:${dev.ip}`;
      opt.textContent = `💻 ${dev.name}`;
      groupLan.appendChild(opt);
    }
  }
  targetSelect.appendChild(groupLan);
  updateProtocolTags();
}

function updateProtocolTags() {
  tagLocal.style.display = 'none';
  tagFtp.style.display = 'none';
  tagSftp.style.display = 'none';
  tagWebdav.style.display = 'none';

  const val = targetSelect.value;
  if (!val) return;

  if (val.startsWith('dest:')) {
    const id = val.replace('dest:', '');
    const d = destinations.find(x => x.id === id);
    if (d) {
      switch (d.type) {
        case 'local': tagLocal.style.display = 'inline'; break;
        case 'ftp': tagFtp.style.display = 'inline'; break;
        case 'sftp': tagSftp.style.display = 'inline'; break;
        case 'webdav': tagWebdav.style.display = 'inline'; break;
      }
    }
  } else if (val.startsWith('lan:') || val.startsWith('manual:')) {
    tagLocal.style.display = 'inline';
  }
}

async function addFiles() {
  const selected = await window.api.selectFiles();
  if (selected.length > 0) {
    if (sendCompleted) {
      files.forEach(f => { f.progress = 0; f.status = '等待'; });
      sendCompleted = false;
    }
    const existingPaths = new Set(files.map(f => f.path));
    const newFiles = selected.filter(f => !existingPaths.has(f.path));
    if (newFiles.length === 0) { alert('所选文件已在列表中'); return; }
    files.push(...newFiles.map(f => ({ ...f, progress: 0, status: '等待' })));
    dropZone.style.display = 'none';
    renderFileList();
    updateButtons();
  }
}

async function addFolder() {
  const selected = await window.api.selectFolder();
  if (selected.length > 0) {
    if (sendCompleted) {
      files.forEach(f => { f.progress = 0; f.status = '等待'; });
      sendCompleted = false;
    }
    const existingPaths = new Set(files.map(f => f.path));
    const newFolders = selected.filter(f => !existingPaths.has(f.path));
    if (newFolders.length === 0) { alert('该文件夹已在列表中'); return; }
    files.push(...newFolders.map(f => ({ ...f, progress: 0, status: '等待' })));
    dropZone.style.display = 'none';
    renderFileList();
    updateButtons();
  }
}

function removeSelected() {
  const idx = selectedIndex; // 保存当前选中索引
  if (idx >= 0 && idx < files.length) {
    files.splice(idx, 1);
    selectedIndex = -1;
    if (files.length === 0) dropZone.style.display = 'flex';
    renderFileList();
    updateButtons();
  } else {
    alert('请先点击选中要移除的文件');
  }
}

function cancelTransfer() { window.api.cancelSend(); isSending = false; updateButtons(); }

function clearAllFiles() {
  if (isSending) { alert('正在发送中，无法清空'); return; }
  files = [];
  selectedIndex = -1;
  dropZone.style.display = 'flex';
  renderFileList();
  updateButtons();
}

function renderFileList() {
  const existingItems = fileList.querySelectorAll('.file-item');
  existingItems.forEach(el => el.remove());
  if (files.length === 0) { dropZone.style.display = 'flex'; return; }

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const row = document.createElement('div');
    row.className = 'file-item' + (i === selectedIndex ? ' selected' : '');
    row.dataset.index = i;

    const name = document.createElement('div');
    name.className = 'file-item-name';
    name.textContent = f.isFolder ? '📁 ' + f.name : f.name;
    name.title = f.path;

    const size = document.createElement('div');
    size.className = 'file-item-size';
    size.textContent = formatSize(f.size);

    const progress = document.createElement('div');
    progress.className = 'file-item-progress';
    progress.innerHTML = `<div class="mini-progress"><div class="mini-progress-fill" style="width:${f.progress}%"></div></div>`;

    const status = document.createElement('div');
    status.className = 'file-item-status';
    if (f.status.startsWith('发送中') || f.status.startsWith('📤')) status.classList.add('status-sending');
    else if (f.status.startsWith('完成') || f.status.startsWith('✅')) status.classList.add('status-done');
    else if (f.status.startsWith('错误') || f.status.startsWith('❌')) status.classList.add('status-error');
    status.textContent = f.status;

    row.appendChild(name);
    row.appendChild(size);
    row.appendChild(progress);
    row.appendChild(status);

    row.dataset.index = i;
    row.onclick = function() {
      selectedIndex = parseInt(this.dataset.index);
      renderFileList();
      updateButtons();
    };
    fileList.appendChild(row);
  }
}

function updateButtons() {
  btnSend.disabled = files.length === 0 || isSending;
  btnRemove.disabled = selectedIndex < 0 || isSending || files.length === 0;
  btnClearAll.disabled = isSending || files.length === 0;
  btnAddFile.disabled = isSending;
  btnAddFolder.disabled = isSending;
  btnCancel.disabled = !isSending;
}

function setupDragDrop() {
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => { e.preventDefault(); });

  fileList.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('active'); });
  fileList.addEventListener('dragleave', () => { dropZone.classList.remove('active'); });
  fileList.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('active');
    const items = e.dataTransfer.items;
    if (!items) return;
    const newFiles = [];

    const processEntry = async (entry, relPath = '') => {
      if (entry.isFile) {
        const file = await new Promise((resolve) => entry.file(resolve));
        if (file) {
          newFiles.push({
            path: file.path || file.name,
            name: relPath ? `${relPath}/${file.name}` : file.name,
            size: file.size, progress: 0, status: '等待',
          });
        }
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const entries = await new Promise((resolve) => reader.readEntries(resolve));
        for (const child of entries) {
          await processEntry(child, relPath ? `${relPath}/${entry.name}` : entry.name);
        }
      }
    };

    (async () => {
      for (const item of items) {
        const entry = item.webkitGetAsEntry?.();
        if (entry) await processEntry(entry);
      }
      if (newFiles.length > 0) {
        const existingPaths = new Set(files.map(f => f.path));
        const uniqueNewFiles = newFiles.filter(f => !existingPaths.has(f.path));
        if (uniqueNewFiles.length === 0) return;
        files.push(...uniqueNewFiles);
        dropZone.style.display = 'none';
        renderFileList();
        updateButtons();
      }
    })();
  });
}

async function sendFiles() {
  const val = targetSelect.value;
  if (!val) { alert('请选择目标'); return; }
  if (files.length === 0) { alert('请先添加文件'); return; }

  let targetIp = null;
  let targetUrl = null;

  if (val.startsWith('dest:')) {
    const id = val.replace('dest:', '');
    const d = destinations.find(x => x.id === id);
    if (!d) { alert('目标不存在'); return; }
    if (d.type === 'local') {
      targetIp = d.host;
    } else {
      const user = d.user ? `${encodeURIComponent(d.user)}:${encodeURIComponent(d.pass || '')}@` : '';
      targetUrl = `${d.type}://${user}${d.host}:${d.port}${d.path || '/'}`;
    }
  } else if (val.startsWith('lan:')) {
    targetIp = val.replace('lan:', '');
  } else if (val.startsWith('manual:')) {
    const ip = prompt('请输入目标 IP 地址:');
    if (!ip) return;
    targetIp = ip;
  }

  isSending = true;
  sendCompleted = false;
  currentSendingIndex = -1;
  updateButtons();
  files.forEach(f => { f.progress = 0; f.status = '⏳ 等待'; });
  renderFileList();

  try {
    await window.api.sendFiles({
      targetIp,
      targetUrl,
      files: files.map(f => ({ path: f.path, name: f.name, size: f.size, isFolder: f.isFolder || false })),
    });
  } catch (err) {
    sendCompleted = true;
    if (currentSendingIndex >= 0 && currentSendingIndex < files.length) {
      files[currentSendingIndex].status = '❌ ' + (err.message || String(err));
    }
    renderFileList();
    isSending = false;
    updateButtons();
  }
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

init();
