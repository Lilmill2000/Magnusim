param([switch]$Preview)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Install-State.ps1')
$webRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $webRoot '..'))

function Assert-RemovalRoot {
    if ((Split-Path $webRoot -Leaf) -ne 'magnusim-web' -or
        (Split-Path $webRoot) -ne $releaseRoot -or
        -not (Test-Path -LiteralPath (Join-Path $webRoot 'package.json')) -or
        -not (Test-Path -LiteralPath (Join-Path $releaseRoot 'uninstall.bat'))) {
        throw 'Run the uninstaller from the Magnusim release folder.'
    }
    $pkg = Get-Content -LiteralPath (Join-Path $webRoot 'package.json') -Raw | ConvertFrom-Json
    if ($pkg.name -ne 'magnusim-web') { throw 'Unexpected application identity.' }
    # Refuse if this release folder itself is a junction/symlink. OneDrive (and
    # similar) mark ancestor folders as reparse points; those must not block
    # deleting only this folder. Cloud file placeholders inside the tree are
    # also reparse points and are safe to delete with the file.
    $rootItem = Get-Item -LiteralPath $releaseRoot -Force
    if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Linked directory is not safe to remove automatically: $($rootItem.FullName)"
    }
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    $queue.Enqueue($releaseRoot)
    while ($queue.Count) {
        foreach ($item in Get-ChildItem -LiteralPath $queue.Dequeue() -Force) {
            if ($item.PSIsContainer -and $item.LinkType -in @('Junction', 'SymbolicLink')) {
                throw "Linked file/directory found: $($item.FullName). Remove the link manually before uninstalling."
            }
            if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) }
        }
    }
}

function Get-RemovalCandidates($Record) {
    $result = @()
    if (-not $Record -or $Record.schema -ne 1 -or
        $Record.userSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
        $Record.root -ne $webRoot) { return @() }
    foreach ($kind in @('node','python')) {
        $entry = $Record.components[$kind]
        if ($entry -and $entry.attempted -and $entry.status -eq 'complete' -and
            $entry.before.state -eq 'not-detected' -and $entry.after.state -eq 'present') {
            $now = Get-SharedObservation $kind
            # A changed install/version is no longer this installer's removal candidate.
            if ($now.path -eq $entry.after.path -and
                (@($now.apps | Sort-Object) -join '|') -eq (@($entry.after.apps | Sort-Object) -join '|')) {
                $id = if ($kind -eq 'node') { 'OpenJS.NodeJS.LTS' } else { 'Python.Python.3.12' }
                $result += @{ kind = 'winget'; name = $kind; id = $id }
            }
        }
    }
    $entry = $Record.components.ubuntu
    if ($entry -and $entry.attempted -and $entry.status -eq 'complete' -and $entry.before.state -eq 'observed') {
        foreach ($distro in @($entry.after.distros)) {
            if ($distro.name -ne 'Ubuntu-24.04' -or @($entry.before.distros | Where-Object { $_.name -eq $distro.name }).Count) { continue }
            if ($distro.id -notmatch '^\{[0-9a-fA-F-]{36}\}$') { continue }
            $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss\$($distro.id)"
            if ((Test-Path $key) -and (Get-ItemProperty $key).DistributionName -eq $distro.name) {
                $result += @{ kind = 'distro'; name = $distro.name; id = $distro.id }
            }
        }
    }
    return $result
}

function Get-ReleaseHolders([string]$Root) {
    $self = $PID
    $parent = 0
    try { $parent = [int](Get-CimInstance Win32_Process -Filter "ProcessId=$self").ParentProcessId } catch {}
    $prefix = $Root.TrimEnd('\')
    $childPrefix = $prefix + '\'
    return @(Get-CimInstance Win32_Process | Where-Object {
        if ($_.ProcessId -eq $self -or $_.ProcessId -eq $parent) { return $false }
        $exe = [string]$_.ExecutablePath
        $command = [string]$_.CommandLine
        if ($exe -and $exe.StartsWith($childPrefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
        if ($command -and $command.IndexOf($prefix, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
        return $false
    })
}

function Remove-ReleaseFolder([string]$Path) {
    Set-Location $env:TEMP
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $lastError = $null
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            if (-not (Test-Path -LiteralPath $Path)) { return }
        } catch {
            $lastError = $_
        }
        Start-Sleep -Milliseconds (300 * $attempt)
    }
    if (Get-Command cmd.exe -ErrorAction SilentlyContinue) {
        Invoke-LoggedCommand 'cmd.exe' @('/c','rd','/s','/q',$Path) -AllowFailure | Out-Null
        if (-not (Test-Path -LiteralPath $Path)) { return }
    }
    $detail = if ($lastError) { $lastError.Exception.Message } else { "The folder is still present: $Path" }
    throw "$detail Close Setup.bat, run.bat, File Explorer windows showing this folder, and any editor using these files, then rerun uninstall.bat."
}

try {
    Assert-RemovalRoot
    $recordPath = Join-Path $webRoot '.cache\setup\installation.json'
    $record = $null
    if (Test-Path -LiteralPath $recordPath) {
        try { $record = ConvertTo-StateMap (Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json) }
        catch { Write-Warning 'Installation record is unreadable; shared software will be kept.' }
    }
    $candidates = @(Get-RemovalCandidates $record)
    Write-Host "Magnusim uninstall: $releaseRoot"
    Write-Host 'This removes this entire folder, including ALL local projects, results, settings, source, and private dependencies.'
    Write-Host 'Back up projects first. Data stored outside this folder is not removed automatically.'
    Write-Host 'Shared Node.js, Python, WSL and Ubuntu are KEPT unless you explicitly select an eligible component below.'
    Write-Host 'The Windows WSL platform is always retained because other applications may depend on it.'
    if (-not $record) { Write-Host 'No installation record: ownership of existing shared software is unknown.' }
    foreach ($candidate in $candidates) { Write-Host "Optional shared removal candidate: $($candidate.name)" }
    if ($Preview) { Write-Host 'Preview only: nothing changed.'; exit 0 }
    if ((Read-Host 'Type DELETE MAGNUSIM to continue, or Enter to cancel') -cne 'DELETE MAGNUSIM') { exit 0 }
    $holders = @(Get-ReleaseHolders $releaseRoot)
    if ($holders.Count) {
        $names = @($holders | ForEach-Object { "$($_.Name) ($($_.ProcessId))" })
        throw "Other programs are still using this folder. Close Setup.bat, run.bat, and these processes, then rerun uninstall.bat: $($names -join ', ')"
    }
    $auditDir = Join-Path $env:TEMP ('Magnusim-uninstall-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $auditDir | Out-Null
    $script:CommandLog = Join-Path $auditDir 'commands.log'
    if ($record) { Copy-Item -LiteralPath $recordPath -Destination (Join-Path $auditDir 'installation.json') }
    foreach ($candidate in $candidates) {
        Write-Host "Optional: $($candidate.name). Setup did not detect it before installation, but other programs may use it NOW."
        if ($candidate.kind -eq 'distro') {
            Write-Host 'Removing Ubuntu permanently deletes ALL of its Linux files, users, OpenFOAM, and simulations, including data added by other programs.'
        }
        $phrase = 'REMOVE ' + $candidate.name
        if ((Read-Host "Type $phrase to remove it, or Enter to KEEP it") -cne $phrase) { continue }
        # Revalidate identity just before executing a shared removal.
        $stillEligible = @(Get-RemovalCandidates $record | Where-Object { $_.id -eq $candidate.id })
        if (-not $stillEligible.Count) { throw 'Shared component changed; refusing removal.' }
        if ($candidate.kind -eq 'distro') {
            Invoke-LoggedCommand 'wsl.exe' @('--unregister',$candidate.name) | Out-Null
        } else {
            Invoke-LoggedCommand 'winget.exe' @('uninstall','--id',$candidate.id,'--exact','--accept-source-agreements','--disable-interactivity') | Out-Null
        }
    }
    Write-Host 'Any retained Linux distribution still contains its OpenFOAM packages and case data. External projects and system package caches are retained.'
    Write-Host "Uninstall record and command logs: $auditDir"
    # Verify the absolute boundary again immediately before removing only this release.
    Assert-RemovalRoot
    Remove-ReleaseFolder $releaseRoot
    Write-Host 'Magnusim folder removed. Shared software you chose to keep was not removed.'
    exit 0
} catch {
    Write-Host 'Uninstall did not finish.' -ForegroundColor Red
    Write-Host ($_ | Format-List * -Force | Out-String)
    Write-Host 'No further removals will be attempted. Review the error before retrying.'
    exit 1
}
