#!/bin/bash

# 安装Quick Action脚本
# 用户可以在安装应用后运行此脚本来安装右键菜单功能

set -e

echo "=========================================="
echo "  安装文件传输 Quick Action"
echo "=========================================="

# 检查应用是否已安装
APP_PATH="/Applications/文件传输.app"

if [ ! -d "$APP_PATH" ]; then
    echo "⚠️  警告: 未找到应用 $APP_PATH"
    echo "   请先将应用安装到 /Applications 目录"
    echo ""
    read -p "是否继续安装? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

WORKFLOW_NAME="Transfer to 文件传输.workflow"
WORKFLOW_DIR="$HOME/Library/Services/$WORKFLOW_NAME"

echo ""
echo "📁 安装Quick Action..."
echo "   位置: $WORKFLOW_DIR"
echo ""

if [ -d "$WORKFLOW_DIR" ]; then
    echo "🗑️  删除旧版本..."
    rm -rf "$WORKFLOW_DIR"
fi

mkdir -p "$WORKFLOW_DIR/Contents"

# 使用 Python 生成 workflow 文件（自动处理 XML 转义）
python3 - "$WORKFLOW_DIR" << 'PYEOF'
import sys
import os

workflow_dir = sys.argv[1]
contents_dir = os.path.join(workflow_dir, "Contents")

shell_script = r'''#!/bin/bash

QA_LOG="/tmp/file-transfer-quick-action.log"
echo "=== $(date) ===" >> "$QA_LOG"
echo "argc=$#  args=$*" >> "$QA_LOG"

# 收集文件路径
FILE_ARGS=()
if [ $# -gt 0 ]; then
    FILE_ARGS=("$@")
    echo "source=args  count=${#FILE_ARGS[@]}" >> "$QA_LOG"
else
    while IFS= read -r line || [ -n "$line" ]; do
        [ -n "$line" ] && FILE_ARGS+=("$line")
    done
    echo "source=stdin  count=${#FILE_ARGS[@]}" >> "$QA_LOG"
fi

echo "files: ${FILE_ARGS[*]}" >> "$QA_LOG"
[ ${#FILE_ARGS[@]} -eq 0 ] && echo "NO FILES, exit" >> "$QA_LOG" && exit 0

# 如果应用未运行则启动
APP_NAME="文件传输"
if ! pgrep -fl "$APP_NAME" >> "$QA_LOG" 2>&1; then
    echo "App not running, starting..." >> "$QA_LOG"
    open -a "$APP_NAME"
    for i in $(seq 1 30); do
        sleep 0.5
        pgrep -fl "$APP_NAME" > /dev/null 2>&1 && break
    done
    echo "Waiting for IPC server..." >> "$QA_LOG"
    for i in $(seq 1 20); do
        (echo >/dev/tcp/127.0.0.1/34569) 2>/dev/null && break
        sleep 0.5
    done
    sleep 1
fi

python3 -c '
import json,socket,sys,time
log=open("/tmp/file-transfer-quick-action.log","a")
f=sys.argv[1:]
log.write("python: files="+str(f)+"\n")
log.flush()
if not f:sys.exit(0)
m=json.dumps({"action":"addFiles","files":f,"timestamp":int(time.time())})
for i in range(10):
 try:
  s=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
  s.settimeout(3)
  s.connect(("127.0.0.1",34569))
  s.sendall(m.encode("utf-8"))
  s.shutdown(socket.SHUT_WR)
  s.close()
  log.write("python: sent OK\n")
  log.flush()
  sys.exit(0)
 except Exception as e:
  log.write("python: attempt "+str(i)+" failed: "+str(e)+"\n")
  log.flush()
  try:s.close()
  except:pass
  time.sleep(1)
log.write("python: FAILED all attempts\n")
sys.exit(1)
' "${FILE_ARGS[@]}"
echo "=== done exit=$? ===" >> "$QA_LOG"
'''

def xml_escape(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

info_plist = '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key>
\t<string>en</string>
\t<key>CFBundleIdentifier</key>
\t<string>com.xiamu.filetransfer.quickaction</string>
\t<key>CFBundleInfoDictionaryVersion</key>
\t<string>6.0</string>
\t<key>CFBundleName</key>
\t<string>Transfer to 文件传输</string>
\t<key>CFBundlePackageType</key>
\t<string>BNDL</string>
\t<key>CFBundleShortVersionString</key>
\t<string>1.0</string>
\t<key>CFBundleVersion</key>
\t<string>1</string>
\t<key>NSServices</key>
\t<array>
\t\t<dict>
\t\t\t<key>NSMenuItem</key>
\t\t\t<dict>
\t\t\t\t<key>default</key>
\t\t\t\t<string>Transfer to 文件传输</string>
\t\t\t</dict>
\t\t\t<key>NSMessage</key>
\t\t\t<string>runWorkflowAsService</string>
\t\t\t<key>NSSendFileTypes</key>
\t\t\t<array>
\t\t\t\t<string>public.item</string>
\t\t\t</array>
\t\t</dict>
\t</array>
</dict>
</plist>
'''

escaped_script = xml_escape(shell_script)
document_wflow = f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>actions</key>
\t<array>
\t\t<dict>
\t\t\t<key>action</key>
\t\t\t<dict>
\t\t\t\t<key>AMAccepts</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Container</key>
\t\t\t\t\t<string>List</string>
\t\t\t\t\t<key>Optional</key>
\t\t\t\t\t<true/>
\t\t\t\t\t<key>Types</key>
\t\t\t\t\t<array>
\t\t\t\t\t\t<string>com.apple.cocoa.string</string>
\t\t\t\t\t</array>
\t\t\t\t</dict>
\t\t\t\t<key>AMActionVersion</key>
\t\t\t\t<string>2.0.3</string>
\t\t\t\t<key>AMBundleIdentifier</key>
\t\t\t\t<string>com.apple.RunShellScript</string>
\t\t\t\t<key>ActionParameters</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>COMMAND_STRING</key>
\t\t\t\t\t<string>{escaped_script}</string>
\t\t\t\t\t<key>Shell</key>
\t\t\t\t\t<string>/bin/bash</string>
\t\t\t\t\t<key>inputMethod</key>
\t\t\t\t\t<integer>0</integer>
\t\t\t\t</dict>
\t\t\t\t<key>AMProvides</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Container</key>
\t\t\t\t\t<string>List</string>
\t\t\t\t\t<key>Types</key>
\t\t\t\t\t<array>
\t\t\t\t\t\t<string>com.apple.cocoa.string</string>
\t\t\t\t\t</array>
\t\t\t\t</dict>
\t\t\t\t<key>BundleIdentifier</key>
\t\t\t\t<string>com.apple.RunShellScript</string>
\t\t\t\t<key>PassInput</key>
\t\t\t\t<string>as arguments</string>
\t\t\t</dict>
\t\t</dict>
\t</array>
\t<key>connectors</key>
\t<dict/>
\t<key>workflowMetaData</key>
\t<dict>
\t\t<key>applicationBundleID</key>
\t\t<string>com.apple.finder</string>
\t\t<key>workflowTypeIdentifier</key>
\t\t<string>com.apple.Automator.servicesMenuWorkflow</string>
\t</dict>
</dict>
</plist>
'''

with open(os.path.join(contents_dir, "Info.plist"), "w", encoding="utf-8") as f:
    f.write(info_plist)

with open(os.path.join(contents_dir, "document.wflow"), "w", encoding="utf-8") as f:
    f.write(document_wflow)

print("Files generated successfully")
PYEOF

echo "✓ Quick Action安装成功!"
echo ""

echo "🔄 刷新服务缓存..."
/System/Library/CoreServices/pbs -flush 2>/dev/null || true

echo ""
echo "=========================================="
echo "  安装完成!"
echo "=========================================="
echo ""
echo "📋 使用方法:"
echo "   1. 在Finder中选择文件"
echo "   2. 右键点击"
echo "   3. 选择 '快速操作' → 'Transfer to 文件传输'"
echo ""
echo "💡 如果菜单没有显示，请:"
echo "   1. 重启Finder: killall Finder"
echo "   2. 或者在系统设置 → 键盘 → 快捷键 → 服务 中启用"
echo ""
