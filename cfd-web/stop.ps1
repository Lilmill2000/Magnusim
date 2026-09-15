# Stops CFD Desk (Vite on the prefs port) and its npm / start.bat wrappers.
# Does not touch other Node apps.
$ErrorActionPreference = 'SilentlyContinue'

function Read-DeskPort {
  $port = 8082
  $j = Join-Path $PSScriptRoot '.cfddesk-local.json'
  if (Test-Path $j) {
    try {
      $doc = Get-Content -Path $j -Raw -Encoding UTF8 | ConvertFrom-Json
      $n = [int]$doc.port
      if ($n -ge 1024 -and $n -le 65535) { $port = $n }
    } catch {}
  }
  return $port
}

function Test-AgentWrapper([string]$commandLine) {
  if (-not $commandLine) { return $false }
  return $commandLine -match 'ps-script-|ExecutionPolicy Bypass -NonInteractive -File'
}

function Test-ServerProcess($proc) {
  if (-not $proc) { return $false }
  $name = [string]$proc.Name
  return $name -match '^(cmd\.exe|node\.exe|esbuild\.exe)$'
}

$port = Read-DeskPort
Write-Host ("Stopping CFD Desk on http://127.0.0.1:{0}" -f $port)

$byId = @{}
Get-CimInstance Win32_Process | ForEach-Object { $byId[[int]$_.ProcessId] = $_ }

$seeds = New-Object 'System.Collections.Generic.HashSet[int]'
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { [void]$seeds.Add([int]$_.OwningProcess) }

$here = [regex]::Escape($PSScriptRoot)
Get-CimInstance Win32_Process | ForEach-Object {
  $cl = [string]$_.CommandLine
  if (-not $cl) { return }
  if ($cl -match "$here\\node_modules\\(vite|\\@esbuild)" -or $cl -match 'vite --host 127\.0\.0\.1') {
    [void]$seeds.Add([int]$_.ProcessId)
  }
}

if ($seeds.Count -eq 0) {
  Write-Host 'CFD Desk is not running.'
  exit 2
}

$roots = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($id in @($seeds)) {
  $cur = $id
  $top = $id
  while ($byId.ContainsKey($cur)) {
    $proc = $byId[$cur]
    if (Test-AgentWrapper ([string]$proc.CommandLine)) { break }
    if (-not (Test-ServerProcess $proc)) { break }
    $top = $cur
    $cur = [int]$proc.ParentProcessId
  }
  [void]$roots.Add($top)
}

foreach ($root in $roots) {
  Write-Host ("  stopping PID {0}" -f $root)
  & taskkill.exe /PID $root /T /F | Out-Null
}

Start-Sleep -Milliseconds 400
$left = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($left.Count) {
  Write-Host ("Port {0} is still in use." -f $port)
  exit 1
}

Write-Host 'CFD Desk stopped.'
exit 0
