import Cocoa
import FinderSync

class FinderSync: FIFinderSync {
    
    override init() {
        super.init()
        
        NSLog("[FileTransfer] FinderSync initialized")
        
        // 监听指定的目录（可以是整个用户目录或特定目录）
        let homeURL = URL(fileURLWithPath: NSHomeDirectory())
        FIFinderSyncController.default().directoryURLs = [homeURL]
    }
    
    // MARK: - FIFinderSyncProtocol
    
    // 在Finder中右键菜单中添加选项
    override func menu(for menuKind: FIMenuKind) -> NSMenu? {
        // 只在文件/文件夹的右键菜单中添加选项
        guard menuKind == .contextualMenuForItems else {
            return nil
        }
        
        // 创建菜单
        let menu = NSMenu(title: "")
        let menuItem = NSMenuItem(
            title: "Transfer (文件传输)",
            action: #selector(transferAction(_:)),
            keyEquivalent: ""
        )
        menuItem.image = NSImage(systemSymbolName: "arrow.up.arrow.down", accessibilityDescription: "Transfer")
        menuItem.target = self
        menu.addItem(menuItem)
        
        return menu
    }
    
    // 处理菜单项的点击事件
    @objc func transferAction(_ sender: Any?) {
        NSLog("[FileTransfer] Transfer action triggered")
        
        // 获取选中的文件/文件夹
        guard let items = FIFinderSyncController.default().selectedItemURLs(),
              !items.isEmpty else {
            NSLog("[FileTransfer] No items selected")
            return
        }
        
        // 将选中的文件路径发送给主应用
        let filePaths = items.map { $0.path }
        NSLog("[FileTransfer] Selected items: \(filePaths)")
        
        // 通过NSDistributedNotificationCenter发送通知给主应用
        sendFilesToMainApp(filePaths)
    }
    
    // 发送文件路径给主应用
    private func sendFilesToMainApp(_ filePaths: [String]) {
        // 方法1: 通过分布式通知中心
        let notification = Notification.Name("com.xiamu.filetransfer.addFiles")
        let userInfo = ["filePaths": filePaths]
        
        DistributedNotificationCenter.default().post(
            name: notification,
            object: Bundle.main.bundleIdentifier ?? "com.xiamu.filetransfer.finder-extension",
            userInfo: userInfo
        )
        
        // 方法2: 通过URL Scheme打开主应用
        if let encodedPaths = try? JSONSerialization.data(withJSONObject: filePaths),
           let encodedString = String(data: encodedPaths, encoding: .utf8) {
            let urlString = "filetransfer://add-files?paths=\(encodedString.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")"
            if let url = URL(string: urlString) {
                NSWorkspace.shared.open(url)
            }
        }
        
        // 方法3: 通过共享的UserDefaults
        if let sharedDefaults = UserDefaults(suiteName: "group.com.xiamu.filetransfer") {
            sharedDefaults.set(filePaths, forKey: "pendingFiles")
            sharedDefaults.synchronize()
            NSLog("[FileTransfer] Saved files to shared UserDefaults")
        }
        
        // 方法4: 通过Unix socket或TCP连接
        sendViaSocket(filePaths)
    }
    
    // 通过socket发送文件路径
    private func sendViaSocket(_ filePaths: [String]) {
        // 构建要发送的消息
        let message: [String: Any] = [
            "action": "addFiles",
            "files": filePaths,
            "timestamp": Date().timeIntervalSince1970
        ]
        
        // 将消息转换为JSON
        guard let jsonData = try? JSONSerialization.data(withJSONObject: message) else {
            NSLog("[FileTransfer] Failed to serialize message")
            return
        }
        
        // 创建socket连接
        let host = "127.0.0.1"
        let port: UInt16 = 34569 // 主应用IPC服务器端口
        
        DispatchQueue.global(qos: .background).async {
            // 创建socket
            var stream: OutputStream?
            var readStream: Unmanaged<CFReadStream>?
            var writeStream: Unmanaged<CFWriteStream>?
            
            CFStreamCreatePairWithSocketToHost(
                kCFAllocatorDefault,
                host as CFString,
                UInt32(port),
                &readStream,
                &writeStream
            )
            
            guard let writeStreamUnmanaged = writeStream else {
                NSLog("[FileTransfer] Failed to create output stream")
                return
            }
            
            stream = writeStreamUnmanaged.takeRetainedValue()
            guard let stream = stream else {
                NSLog("[FileTransfer] Stream is nil")
                return
            }
            
            stream.open()
            
            // 发送数据
            let bytesWritten = jsonData.withUnsafeBytes { buffer in
                guard let pointer = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
                    return 0
                }
                return stream.write(pointer, maxLength: jsonData.count)
            }
            
            stream.close()
            
            if bytesWritten > 0 {
                NSLog("[FileTransfer] Sent %d bytes via socket", bytesWritten)
            } else {
                NSLog("[FileTransfer] Failed to send via socket")
            }
        }
    }
}