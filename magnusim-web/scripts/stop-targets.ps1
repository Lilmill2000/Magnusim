# Which processes stop.bat ends (stop.ps1 dot-sources this; scripts/__tests__/stop-targets.test.mjs
# feeds it made-up process lists). Only this folder's own app server and the wrappers that
# started it: never another copy's. A copy can reach this folder's node_modules through a
# junction (an e2e snapshot), so its esbuild's command line names this folder too: a process
# is this app's only when it is this folder's Vite (vite\bin\vite.js under this folder), and
# the walk up goes only through the wrappers run.bat and npm put above that Vite.

# An agent's PowerShell wrapper: never walked through.
function Test-AgentWrapper([string]$CommandLine) {
  if (-not $CommandLine) { return $false }
  return $CommandLine -match 'ps-script-|ExecutionPolicy Bypass -NonInteractive -File'
}

# This folder's Vite server.
function Test-OwnVite($Proc, [string]$Here) {
  $cl = [string]$Proc.CommandLine
  if (-not $cl -or [string]$Proc.Name -ne 'node.exe') { return $false }
  if ($cl -match 'run_foam_case\.py') { return $false }
  if ($cl.IndexOf($Here, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  return $cl -match 'vite[\\/]+bin[\\/]+vite\.js'
}

# A wrapper above this app's Vite: npm's "run dev" (node npm-cli.js and its cmd /c vite), or
# run.bat (this folder's, or the launcher one folder up). $Here ends in a backslash.
function Test-OwnWrapper($Proc, [string]$Here, [string]$Launcher) {
  $cl = [string]$Proc.CommandLine
  $name = [string]$Proc.Name
  if (-not $cl -or (Test-AgentWrapper $cl)) { return $false }
  if ($name -eq 'cmd.exe') {
    if ($cl -match '(^|[\s"])vite(\.cmd)?"?\s+--host') { return $true }
    if ($cl -match 'npm(\.cmd)?"?\s+run\s+dev') { return $true }
    # Joined by hand: Join-Path would write '/' where PowerShell runs off Windows (the test on CI).
    foreach ($bat in @(($Here + 'run.bat'), $Launcher)) {
      if ($bat -and $cl.IndexOf($bat, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
  }
  if ($name -eq 'node.exe') {
    return $cl -match 'npm-cli\.js"?\s+run\s+dev'
  }
  return $false
}

# The PIDs to end (each with its whole tree): the top of the wrapper chain above the Vite that
# listens on the app's port, when that Vite is this folder's.
function Get-StopRoots {
  param(
    [object[]]$Procs,
    [string]$Here,
    [int[]]$Listeners = @(),
    [string]$Launcher = ''
  )
  $here = $Here.TrimEnd('\') + '\'
  $byId = @{}
  foreach ($p in $Procs) { $byId[[int]$p.ProcessId] = $p }
  # Only the Vite on the app's own port: the e2e servers other sessions start from this
  # folder run the same "npm run dev", on ports of their own.
  $seeds = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($id in $Listeners) {
    if ($byId.ContainsKey([int]$id) -and (Test-OwnVite $byId[[int]$id] $here)) { [void]$seeds.Add([int]$id) }
  }
  $roots = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($id in @($seeds)) {
    $top = $id
    $cur = [int]$byId[$id].ParentProcessId
    $seen = 0
    while ($byId.ContainsKey($cur) -and $seen -lt 16) {
      $parent = $byId[$cur]
      if (-not (Test-OwnWrapper $parent $here $Launcher)) { break }
      $top = $cur
      $cur = [int]$parent.ParentProcessId
      $seen++
    }
    [void]$roots.Add($top)
  }
  return @($roots)
}
