@echo off
setlocal
cd /d "%~dp0cfd-web"
if not exist "Setup.bat" (
  echo Could not find cfd-web\Setup.bat
  echo Put this folder next to the cfd-web directory, or run Setup.bat inside cfd-web.
  pause
  exit /b 1
)
call Setup.bat %*
exit /b %ERRORLEVEL%
