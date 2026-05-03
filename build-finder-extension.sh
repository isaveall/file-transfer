#!/bin/bash

# Finder扩展构建脚本 v2
# 使用更可靠的方法编译Finder扩展

set -e

echo "=========================================="
echo "  Finder扩展构建脚本 v2"
echo "=========================================="

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 检查是否在macOS上运行
if [[ "$(uname)" != "Darwin" ]]; then
    echo -e "${RED}错误: Finder扩展只能在macOS上构建${NC}"
    exit 1
fi

# 获取路径
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"
SRC_DIR="$PROJECT_DIR/finder-extension"
BUILD_DIR="$PROJECT_DIR/build/finder-extension"
DIST_DIR="$PROJECT_DIR/dist"

echo ""
echo "📁 项目目录: $PROJECT_DIR"
echo "📁 源码目录: $SRC_DIR"
echo "📁 构建目录: $BUILD_DIR"
echo "📁 输出目录: $DIST_DIR"
echo ""

# 清理
echo "🧹 清理旧文件..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
mkdir -p "$DIST_DIR"

# 创建.appex包结构
APP_NAME="FileTransferFinderExtension"
APP_DIR="$BUILD_DIR/${APP_NAME}.appex"

echo "📦 创建扩展包结构..."
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# 创建Info.plist
cat > "$APP_DIR/Contents/Info.plist" << 'PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>File Transfer Extension</string>
	<key>CFBundleExecutable</key>
	<string>FileTransferFinderExtension</string>
	<key>CFBundleIdentifier</key>
	<string>com.xiamu.filetransfer.finder-extension</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>FileTransferFinderExtension</string>
	<key>CFBundlePackageType</key>
	<string>XPC!</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>NSExtension</key>
	<dict>
		<key>NSExtensionPointIdentifier</key>
		<string>com.apple.FinderSync</string>
		<key>NSExtensionPrincipalClass</key>
		<string>FIFinderSync</string>
	</dict>
	<key>NSHumanReadableCopyright</key>
	<string>Copyright © 2026 File Transfer. All rights reserved.</string>
</dict>
</plist>
PLIST_EOF

# 检查Swift源文件
SWIFT_FILE="$SRC_DIR/FinderSync.swift"
if [ ! -f "$SWIFT_FILE" ]; then
    echo -e "${RED}错误: 未找到源文件 $SWIFT_FILE${NC}"
    exit 1
fi

echo "✓ 找到源文件: $SWIFT_FILE"

# 获取SDK路径
SDK_PATH=$(xcrun --show-sdk-path)
echo "📱 SDK路径: $SDK_PATH"

# 编译Swift代码
echo ""
echo "🔨 编译Finder扩展..."
echo ""

OUTPUT_BIN="$APP_DIR/Contents/MacOS/FileTransferFinderExtension"

# 使用swiftc编译（自动检测架构）
HOST_ARCH=$(uname -m)
swiftc \
    -target ${HOST_ARCH}-apple-macosx12.0 \
    -sdk "$SDK_PATH" \
    -framework Cocoa \
    -framework FinderSync \
    -O \
    -whole-module-optimization \
    -module-name FileTransferFinderExtension \
    -emit-executable \
    -o "$OUTPUT_BIN" \
    "$SWIFT_FILE" 2>&1

if [ $? -ne 0 ]; then
    echo -e "${RED}编译失败${NC}"
    exit 1
fi

# 检查可执行文件
if [ ! -f "$OUTPUT_BIN" ]; then
    echo -e "${RED}错误: 可执行文件未生成${NC}"
    exit 1
fi

echo -e "${GREEN}✓ 编译成功${NC}"
echo "   可执行文件: $OUTPUT_BIN"
echo "   文件大小: $(du -h "$OUTPUT_BIN" | cut -f1)"

# 创建Entitlements
cat > "$APP_DIR/Contents/$APP_NAME.entitlements" << 'ENT_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.app-sandbox</key>
	<true/>
	<key>com.apple.security.files.user-selected.read-only</key>
	<true/>
	<key>com.apple.security.network.client</key>
	<true/>
</dict>
</plist>
ENT_EOF

# 复制到dist目录
echo ""
echo "📦 复制到输出目录..."
cp -r "$APP_DIR" "$DIST_DIR/"

echo -e "${GREEN}✓ Finder扩展构建成功!${NC}"
echo ""
echo "扩展位置: $DIST_DIR/${APP_NAME}.appex"
echo ""

# 验证扩展结构
echo "📋 扩展结构:"
find "$DIST_DIR/${APP_NAME}.appex" -type f | head -10

echo ""
echo "=========================================="
echo "  构建完成!"
echo "=========================================="
echo ""
echo "下一步:"
echo "1. 运行 'npm run build:mac' 构建DMG"
echo "2. 安装应用到 /Applications"
echo "3. 运行 'pluginkit -e use -i com.xiamu.filetransfer.finder-extension' 注册扩展"
echo "4. 在系统设置中启用扩展"
echo ""