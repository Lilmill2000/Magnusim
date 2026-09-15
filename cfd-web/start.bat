@echo off
setlocal
cd /d "%~dp0"

if not exist "python\.venv\Scripts\python.exe" (
  echo Python environment is missing.
  echo Double-click Setup.bat first ^(one-time install^).
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo Node.js / npm is not on PATH.
  echo Double-click Setup.bat first, or install Node.js LTS from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\vite" (
  echo Installing web app packages...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

set MAGNUSIM_PORT=8082
set CFDDESK_PORT=8082
for /f "usebackq delims=" %%P in (`node --input-type=module -e "import {listenPort} from './scripts/prefs.js'; process.stdout.write(String(listenPort()))"`) do set MAGNUSIM_PORT=%%P
set CFDDESK_PORT=%MAGNUSIM_PORT%
set MAGNUSIM_BOUND_PORT=%MAGNUSIM_PORT%
set CFDDESK_BOUND_PORT=%MAGNUSIM_PORT%

REM A leftover listener makes Vite exit immediately (--strictPort).
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":%MAGNUSIM_PORT%" ^| findstr /C:"LISTENING"') do (
  echo Stopping leftover process on port %MAGNUSIM_PORT% ^(PID %%P^)
  taskkill /PID %%P /F >nul 2>&1
)

REM Never let chokidar fall back to a busy-poll of the tree.
set CHOKIDAR_USEPOLLING=0

echo.
echo Magnusim web app:  http://127.0.0.1:%MAGNUSIM_PORT%
echo Leave this window open, or double-click stop.bat to shut it down.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "for ($i=0; $i -lt 60; $i++) { try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:%MAGNUSIM_PORT%/).StatusCode -eq 200) { Start-Process 'http://127.0.0.1:%MAGNUSIM_PORT%/'; exit 0 } } catch {} Start-Sleep -Seconds 1 }; exit 1"

call npm run dev
if errorlevel 1 pause
