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
const btnScanLan = $('#btnScanLan');
const localInfo = $('#localInfo');
const localPort = $('#localPort');
const btnChangePort = $('#btnChangePort');
const fileList = $('#fileList');

// 立即检查按钮元素是否存在
if (btnChangePort) {
  btnChangePort.addEventListener('click', () => {
    window.showStatus('✅', '端口修改功能已触发', 'info');
  });
}
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
  localPort.textContent = info.port;

  // 监听端口变化事件
  window.api.onPortChanged((data) => {
    localPort.textContent = data.port;
  });

  // 更改端口按钮事件
  if (btnChangePort) {
    btnChangePort.addEventListener('click', async () => {
      
      // 视觉反馈：按钮变色
      btnChangePort.style.background = '#667eea';
      btnChangePort.style.color = 'white';
      setTimeout(() => {
        btnChangePort.style.background = 'transparent';
        btnChangePort.style.color = 'var(--text-dim)';
      }, 200);
      
      // 创建自定义对话框
      const dialog = document.createElement('div');
      dialog.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      `;
      
      const dialogContent = document.createElement('div');
      dialogContent.style.cssText = `
        background: #2b2b2b;
        padding: 24px;
        border-radius: 10px;
        min-width: 360px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        border: 1px solid #3f3f3f;
      `;
      
      dialogContent.innerHTML = `
        <h3 style="margin-top: 0; margin-bottom: 8px; color: #e0e0e0; font-size: 16px; font-weight: 600;">更改监听端口</h3>
        <p style="color: #9e9e9e; margin-bottom: 20px; font-size: 13px;">请输入新的监听端口 (1024-65535)：</p>
        <input type="number" id="portInput" value="${localPort.textContent}" 
               style="width: 100%; padding: 10px 12px; border: 1px solid #3f3f3f; border-radius: 6px; background: #1e1e1e; color: #e0e0e0; font-size: 14px; box-sizing: border-box; outline: none; margin-bottom: 20px;"
               min="1024" max="65535">
        <div style="display: flex; justify-content: flex-end; gap: 10px;">
          <button id="cancelBtn" style="padding: 8px 20px; border: 1px solid #3f3f3f; background: #383838; color: #b0b0b0; border-radius: 6px; cursor: pointer; font-size: 13px;">取消</button>
          <button id="confirmBtn" style="padding: 8px 20px; border: none; background: #60cdff; color: #191919; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px;">确定</button>
        </div>
      `;
      
      dialog.appendChild(dialogContent);
      document.body.appendChild(dialog);
      
      // 绑定事件
      const portInput = dialogContent.querySelector('#portInput');
      const cancelBtn = dialogContent.querySelector('#cancelBtn');
      const confirmBtn = dialogContent.querySelector('#confirmBtn');
      
      portInput.focus();
      portInput.select();
      
      // Enter 键确认
      portInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          confirmBtn.click();
        }
      });
      
      cancelBtn.addEventListener('click', () => {
        document.body.removeChild(dialog);
      });
      
      confirmBtn.addEventListener('click', async () => {
        const newPort = portInput.value;
        const portNum = parseInt(newPort);
        
        if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
          alert('请输入有效的端口号 (1024-65535)');
          return;
        }
        
        try {
          const result = await window.api.changePort(portNum);
          if (result.success) {
            localPort.textContent = result.port;
            document.body.removeChild(dialog);
            alert(`端口已更改为 ${result.port}`);
          }
        } catch (error) {
          alert(`更改端口失败: ${error.message}`);
        }
      });
      
      // 点击背景关闭
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) {
          document.body.removeChild(dialog);
        }
      });
      
      // 按ESC关闭
      const escHandler = (e) => {
        if (e.key === 'Escape') {
          document.body.removeChild(dialog);
          document.removeEventListener('keydown', escHandler);
        }
      };
      document.addEventListener('keydown', escHandler);
    });
  } else {
    console.error('DEBUG: btnChangePort element not found');
  }

  await loadTargets();

  window.api.onDevicesUpdated((devices) => {
    buildTargetList(destinations, devices);
  });

  // 在选择变化时处理"手动输入 IP..."
  targetSelect.addEventListener('change', async () => {
    updateProtocolTags();
    
    // 当选择"手动输入 IP..."时，立即弹出对话框
    if (targetSelect.value === 'manual:') {
      const result = await showManualInputDialog();
      if (result) {
        // 创建一个临时目标选项
        const tempValue = `lan:${result.ip}:${result.port}`;
        const tempText = `📡 ${result.ip}:${result.port}`;
        
        // 检查是否已存在相同的临时选项
        const existing = Array.from(targetSelect.options).find(opt => opt.value === tempValue);
        if (existing) {
          targetSelect.value = tempValue;
        } else {
          // 添加临时选项并选中
          const opt = document.createElement('option');
          opt.value = tempValue;
          opt.textContent = tempText;
          
          // 插入到"手动输入"前面
          const manualOpt = Array.from(targetSelect.options).find(o => o.value === 'manual:');
          if (manualOpt) {
            targetSelect.insertBefore(opt, manualOpt.nextSibling);
          } else {
            const lanGroup = targetSelect.querySelector('optgroup[label="🌐 局域网设备"]');
            if (lanGroup) lanGroup.appendChild(opt);
            else targetSelect.appendChild(opt);
          }
          targetSelect.value = tempValue;
        }
      } else {
        // 用户取消，恢复到第一个有效选项
        const firstValid = Array.from(targetSelect.options).find(o => o.value && o.value !== 'manual:');
        if (firstValid) targetSelect.value = firstValid.value;
      }
      updateProtocolTags();
    }
  });
  btnDestManager.addEventListener('click', () => window.api.openDestManager());
  btnScanLan.addEventListener('click', scanLanDevices);
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
  const previousValue = targetSelect.value;
  targetSelect.innerHTML = '';
  
  let defaultId = null;

  if (savedDests && savedDests.length > 0) {
    const groupSaved = document.createElement('optgroup');
    groupSaved.label = '📡 已保存的目标';
    for (const d of savedDests) {
      const opt = document.createElement('option');
      opt.value = `dest:${d.id}`;
      opt.textContent = `${typeIcons[d.type] || '❓'} ${d.name}`;
      opt.dataset.dest = JSON.stringify(d);
      groupSaved.appendChild(opt);
      
      // 检查是否为默认目标
      if (d.isDefault) {
        defaultId = d.id;
      }
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
      opt.value = `lan:${dev.ip}:${dev.port || 34567}`;  // 包含端口号
      opt.textContent = `💻 ${dev.name}`;
      opt.dataset.port = dev.port || 34567;  // 保存端口信息
      groupLan.appendChild(opt);
    }
  }
  targetSelect.appendChild(groupLan);
  
  // 如果有默认目标，且当前没有选择或之前的选择无效，则选择默认目标
  if (defaultId) {
    const defaultOption = `dest:${defaultId}`;
    // 检查之前的选择是否有效
    const isPreviousValid = Array.from(targetSelect.options).some(opt => opt.value === previousValue);
    if (!isPreviousValid || !previousValue) {
      targetSelect.value = defaultOption;
    }
  }
  
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
    
    // 先收集所有拖入的文件/文件夹信息
    const pendingItems = [];
    
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (!entry) continue;
      pendingItems.push({ entry, isDirectory: entry.isDirectory, isFile: entry.isFile, name: entry.name });
    }
    
    // 异步处理所有文件/文件夹
    (async () => {
      const newFiles = [];
      
      for (const { entry, isDirectory, isFile, name } of pendingItems) {
        if (isDirectory) {
          // 文件夹：递归获取子文件，尝试推算文件夹路径
          let folderPath = null;
          let totalSize = 0;
          let fileCount = 0;
          
          const walkDir = async (dirEntry) => {
            const reader = dirEntry.createReader();
            const readBatch = async () => {
              const entries = await new Promise((resolve) => reader.readEntries(resolve));
              if (entries.length === 0) return;
              for (const child of entries) {
                if (child.isFile) {
                  const file = await new Promise((resolve) => child.file(resolve));
                  totalSize += file.size;
                  fileCount++;
                  if (!folderPath) {
                    // 使用 webUtils 获取正确的文件路径
                    const filePath = window.api.getPathForFile(file);
                    if (filePath) {
                      // 从第一个文件路径推算文件夹路径
                      const idx = filePath.lastIndexOf('/' + entry.name + '/');
                      if (idx >= 0) {
                        folderPath = filePath.substring(0, idx + entry.name.length + 1);
                      } else {
                        folderPath = filePath.replace(file.name, '');
                      }
                    }
                  }
                } else if (child.isDirectory) {
                  await walkDir(child);
                }
              }
              await readBatch();
            };
            await readBatch();
          };
          await walkDir(entry);
          
          // 通过 IPC 验证文件夹路径
          const folderInfo = await window.api.validateDragFolder({
            folderPath: folderPath,
            folderName: name
          });
          
          if (folderInfo) {
            newFiles.push({
              path: folderInfo.path,
              name: folderInfo.name + '/',
              size: folderInfo.totalSize,
              isFolder: true,
              fileCount: folderInfo.fileCount,
              progress: 0,
              status: '等待',
            });
          } else {
            // 验证失败，使用原始路径（可能无效）
            newFiles.push({
              path: folderPath || ('drag:' + name + '/'),
              name: name + '/',
              size: totalSize,
              isFolder: true,
              fileCount: fileCount,
              progress: 0,
              status: '路径无效',
            });
          }
        } else if (isFile) {
          // 文件：获取文件对象
          const file = await new Promise((resolve) => entry.file(resolve));
          // 使用 webUtils 获取正确的文件路径
          const filePath = file ? window.api.getPathForFile(file) : null;
          if (file && filePath) {
            // 通过 IPC 验证文件路径
            const fileInfo = await window.api.validateDragFile(filePath);
            if (fileInfo) {
              newFiles.push({
                path: fileInfo.path,
                name: fileInfo.name,
                size: fileInfo.size,
                progress: 0,
                status: '等待',
              });
            } else {
              // 验证失败，使用获取到的路径
              newFiles.push({
                path: filePath,
                name: file.name,
                size: file.size,
                progress: 0,
                status: '路径无效',
              });
            }
          } else if (file) {
            // 无法获取路径，标记为路径无效
            newFiles.push({
              path: file.name,
              name: file.name,
              size: file.size,
              progress: 0,
              status: '路径无效',
            });
          }
        }
      }
      
      if (newFiles.length > 0) {
        const existingPaths = new Set(files.map(f => f.path));
        const uniqueNewFiles = newFiles.filter(f => !existingPaths.has(f.path));
        if (uniqueNewFiles.length === 0) return;
        if (sendCompleted) {
          files.forEach(f => { f.progress = 0; f.status = '等待'; });
          sendCompleted = false;
        }
        files.push(...uniqueNewFiles);
        dropZone.style.display = 'none';
        renderFileList();
        updateButtons();
      }
    })();
  });
}

// 显示手动输入对话框
async function showManualInputDialog() {
  return new Promise((resolve) => {
    const dialog = document.createElement('div');
    dialog.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    `;
    
    const dialogContent = document.createElement('div');
    dialogContent.style.cssText = `
      background: #2b2b2b;
      padding: 24px;
      border-radius: 10px;
      min-width: 360px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      border: 1px solid #3f3f3f;
    `;
    
    dialogContent.innerHTML = `
      <h3 style="margin-top: 0; margin-bottom: 8px; color: #e0e0e0; font-size: 16px; font-weight: 600;">手动输入目标地址</h3>
      <p style="color: #9e9e9e; margin-bottom: 20px; font-size: 13px;">请输入目标设备的 IP 地址和端口：</p>
      <div style="margin-bottom: 16px;">
        <label style="display: block; margin-bottom: 6px; color: #b0b0b0; font-size: 13px;">IP 地址</label>
        <input type="text" id="ipInput" placeholder="例如: 192.168.1.100" 
               style="width: 100%; padding: 10px 12px; border: 1px solid #3f3f3f; border-radius: 6px; background: #1e1e1e; color: #e0e0e0; font-size: 14px; box-sizing: border-box; outline: none;">
      </div>
      <div style="margin-bottom: 20px;">
        <label style="display: block; margin-bottom: 6px; color: #b0b0b0; font-size: 13px;">端口</label>
        <input type="number" id="portInput" value="34567" min="1024" max="65535"
               style="width: 100%; padding: 10px 12px; border: 1px solid #3f3f3f; border-radius: 6px; background: #1e1e1e; color: #e0e0e0; font-size: 14px; box-sizing: border-box; outline: none;">
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px;">
        <button id="cancelManualBtn" style="padding: 8px 20px; border: 1px solid #3f3f3f; background: #383838; color: #b0b0b0; border-radius: 6px; cursor: pointer; font-size: 13px;">取消</button>
        <button id="confirmManualBtn" style="padding: 8px 20px; border: none; background: #60cdff; color: #191919; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px;">确定</button>
      </div>
    `;
    
    dialog.appendChild(dialogContent);
    document.body.appendChild(dialog);
    
    const ipInput = dialog.querySelector('#ipInput');
    const portInput = dialog.querySelector('#portInput');
    const cancelBtn = dialog.querySelector('#cancelManualBtn');
    const confirmBtn = dialog.querySelector('#confirmManualBtn');
    
    ipInput.focus();
    
    // Enter 键确认
    const submitOnEnter = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmBtn.click();
      }
    };
    ipInput.addEventListener('keydown', submitOnEnter);
    portInput.addEventListener('keydown', submitOnEnter);
    
    cancelBtn.addEventListener('click', () => {
      document.body.removeChild(dialog);
      resolve(null);
    });
    
    confirmBtn.addEventListener('click', () => {
      const ip = ipInput.value.trim();
      const port = parseInt(portInput.value);
      
      if (!ip) {
        alert('请输入IP地址');
        return;
      }
      if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        alert('请输入有效的IP地址');
        return;
      }
      if (isNaN(port) || port < 1024 || port > 65535) {
        alert('请输入有效的端口号 (1024-65535)');
        return;
      }
      
      document.body.removeChild(dialog);
      resolve({ ip, port });
    });
    
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) {
        document.body.removeChild(dialog);
        resolve(null);
      }
    });
    
    // ESC 键关闭
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        document.body.removeChild(dialog);
        document.removeEventListener('keydown', escHandler);
        resolve(null);
      }
    };
    document.addEventListener('keydown', escHandler);
  });
}

async function sendFiles() {
  const val = targetSelect.value;
  if (!val) { alert('请选择目标'); return; }

  let targetIp = null;
  let targetUrl = null;

  // 先处理手动输入的情况，在检查文件之前弹出对话框
  if (val.startsWith('manual:')) {
    // 显示自定义对话框输入IP和端口
    const result = await showManualInputDialog();
    if (!result) return;
    
    targetIp = result.ip;
    const targetPort = result.port || 34567;
    targetUrl = `local://${targetIp}:${targetPort}`;
  }
  
  // 现在检查文件
  if (files.length === 0) { alert('请先添加文件'); return; }

  // 处理其他目标类型
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
    const parts = val.replace('lan:', '').split(':');
    targetIp = parts[0];
    const targetPort = parseInt(parts[1]) || 34567;
    // 将端口信息添加到targetUrl
    targetUrl = `local://${targetIp}:${targetPort}`;
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

// 扫描局域网设备
async function scanLanDevices() {
  if (btnScanLan) {
    btnScanLan.disabled = true;
    btnScanLan.style.opacity = '0.5';
  }
  
  try {
    const devices = await window.api.scanLanDevices();
    console.log('扫描到的设备:', devices);
    
    if (devices && devices.length > 0) {
      // 更新设备列表
      buildTargetList(destinations, devices);
      alert(`发现 ${devices.length} 个设备！`);
    } else {
      alert('未发现其他设备，请确保其他设备正在运行文件传输应用。');
    }
  } catch (err) {
    console.error('扫描失败:', err);
    alert('扫描失败: ' + err.message);
  } finally {
    if (btnScanLan) {
      btnScanLan.disabled = false;
      btnScanLan.style.opacity = '1';
    }
  }
}

init();
