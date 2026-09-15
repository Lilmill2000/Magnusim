# Build Code\CFD\CFD-Desk: a fresh shareable tree (source + Setup, no projects).
$ErrorActionPreference = 'Stop'
$Src = $PSScriptRoot
$Dst = Join-Path $Src 'CFD-Desk'

if (Test-Path $Dst) {
  Remove-Item -LiteralPath $Dst -Recurse -Force
}
New-Item -ItemType Directory -Path $Dst | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Dst 'cfd-web') | Out-Null

$rootXd = @('.cursor', '.git', 'CFD-Desk', 'cfd-web')
robocopy $Src $Dst /E /NFL /NDL /NJH /NJS /nc /ns /np `
  /XD @($rootXd) /XF 'pack-portable.ps1' | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy root failed ($LASTEXITCODE)" }

$webSrc = Join-Path $Src 'cfd-web'
$webDst = Join-Path $Dst 'cfd-web'
$webXd = @(
  'node_modules', '.venv', '.cache', 'projects', 'dist',
  '__pycache__', 'cfddesk.egg-info', '.git'
)
robocopy $webSrc $webDst /E /NFL /NDL /NJH /NJS /nc /ns /np `
  /XD @($webXd) /XF '.cfddesk-local.json' '.cfddesk-ready' | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy cfd-web failed ($LASTEXITCODE)" }

Get-ChildItem -Path $webDst -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }

@'
This folder is the portable CFD Desk copy.

It has the app source and Setup.bat. It does not include your projects,
node_modules, Python venv, WSL settings, or cache.

1. Copy or zip this whole CFD-Desk folder to another PC.
2. Double-click Setup.bat (first run 30-90 minutes).
3. Double-click start.bat. The first-run wizard sets units, hardware, and port.
'@ | Set-Content -Path (Join-Path $Dst 'START-HERE.txt') -Encoding UTF8

Write-Host "Wrote $Dst"
