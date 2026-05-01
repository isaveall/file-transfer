# 文件传输 - 局域网文件传输工具

一款基于 Electron 开发的局域网文件传输工具，支持多种传输协议，操作简单便捷。

![Electron](https://img.shields.io/badge/Electron-33.4-blue)
![Platform](https://img.shields.io/badge/Platform-Windows%2010/11-green)

## ✨ 功能特性

### 传输协议
- 🌐 **局域网传输** - 基于 TCP/UDP，自动发现局域网设备
- 📁 **FTP 上传** - 支持标准 FTP 服务器
- 🔒 **SFTP 上传** - 安全的 SSH 文件传输
- ☁️ **WebDAV 上传** - 支持坚果云等 WebDAV 服务

### 核心功能
- 📂 **文件夹传输** - 保留完整目录结构
- 🔄 **断点续传** - 支持传输中断后继续
- ➖ **移除选中** - 可选择性删除列表中的文件
- 🚫 **取消传输** - 支持随时取消正在进行的传输
- 🎯 **右键菜单** - Windows 资源管理器右键快速添加

## 📦 下载安装

前往 [Releases](https://github.com/isaveall/file-transfer/releases) 下载最新版本。

### 安装右键菜单（可选）

运行程序目录下的 `install.reg` 文件，即可在右键菜单中添加「添加到传输列表」选项。

如需卸载右键菜单，运行 `uninstall.reg`。

## 🚀 使用方法

### 基本操作

1. **添加文件**
   - 点击「添加文件」按钮
   - 或点击「添加文件夹」按钮
   - 或直接拖拽文件/文件夹到窗口
   - 或右键文件 → 「添加到传输列表」

2. **选择目标**
   - 局域网设备：自动发现，选择设备名称
   - FTP/SFTP/WebDAV：在「目标管理」中配置

3. **开始传输**
   - 点击「发送」按钮
   - 查看传输进度和状态
   - 传输完成后自动恢复初始状态

### 目标管理

点击「目标管理」按钮，可以添加/编辑/删除传输目标：

| 类型 | 配置项 |
|------|--------|
| FTP | 主机、端口、用户名、密码、远程路径 |
| SFTP | 主机、端口、用户名、密码、远程路径 |
| WebDAV | URL、用户名、密码 |

## 🔧 开发

### 环境要求

- Node.js 18+
- npm 或 yarn

### 本地运行

```bash
# 克隆仓库
git clone https://github.com/isaveall/file-transfer.git
cd file-transfer

# 安装依赖
npm install

# 运行开发模式
npm start
```

### 打包构建

```bash
# 构建 Windows 安装包
npx electron-builder --win --x64

# 复制额外文件
assets\copy-extras.bat
```

## 📁 项目结构

```
file-transfer/
├── main.js          # 主进程
├── preload.js       # 预加载脚本
├── renderer.js      # 渲染进程（UI逻辑）
├── index.html       # 主窗口
├── styles.css       # 样式文件
├── destinations.*   # 目标管理窗口
├── assets/          # 额外资源文件
│   ├── sendto.vbs   # 右键菜单脚本
│   ├── install.reg  # 注册表安装
│   └── uninstall.reg # 注册表卸载
└── package.json
```

## 🛠️ 技术栈

- **Electron** - 桌面应用框架
- **Node.js** - 后端逻辑
- **ssh2** - SFTP 支持
- **basic-ftp** - FTP 支持
- **webdav** - WebDAV 支持

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

由 [isaveall](https://github.com/isaveall) 开发维护
