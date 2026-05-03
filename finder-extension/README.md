# Finder扩展安装说明

## 概述
本扩展为macOS Finder添加右键菜单功能，允许用户直接从Finder中选择文件或目录并添加到文件传输应用中。

## 安装步骤

### 1. 构建Finder扩展
首先需要构建Finder扩展：

```bash
# 在项目根目录运行
./build-finder-extension.sh
```

### 2. 安装扩展到系统

#### 方法一：通过Xcode（推荐）
1. 打开Xcode
2. 选择 File > Open > 选择 `finder-extension` 目录
3. 等待Xcode加载项目
4. 选择 FinderSync scheme
5. 点击 Run (⌘+R) 按钮
6. Xcode会自动安装并启用扩展

#### 方法二：手动安装
1. 构建扩展后，将 `dist/finder-extension` 目录复制到应用程序包中：
   ```bash
   cp -r dist/finder-extension "dist/mac/文件传输.app/Contents/PlugIns/"
   ```

2. 重新打包应用：
   ```bash
   npm run build:mac
   ```

3. 安装打包后的应用到 `/Applications` 目录

### 3. 启用Finder扩展

1. 打开 **系统设置** (System Settings)
2. 选择 **隐私与安全性** (Privacy & Security)
3. 选择 **扩展** (Extensions)
4. 选择 **Finder 扩展** (Finder Extensions)
5. 找到 **File Transfer** 扩展并启用它

### 4. 授权扩展

1. 首次使用时，系统会提示授权扩展访问文件
2. 选择 **允许** (Allow) 以授予必要权限

## 使用方法

1. 在Finder中选择一个或多个文件/文件夹
2. 右键点击选中的项目
3. 选择 **Transfer (文件传输)** 菜单项
4. 主应用会自动启动并显示选中的文件

## 故障排除

### 右键菜单不显示
1. 检查扩展是否已启用（系统设置 > 隐私与安全性 > 扩展）
2. 重启Finder：`killall Finder`
3. 重新启动应用

### 扩展无法连接到主应用
1. 确保主应用正在运行
2. 检查防火墙设置，确保允许本地连接（127.0.0.1:34569）
3. 查看应用日志文件：`~/Library/Application Support/file-transfer/debug.log`

### 权限问题
1. 确保应用有文件访问权限
2. 在系统设置中检查应用的隐私权限

## 开发说明

### 文件结构
```
finder-extension/
├── FinderSync.swift      # 扩展主代码
├── Info.plist            # 扩展配置
├── FinderSync.entitlements # 权限配置
├── Package.swift         # Swift Package Manager配置
└── README.md            # 本文件
```

### 通信机制
扩展通过以下方式与主应用通信：
1. **TCP Socket**: 连接到 `127.0.0.1:34569` 发送文件路径
2. **分布式通知**: 通过 `NSDistributedNotificationCenter` 发送通知
3. **URL Scheme**: 通过 `filetransfer://` URL方案打开应用
4. **共享UserDefaults**: 通过应用组共享数据

### 调试
1. 在Xcode中运行扩展
2. 打开Console.app查看日志
3. 搜索 `[FileTransfer]` 标签查看扩展日志

## 系统要求
- macOS 12.0 或更高版本
- Xcode 14.0 或更高版本（用于构建）
- Swift 5.9 或更高版本

## 许可证
本扩展与主应用使用相同的许可证。