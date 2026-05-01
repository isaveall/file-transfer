@echo off
chcp 65001 >nul
echo ========================================
echo  文件传输 - 右键菜单安装
echo ========================================
echo.
set APPDIR=%~dp0
set VBSPATH=%APPDIR%add-to-context-menu.vbs
set EXEPATH=%APPDIR%文件传输.exe

:: 检查exe是否存在
if not exist "%EXEPATH%" (
    echo [错误] 未找到 %EXEPATH%
    echo 请先打包应用
    pause
    exit /b 1
)

echo 正在注册右键菜单...

:: 文件右键菜单
reg add "HKEY_CLASSES_ROOT\*\shell\AddToSendList" /ve /d "添加到传输列表" /f >nul
reg add "HKEY_CLASSES_ROOT\*\shell\AddToSendList" /v "Icon" /d "%EXEPATH%,0" /f >nul
reg add "HKEY_CLASSES_ROOT\*\shell\AddToSendList\command" /ve /d "wscript.exe \"%VBSPATH%\" \"%%1\"" /f >nul

:: 文件夹右键菜单
reg add "HKEY_CLASSES_ROOT\Directory\shell\AddToSendList" /ve /d "添加到传输列表" /f >nul
reg add "HKEY_CLASSES_ROOT\Directory\shell\AddToSendList" /v "Icon" /d "%EXEPATH%,0" /f >nul
reg add "HKEY_CLASSES_ROOT\Directory\shell\AddToSendList\command" /ve /d "wscript.exe \"%VBSPATH%\" \"%%1\"" /f >nul

:: 文件夹背景右键菜单
reg add "HKEY_CLASSES_ROOT\Directory\Background\shell\AddToSendList" /ve /d "添加文件到传输列表" /f >nul
reg add "HKEY_CLASSES_ROOT\Directory\Background\shell\AddToSendList" /v "Icon" /d "%EXEPATH%,0" /f >nul
reg add "HKEY_CLASSES_ROOT\Directory\Background\shell\AddToSendList\command" /ve /d "wscript.exe \"%VBSPATH%\" \"%%V\"" /f >nul

echo.
echo [完成] 右键菜单已安装！
echo.
echo 右键点击文件或文件夹即可添加到传输列表
echo.
pause
