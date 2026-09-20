@echo off
setlocal
cd /d "%~dp0"
if not exist "run.bat" (
  echo Could not find run.bat
  pause
  exit /b 1
)
call run.bat %*
exit /b %ERRORLEVEL%
