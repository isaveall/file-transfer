// ============================================================
// file-transfer/destinations.js - 目标管理面板 v2 (SFTP 风格)
// ============================================================

const $ = (sel) => document.querySelector(sel);
const destList = $('#destList');
const destEmpty = $('#destEmpty');
const addMenu = $('#addMenu');
const modalOverlay = $('#modalOverlay');

let destinations = [];
let selectedIndex = -1;
let editingId = null;

const typeIcons = { local: '🌐', ftp: '📁', sftp: '🔒', webdav: '☁️' };
const typeLabels = { local: '本地IP', ftp: 'FTP', sftp: 'SFTP', webdav: 'WebDAV' };
const defaultPorts = { local: 34567, ftp: 21, sftp: 22, webdav: 80 };

// ---- 初始化 ----
async function init() {
  $('#btnDestClose').addEventListener('click', () => window.api.destWindowClose());
  $('#btnAddDest').addEventListener('click', toggleAddMenu);
  $('#btnDeleteDest').addEventListener('click', deleteSelected);
  $('#btnEditDest').addEventListener('click', editSelected);
  $('#btnSetDefault').addEventListener('click', setDefaultSelected);
  $('#btnModalCancel').addEventListener('click', closeModal);
  $('#btnModalSave').addEventListener('click', saveModal);
  const btnBrowse = $('#btnBrowseKey');
  if (btnBrowse) btnBrowse.addEventListener('click', browseKeyFile);

  // 菜单项
  document.querySelectorAll('.add-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const type = item.dataset.type;
      addMenu.style.display = 'none';
      openModal(type);
    });
  });

  // 认证方式切换
  const authPwd = $('#authPassword');
  const authKey = $('#authKeyfile');
  if (authPwd) authPwd.addEventListener('change', () => {
    const pr = $('#passwordRow'); const kr = $('#keyfileRow');
    if (pr) pr.style.display = 'flex'; if (kr) kr.style.display = 'none';
  });
  if (authKey) authKey.addEventListener('change', () => {
    const pr = $('#passwordRow'); const kr = $('#keyfileRow');
    if (pr) pr.style.display = 'none'; if (kr) kr.style.display = 'flex';
  });

  // 类型切换 (表单中可能没有这个元素，安全检查)
  const formType = $('#formType');
  if (formType) formType.addEventListener('change', onTypeChange);

  // 点击外部关闭菜单
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.add-menu-wrap')) {
      addMenu.style.display = 'none';
    }
  });

  await loadDestinations();
}

async function loadDestinations() {
  destinations = await window.api.getDestinations();
  renderList();
}

function renderList() {
  destList.querySelectorAll('.dest-item').forEach(el => el.remove());
  if (destinations.length === 0) { destEmpty.style.display = 'flex'; return; }
  destEmpty.style.display = 'none';

  for (let i = 0; i < destinations.length; i++) {
    const d = destinations[i];
    const row = document.createElement('div');
    row.className = 'dest-item' + (i === selectedIndex ? ' selected' : '') + (d.isDefault ? ' default' : '');
    row.dataset.index = i;

    const icon = document.createElement('div');
    icon.className = 'dest-icon';
    icon.textContent = typeIcons[d.type] || '❓';

    const name = document.createElement('div');
    name.className = 'dest-name';
    name.textContent = d.name;
    
    // 如果是默认目标，添加默认标记
    if (d.isDefault) {
      const defaultMark = document.createElement('span');
      defaultMark.className = 'default-mark';
      defaultMark.textContent = '⭐';
      defaultMark.title = '默认目标';
      name.appendChild(defaultMark);
    }

    const url = document.createElement('div');
    url.className = 'dest-url';
    url.textContent = buildUrl(d);

    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(url);
    row.addEventListener('click', () => { selectedIndex = i; renderList(); });
    row.addEventListener('dblclick', () => { selectedIndex = i; editSelected(); });
    destList.appendChild(row);
  }
}

function buildUrl(d) {
  if (d.type === 'local') return `${d.host}:${d.port}`;
  const user = d.user ? `${encodeURIComponent(d.user)}:${encodeURIComponent(d.pass || '')}@` : '';
  
  // 确定协议
  let protocol = d.type;
  if (d.type === 'webdav') {
    // WebDAV 使用 http 或 https
    protocol = d.port === 443 ? 'https' : 'http';
  } else if (d.type === 'ftp' && d.tls && d.tls !== 'none') {
    // FTP 使用 TLS 时使用 ftps
    protocol = 'ftps';
  }
  
  return `${protocol}://${user}${d.host}:${d.port}${d.path || '/'}`;
}

function toggleAddMenu() {
  addMenu.style.display = addMenu.style.display === 'none' ? 'block' : 'none';
}

async function deleteSelected() {
  if (selectedIndex < 0 || selectedIndex >= destinations.length) return;
  destinations = await window.api.deleteDestination(destinations[selectedIndex].id);
  selectedIndex = -1;
  renderList();
}

async function setDefaultSelected() {
  if (selectedIndex < 0 || selectedIndex >= destinations.length) return;
  const selectedDest = destinations[selectedIndex];
  
  // 如果已经是默认目标，则取消默认
  if (selectedDest.isDefault) {
    // 取消默认 - 设置一个不存在的ID
    destinations = await window.api.setDefaultDestination('');
  } else {
    // 设置为默认
    destinations = await window.api.setDefaultDestination(selectedDest.id);
  }
  
  renderList();
}

// ---- 编辑 ----
function editSelected() {
  if (selectedIndex < 0 || selectedIndex >= destinations.length) return;
  const d = destinations[selectedIndex];
  editingId = d.id;

  // 设置弹窗标题和图标
  $('#modalIcon').textContent = typeIcons[d.type] || '❓';
  $('#modalTypeLabel').textContent = (typeLabels[d.type] || d.type).toUpperCase();

  // 填充表单
  $('#formName').value = d.name;
  $('#formHost').value = d.host || '';
  $('#formPort').value = d.port || defaultPorts[d.type] || 22;
  $('#formPath').value = d.path || '/';
  $('#formUser').value = d.user || '';
  $('#formPass').value = d.pass || '';
  $('#formKeyPath').value = d.keyPath || '';

  // 认证方式
  if (d.authType === 'keyfile') {
    $('#authKeyfile').checked = true;
    $('#passwordRow').style.display = 'none';
    $('#keyfileRow').style.display = 'flex';
  } else {
    $('#authPassword').checked = true;
    $('#passwordRow').style.display = 'flex';
    $('#keyfileRow').style.display = 'none';
  }

  // Login 行显示/隐藏
  $('#loginRow').style.display = d.type === 'local' ? 'none' : 'flex';
  $('#authRow').style.display = d.type === 'local' ? 'none' : 'flex';

  // FTP/SFTP特定配置
  if (d.type === 'ftp') {
    // 显示FTP特定配置
    if ($('#ftpConfig')) $('#ftpConfig').style.display = 'block';
    // 显示匿名登录复选框
    if ($('#ftpAnonymous')) $('#ftpAnonymous').parentElement.style.display = 'flex';
    
    // 填充FTP配置
    if ($('#ftpAnonymous')) $('#ftpAnonymous').checked = d.anonymous || false;
    if ($('#ftpMode')) $('#ftpMode').value = d.ftpMode || 'passive';
    if ($('#ftpTls')) $('#ftpTls').value = d.tls || 'none';
  } else if (d.type === 'sftp') {
    // SFTP不需要额外配置，隐藏FTP配置
    if ($('#ftpConfig')) $('#ftpConfig').style.display = 'none';
    // 隐藏匿名登录复选框
    if ($('#ftpAnonymous')) $('#ftpAnonymous').parentElement.style.display = 'none';
  } else {
    // 其他类型隐藏FTP/SFTP配置
    if ($('#ftpConfig')) $('#ftpConfig').style.display = 'none';
    // 隐藏匿名登录复选框
    if ($('#ftpAnonymous')) $('#ftpAnonymous').parentElement.style.display = 'none';
  }

  // 按钮文字
  const lbl = $('#btnSaveLabel');
  if (lbl) lbl.textContent = 'Update';

  modalOverlay.style.display = 'flex';
}

// ---- 新增 ----
function openModal(type) {
  editingId = null;
  type = type || 'sftp';

  $('#modalIcon').textContent = typeIcons[type];
  $('#modalTypeLabel').textContent = typeLabels[type].toUpperCase();

  $('#formName').value = '';
  $('#formHost').value = '';
  $('#formPort').value = defaultPorts[type] || 22;
  $('#formPath').value = '/';
  $('#formUser').value = '';
  $('#formPass').value = '';
  $('#formKeyPath').value = '';

  $('#authPassword').checked = true;
  $('#passwordRow').style.display = type === 'local' ? 'none' : 'flex';
  $('#keyfileRow').style.display = 'none';
  $('#loginRow').style.display = type === 'local' ? 'none' : 'flex';
  $('#authRow').style.display = type === 'local' ? 'none' : 'flex';

    // FTP/SFTP特定配置
    if (type === 'ftp') {
      // 显示FTP特定配置
      if ($('#ftpConfig')) $('#ftpConfig').style.display = 'block';
      // 显示匿名登录复选框
      if ($('#ftpAnonymous')) $('#ftpAnonymous').parentElement.style.display = 'flex';
      
      // 设置默认值
      if ($('#ftpAnonymous')) $('#ftpAnonymous').checked = false;
      if ($('#ftpMode')) $('#ftpMode').value = 'passive';
      if ($('#ftpTls')) $('#ftpTls').value = 'none';
    } else if (type === 'sftp') {
      // SFTP不需要额外配置，隐藏FTP配置
      if ($('#ftpConfig')) $('#ftpConfig').style.display = 'none';
      // 隐藏匿名登录复选框
      if ($('#ftpAnonymous')) $('#ftpAnonymous').parentElement.style.display = 'none';
    } else {
      // 其他类型隐藏FTP/SFTP配置
      if ($('#ftpConfig')) $('#ftpConfig').style.display = 'none';
      // 隐藏匿名登录复选框
      if ($('#ftpAnonymous')) $('#ftpAnonymous').parentElement.style.display = 'none';
    }

  const lbl2 = $('#btnSaveLabel');
  if (lbl2) lbl2.textContent = 'Add';

  modalOverlay.style.display = 'flex';
}

function closeModal() { modalOverlay.style.display = 'none'; }

function onTypeChange() {}

// ---- 浏览密钥文件 ----
async function browseKeyFile() {
  const result = await window.api.selectFiles();
  if (result && result.length > 0) {
    $('#formKeyPath').value = result[0].path;
  }
}

// ---- 保存 ----
async function saveModal() {
  const name = $('#formName').value.trim();
  const host = $('#formHost').value.trim();
  const port = parseInt($('#formPort').value) || 22;
  const path = $('#formPath').value || '/';
  const user = $('#formUser').value;
  const pass = $('#formPass').value;
  const keyPath = $('#formKeyPath').value;
  const authType = $('#authPassword').checked ? 'password' : 'keyfile';

  if (!host) { alert('请输入主机地址'); return; }

  // 判断类型 (根据弹窗标题)
  const typeLabel = $('#modalTypeLabel').textContent;
  const type = Object.entries(typeLabels).find(([k, v]) => v.toUpperCase() === typeLabel.toUpperCase())?.[0] || 'sftp';

  const displayName = name || `${typeLabels[type]} - ${host}`;

  // 创建基础目标对象
  const dest = { name: displayName, type, host, port, path, user, pass, keyPath, authType };

  // 根据类型添加特定配置
  if (type === 'ftp') {
    dest.anonymous = $('#ftpAnonymous') ? $('#ftpAnonymous').checked : false;
    dest.ftpMode = $('#ftpMode') ? $('#ftpMode').value : 'passive';
    dest.tls = $('#ftpTls') ? $('#ftpTls').value : 'none';
  } else if (type === 'sftp') {
    // SFTP不需要额外配置
    dest.tls = 'none';
  }

  if (editingId) {
    destinations = await window.api.updateDestination(editingId, dest);
  } else {
    destinations = await window.api.addDestination(dest);
  }

  closeModal();
  renderList();
}

init().catch(err => {
  console.error('[Dest] init error:', err.message || err);
});
