const fs = require('fs');
const path = require('path');
const os = require('os');

exports.default = async function(context) {
    console.log('AfterPack: 处理扩展...');
    
    // 获取应用路径
    const appOutDir = context.appOutDir;
    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(appOutDir, `${appName}.app`);
    
    console.log(`应用路径: ${appPath}`);
    
    // 检查Finder扩展（如果存在）
    const extensionSrc = path.join(__dirname, 'dist', 'FileTransferFinderExtension.appex');
    
    if (fs.existsSync(extensionSrc)) {
        // 创建PlugIns目录
        const pluginsDir = path.join(appPath, 'Contents', 'PlugIns');
        if (!fs.existsSync(pluginsDir)) {
            fs.mkdirSync(pluginsDir, { recursive: true });
        }
        
        // 复制扩展
        const extensionDest = path.join(pluginsDir, 'FileTransferFinderExtension.appex');
        
        function copyDir(src, dest) {
            if (!fs.existsSync(dest)) {
                fs.mkdirSync(dest, { recursive: true });
            }
            
            const entries = fs.readdirSync(src, { withFileTypes: true });
            
            for (let entry of entries) {
                const srcPath = path.join(src, entry.name);
                const destPath = path.join(dest, entry.name);
                
                if (entry.isDirectory()) {
                    copyDir(srcPath, destPath);
                } else {
                    fs.copyFileSync(srcPath, destPath);
                }
            }
        }
        
        copyDir(extensionSrc, extensionDest);
        console.log(`✓ Finder扩展已安装到: ${extensionDest}`);
    }
};