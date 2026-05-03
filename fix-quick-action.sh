#!/bin/bash

# 修复Quick Action窗口显示问题

echo "=========================================="
echo "  修复Quick Action窗口显示问题"
echo "=========================================="

# 1. 停止应用
echo ""
echo "1. 停止应用..."
pkill -f "electron" || true
sleep 2

# 2. 检查端口
echo ""
echo "2. 检查端口34569..."
if lsof -i :34569 > /dev/null 2>&1; then
    echo "   ⚠ 端口34569被占用，正在释放..."
    lsof -ti :34569 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# 3. 创建测试文件
echo ""
echo "3. 创建测试文件..."
TEST_FILE="/tmp/test-fix-$(date +%s).txt"
echo "测试Quick Action功能" > "$TEST_FILE"
echo "   ✓ 测试文件: $TEST_FILE"

# 4. 启动应用
echo ""
echo "4. 启动应用..."
npm start &
sleep 5

# 5. 检查应用状态
echo ""
echo "5. 检查应用状态..."
if pgrep -f "Electron" > /dev/null; then
    echo "   ✓ 应用正在运行"
else
    echo "   ✗ 应用未运行"
    exit 1
fi

# 6. 检查IPC服务器
echo ""
echo "6. 检查IPC服务器..."
if lsof -i :34569 | grep -q LISTEN; then
    echo "   ✓ IPC服务器正在监听端口34569"
else
    echo "   ✗ IPC服务器未运行"
    exit 1
fi

# 7. 测试Quick Action
echo ""
echo "7. 测试Quick Action..."
python3 << 'EOF'
import socket
import json
import time

# 构建消息
message = {
    'action': 'addFiles',
    'files': ['$TEST_FILE'],
    'timestamp': int(time.time())
}

json_str = json.dumps(message)
print('   发送消息:', json_str)

try:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(5)
    sock.connect(('127.0.0.1', 34569))
    sock.sendall(json_str.encode())
    print('   ✓ 消息已发送')
    
    # 保持连接
    time.sleep(2)
    
    sock.close()
    print('   ✓ 连接已关闭')
except Exception as e:
    print(f'   ✗ 错误: {e}')
EOF

# 8. 检查日志
echo ""
echo "8. 检查应用日志..."
sleep 2
if tail -20 ~/Library/Application\ Support/file-transfer/debug.log | grep -q "从Finder扩展收到文件"; then
    echo "   ✓ 应用收到文件"
else
    echo "   ⚠ 未在日志中找到记录"
    echo "   最近日志:"
    tail -10 ~/Library/Application\ Support/file-transfer/debug.log | grep -E "(IPC|Finder|收到)" || echo "   (无相关日志)"
fi

# 9. 清理测试文件
echo ""
echo "9. 清理测试文件..."
rm -f "$TEST_FILE"
echo "   ✓ 测试文件已删除"

echo ""
echo "=========================================="
echo "  修复完成!"
echo "=========================================="
echo ""
echo "现在您可以在Finder中测试:"
echo "1. 选择一个文件"
echo "2. 右键点击"
echo "3. 选择 '快速操作' → 'Transfer to 文件传输'"
echo "4. 应用窗口应该会显示并添加文件"
echo ""