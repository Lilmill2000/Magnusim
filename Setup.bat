@echo off
setlocal
cd /d "%~dp0magnusim-web"
if not exist "Setup.bat" (
  echo Could not find magnusim-web\Setup.bat
  echo Put this folder next to the magnusim-web directory, or run Setup.bat inside magnusim-web.
  pause
  exit /b 1
)
call Setup.bat %*
exit /b %ERRORLEVEL%
