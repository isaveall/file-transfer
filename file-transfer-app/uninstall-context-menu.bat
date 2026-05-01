@echo off
chcp 65001 >nul
echo ========================================
echo  文件传输 - 卸载右键菜单
echo ========================================
echo.

echo 正在移除右键菜单...

reg delete "HKEY_CLASSES_ROOT\*\shell\AddToSendList" /f >nul 2>&1
reg delete "HKEY_CLASSES_ROOT\Directory\shell\AddToSendList" /f >nul 2>&1
reg delete "HKEY_CLASSES_ROOT\Directory\Background\shell\AddToSendList" /f >nul 2>&1

echo.
echo [完成] 右键菜单已移除！
echo.
pause
