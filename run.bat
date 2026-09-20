@echo off
setlocal
cd /d "%~dp0magnusim-web"
if not exist "run.bat" (
  echo Could not find magnusim-web\run.bat
  pause
  exit /b 1
)
call run.bat %*
exit /b %ERRORLEVEL%
