# Opens Magnusim once its server answers: in its own window (Microsoft Edge, else Google
# Chrome, as an app window with a Magnusim profile of its own), else in the default browser.
# Its own profile starts with the browser's defaults, graphics acceleration on, whatever the
# person has set in their own browser: the 3D views and the 2D Wind Tunnel (WebGPU) need the GPU.
# The profile lives in .cache\app-window (machine-local, not in git; uninstall removes it).
# SPDX-License-Identifier: GPL-3.0-or-later
param([int]$Port = 8082)

$url = "http://127.0.0.1:$Port/"
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 $url).StatusCode -eq 200) { $ready = $true; break }
  } catch {}
  Start-Sleep -Seconds 1
}
if (-not $ready) { exit 1 }

$x86 = ${env:ProgramFiles(x86)}
$candidates = @(
  "$x86\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$x86\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) }

$browser = $candidates | Select-Object -First 1
if ($browser) {
  $profileDir = Join-Path $PSScriptRoot '.cache\app-window'
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  Start-Process -FilePath $browser -ArgumentList @(
    "--app=$url",
    "--user-data-dir=`"$profileDir`"",
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized'
  )
} else {
  Start-Process $url
}
exit 0
