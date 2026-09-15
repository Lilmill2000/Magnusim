@echo off
setlocal
cd /d "%~dp0cfd-web"
if not exist "start.bat" (
  echo Could not find cfd-web\start.bat
  pause
  exit /b 1
)
call start.bat %*
exit /b %ERRORLEVEL%
