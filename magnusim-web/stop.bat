@echo off
setlocal
cd /d "%~dp0"

echo Stopping Magnusim
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
set ERR=%ERRORLEVEL%

echo.
if %ERR%==0 (
  echo Close any open Magnusim browser tab too — vtk.js keeps using the GPU/CPU if that page stays open.
) else if %ERR%==2 (
  echo Nothing to stop.
) else (
  echo Stop failed.
)

if /i "%~1"=="nopause" exit /b %ERR%
pause
exit /b %ERR%
