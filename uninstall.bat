@echo off
rem Leave the release folder so Windows can delete it while this window stays open.
cd /d "%TEMP%"
rem One block: cmd reads a .bat file line by line, and this one is deleted inside the block.
rem (goto) leaves the deleted batch before cmd looks for another line in it; the exit code stays.
(
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0magnusim-web\setup\Uninstall.ps1"
  call set "MAGNUSIM_UNINSTALL_RESULT=%%ERRORLEVEL%%"
  pause
  (goto) 2>nul & call exit /b %%MAGNUSIM_UNINSTALL_RESULT%%
)
