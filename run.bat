@echo off
setlocal
cd /d "%~dp0cfd-web"
if not exist "run.bat" (
  echo Could not find cfd-web\run.bat
  pause
  exit /b 1
)
call run.bat %*
exit /b %ERRORLEVEL%
