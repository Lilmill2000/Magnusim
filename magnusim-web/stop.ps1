# Stops Magnusim (Vite on the prefs port) and its npm / run.bat wrappers.
# Does not touch other Node apps.
$ErrorActionPreference = 'SilentlyContinue'

function Read-DeskPort {
  $port = 8082
  $candidates = @(
    (Join-Path $PSScriptRoot '.magnusim-local.json'),
    (Join-Path $PSScriptRoot '.cfddesk-local.json')
  )
  foreach ($j in $candidates) {
    if (-not (Test-Path $j)) { continue }
    try {
      $doc = Get-Content -Path $j -Raw -Encoding UTF8 | ConvertFrom-Json
      $n = [int]$doc.port
      if ($n -ge 1024 -and $n -le 65535) { return $n }
    } catch {}
  }
  return $port
}


# Which processes to end: scripts/stop-targets.ps1 (tested with made-up process lists).
. (Join-Path $PSScriptRoot 'scripts\stop-targets.ps1')

$port = Read-DeskPort
Write-Host ("Stopping Magnusim on http://127.0.0.1:{0}" -f $port)

$procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.OwningProcess })
# Only this folder's Vite: another Magnusim copy on this PC (a dev tree, a release, an e2e
# snapshot whose node_modules is a junction to this one) runs its own and must keep running.
$launcher = Join-Path (Split-Path $PSScriptRoot -Parent) 'run.bat'
$roots = @(Get-StopRoots -Procs $procs -Here $PSScriptRoot -Listeners $listeners -Launcher $launcher)

if ($roots.Count -eq 0) {
  if ($listeners.Count) {
    Write-Host ("Port {0} is used by another program, not this folder's Magnusim: left running." -f $port)
    exit 1
  }
  Write-Host 'Magnusim is not running.'
  exit 2
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

Write-Host 'Magnusim stopped.'
exit 0
