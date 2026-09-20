@echo off
setlocal
cd /d "%~dp0magnusim-web"
if not exist "stop.bat" (
  echo Could not find magnusim-web\stop.bat
  pause
  exit /b 1
)
call stop.bat %*
exit /b %ERRORLEVEL%
