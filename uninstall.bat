@echo off
setlocal EnableDelayedExpansion
rem Leave the release folder so Windows can delete it while this window stays open.
cd /d "%TEMP%"
(
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0magnusim-web\setup\Uninstall.ps1"
  set "RESULT=!ERRORLEVEL!"
  pause
  exit /b !RESULT!
)
