# File Transfer

跨平台局域网文件传输工具，基于 Electron 构建。

[![GitHub](https://img.shields.io/badge/GitHub-isaveall%2Ffile--transfer-blue?logo=github)](https://github.com/isaveall/file-transfer)
[![Release](https://img.shields.io/github/v/release/isaveall/file-transfer?color=green)](https://github.com/isaveall/file-transfer/releases)
[![License](https://img.shields.io/badge/license-MIT-blue)](#)

## 功能特性

- **多协议支持** — 局域网 TCP/UDP、FTP、SFTP、WebDAV
- **拖拽传输** — 直接拖拽文件/文件夹到窗口即可发送
- **目标管理** — 支持保存和管理多个传输目标，可设为默认
- **深色/浅色主题** — 一键切换，自动记忆偏好
- **macOS Finder 扩展** — 支持 macOS 15+ 右键"打开方式"直接发送文件
- **右键菜单传输** — 开启后可通过系统右键菜单快速传输
- **实时进度** — 传输进度实时显示

## 下载

前往 [Releases](https://github.com/isaveall/file-transfer/releases) 下载：

| 平台 | 安装包 |
|------|--------|
| macOS (Apple Silicon) | `文件传输-1.0.3-arm64.dmg` |
| macOS (Intel) | `文件传输-1.0.3.dmg` |
| Windows (x64) | `文件传输 Setup 1.0.3.exe` |
| Linux | `文件传输-1.0.3.AppImage` |

### macOS 安装
双击 DMG，将应用拖入 Applications 文件夹。

### Windows 安装
运行 `文件传输 Setup 1.0.3.exe`，按提示完成安装。

## 快速开始

### 添加文件

| 方式 | 操作 |
|------|------|
| 拖拽到窗口 | 将文件拖拽到应用窗口的拖放区域 |
| 按钮添加 | 点击 "添加文件" 或 "添加文件夹" 按钮 |
| 右键"打开方式"（macOS） | Finder 中右键文件 → 打开方式 → 文件传输 |
| 拖拽到 Dock（macOS） | 将文件拖到 Dock 上的应用图标 |

### 发送文件
1. 从下拉列表选择目标设备，或手动输入 IP 地址
2. 点击 "发送" 按钮
3. 实时查看传输进度

### 管理传输目标
点击齿轮图标打开目标管理窗口，支持添加：
- 🌐 本地 IP（局域网）
- 📁 FTP
- 🔒 SFTP
- ☁️ WebDAV

## 开发

```bash
# 安装依赖
npm install

# 启动开发
npm start

# 构建
npm run build:mac          # macOS (x64 + arm64)
npm run build:win64        # Windows x64
npx electron-builder --linux  # Linux
```

### macOS Finder 扩展
```bash
npm run build:finder-extension        # 构建扩展
npm run build:mac-with-extension      # 构建应用（含扩展）
```

## 技术栈

- **Electron 33** — 跨平台桌面应用框架
- **ssh2** — SFTP 传输
- **ftp-client** — FTP 传输
- **webdav** — WebDAV 传输
- **basic-ftp** — FTP 底层支持

## 端口说明

| 端口 | 用途 |
|------|------|
| 34567 | TCP 文件传输服务器 |
| 34568 | UDP 设备发现 |
| 34569 | Finder 扩展 IPC（macOS） |

## 许可证

MIT License
