@echo off
setlocal
cd /d "%~dp0cfd-web"
if not exist "stop.bat" (
  echo Could not find cfd-web\stop.bat
  pause
  exit /b 1
)
call stop.bat %*
exit /b %ERRORLEVEL%
