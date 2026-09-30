@echo off
setlocal
cd /d "%~dp0"

title Magnusim setup
echo.
echo Magnusim setup
echo This installs Node.js, Python, the app packages, WSL Ubuntu, and OpenFOAM.
echo First run can take 30-90 minutes. Leave this window open.
echo.

rem "Setup.bat -Plugins" also builds the own environments of bundled plugins.
set PSARGS=
set NOPAUSE=
for %%A in (%*) do (
  if /i "%%~A"=="-Plugins" set PSARGS=-Plugins
  if /i "%%~A"=="nopause" set NOPAUSE=1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\Setup.ps1" %PSARGS%
set ERR=%ERRORLEVEL%

echo.
if %ERR%==0 (
  echo You can close this window and double-click run.bat
) else if %ERR%==2 (
  echo Restart Windows, then double-click Setup.bat again.
) else (
  echo Setup did not finish. Scroll up or open .cache\setup\setup.log
)

if defined NOPAUSE exit /b %ERR%
pause
exit /b %ERR%
