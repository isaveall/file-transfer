# 文件传输工具 - macOS版

一个功能强大的局域网文件传输工具，支持 macOS Finder 右键菜单集成。

## 主要功能

### 文件传输
- 局域网内快速传输文件
- 支持多种传输协议（TCP、FTP、SFTP、WebDAV）
- 断点续传支持
- 批量文件传输

### Finder 集成
- 右键菜单"打开方式"直接发送文件
- 支持单个文件、多个文件、文件夹
- 拖拽文件到 Dock 图标添加到传输列表
- 自动启动应用并添加文件

### 现代化界面
- Win11 风格设计
- 深色主题
- 响应式布局
- 实时进度显示

## 安装

### 下载 DMG
1. 下载对应架构的 DMG 文件：
   - Intel Mac: `文件传输-1.0.2.dmg`
   - Apple Silicon: `文件传输-1.0.2-arm64.dmg`

2. 双击 DMG，将应用拖入 Applications 文件夹

## 快速开始

### 1. 启动应用
- 从 Applications 文件夹打开"文件传输"
- 应用会在后台启动 IPC 服务，等待文件输入

### 2. 添加文件

**方法1：右键"打开方式"（推荐）**
- 在 Finder 中选择文件
- 右键点击 → 打开方式 → 文件传输
- 文件会自动添加到传输列表

**方法2：拖拽到 Dock 图标**
- 将文件或文件夹拖到 Dock 上的"文件传输"图标
- 应用窗口会弹出并显示已添加的文件

**方法3：拖拽到应用窗口**
- 直接将文件拖拽到应用窗口的拖放区域

**方法4：按钮添加**
- 点击"添加文件"或"添加文件夹"按钮

### 3. 选择目标设备
- 从下拉列表选择目标设备
- 或手动输入 IP 地址

### 4. 开始传输
- 点击"发送"按钮
- 实时查看传输进度

## 开发

### 环境要求
- Node.js 18+
- macOS 12+
- Xcode Command Line Tools

### 安装依赖
```bash
npm install
```

### 开发模式运行
```bash
npm start
```

### 构建应用
```bash
# 构建 Finder 扩展
npm run build:finder-extension

# 构建 macOS 应用（含扩展）
npm run build:mac-with-extension

# 或分步构建
npm run build:finder-extension
npm run build:mac
```

## 项目结构

```
file-transfer/
├── main.js                    # 主进程
├── renderer.js                # 渲染进程
├── preload.js                 # 预加载脚本
├── index.html                 # 主窗口
├── styles.css                 # 样式
├── finder-extension/          # Finder 扩展源码
│   ├── FinderSync.swift
│   ├── Info.plist
│   └── FinderSync.entitlements
├── build-finder-extension.sh  # 扩展构建脚本
├── afterPack.js               # 打包后处理
├── create-quick-action.sh     # Quick Action 创建脚本
└── package.json               # 项目配置
```

## 技术栈

- **Electron** - 桌面应用框架
- **Node.js** - 后端运行时
- **Swift** - Finder 扩展开发
- **ssh2** - SFTP 支持
- **basic-ftp** - FTP 支持
- **webdav** - WebDAV 支持

## 端口使用

| 端口 | 用途 |
|------|------|
| 34567 | TCP 文件传输服务器 |
| 34568 | UDP 设备发现 |
| 34569 | Finder 扩展 IPC |
| 34570+ | TCP 设备发现 |

## 更新日志

### v1.0.2
- 新增 `open-file` 事件处理，支持通过"打开方式"添加文件
- 新增 `CFBundleDocumentTypes`，应用出现在 Finder"打开方式"菜单
- 修复 Finder Sync 扩展构建脚本，自动检测 CPU 架构
- 修复 Automator Service 的 XML 转义问题
- 简化 Service 的 `document.wflow` 结构，兼容 macOS 15

### v1.0.1
- 初始发布
- TCP/UDP 局域网文件传输
- Finder 扩展 IPC 通信
- Finder 右键菜单集成

## 故障排除

### 文件无法添加到传输列表
1. 确认应用已启动（检查菜单栏或 Dock）
2. 检查 IPC 服务端口 34569 是否正常监听：`lsof -i :34569`
3. 查看日志文件：`~/Library/Application Support/file-transfer/debug.log`

### 传输失败
1. 检查网络连接
2. 确认目标设备在线
3. 检查防火墙设置

### 应用无法启动
1. 检查系统版本（需要 macOS 12+）
2. 重新安装应用
3. 查看错误日志

## 许可证

MIT License
