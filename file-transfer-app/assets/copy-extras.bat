@echo off
echo Copying extra files to dist...
copy /Y "%~dp0sendto.vbs" "%~dp0..\dist\win-unpacked\sendto.vbs" >nul
copy /Y "%~dp0install.reg" "%~dp0..\dist\win-unpacked\install.reg" >nul
copy /Y "%~dp0uninstall.reg" "%~dp0..\dist\win-unpacked\uninstall.reg" >nul
echo Done!
