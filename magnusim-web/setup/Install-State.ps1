# Shared by setup and uninstall. Compatible with Windows PowerShell 5.1.
function ConvertTo-StateMap($Value) {
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $map = @{}
        foreach ($p in $Value.PSObject.Properties) { $map[$p.Name] = ConvertTo-StateMap $p.Value }
        return $map
    }
    if ($Value -is [Array]) { return ,@($Value | ForEach-Object { ConvertTo-StateMap $_ }) }
    return $Value
}

function ConvertTo-PipConstraintFile([string]$RequirementsPath, [string]$ConstraintPath) {
    # pip 26.2+ rejects extras in --constraint files ("Constraints cannot have extras").
    # pip-compile still emits coverage[toml]==... in the lock; keep that for -r installs.
    $lines = foreach ($line in [IO.File]::ReadAllLines($RequirementsPath)) {
        if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) { $line }
        else { [regex]::Replace($line, '^([A-Za-z0-9][A-Za-z0-9_.-]*)\[[^\]]+\]', '$1') }
    }
    $dir = [IO.Path]::GetDirectoryName($ConstraintPath)
    if ($dir) { [IO.Directory]::CreateDirectory($dir) | Out-Null }
    [IO.File]::WriteAllLines($ConstraintPath, [string[]]$lines)
}

function Save-InstallState {
    $script:InstallState.updated = (Get-Date).ToUniversalTime().ToString('o')
    $json = $script:InstallState | ConvertTo-Json -Depth 20
    $tmp = "$script:StatePath.tmp"
    [IO.File]::WriteAllText($tmp, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tmp -Destination $script:StatePath -Force
}

function Initialize-InstallState([string]$Path, [string]$Root) {
    $script:StatePath = $Path
    if (Test-Path -LiteralPath $Path) {
        $script:InstallState = ConvertTo-StateMap ([IO.File]::ReadAllText($Path) | ConvertFrom-Json)
        if ($script:InstallState.schema -ne 1) { throw 'Unsupported installation record. Keep it for diagnosis; do not delete it.' }
        if ($script:InstallState.userSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
            throw 'Setup must run as the same Windows user, including at the administrator prompt.'
        }
    } else {
        $script:InstallState = @{
            schema = 1; created = (Get-Date).ToUniversalTime().ToString('o')
            userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            root = $Root; components = @{}; events = @(); status = 'started'
        }
        Save-InstallState
    }
}

function Invoke-LoggedCommand {
    param([string]$File, [string[]]$Arguments = @(), [switch]$AllowFailure)
    $label = $File + ' ' + (($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' ')
    $header = "[$((Get-Date).ToString('o'))] COMMAND $label (cwd=$PWD)"
    Write-Host $header
    Add-Content -LiteralPath $script:CommandLog -Value $header -Encoding UTF8
    if (-not (Get-Command $File -ErrorAction SilentlyContinue)) {
        $message = "Executable not found: $File"
        Add-Content -LiteralPath $script:CommandLog -Value "$message; EXIT CODE: 127" -Encoding UTF8
        if (-not $AllowFailure) { throw $message }
        return [pscustomobject]@{ ExitCode = 127; Output = $message }
    }
    $oldPreference = $ErrorActionPreference
    try {
        # PS 5.1 treats native stderr as ErrorRecords; stderr alone is not failure.
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = 0
        $lines = @(& $File @Arguments 2>&1 | ForEach-Object {
            $line = $_.ToString()
            Write-Host $line
            Add-Content -LiteralPath $script:CommandLog -Value $line -Encoding UTF8
            $line
        })
        $code = $LASTEXITCODE
        if (-not $?) { if ($code -eq 0) { $code = 1 } }
    } finally { $ErrorActionPreference = $oldPreference }
    Write-Host "EXIT CODE: $code"
    Add-Content -LiteralPath $script:CommandLog -Value "EXIT CODE: $code" -Encoding UTF8
    if ($code -ne 0 -and -not $AllowFailure) { throw "Command failed (exit $code): $label. See $script:CommandLog" }
    return [pscustomobject]@{ ExitCode = $code; Output = ($lines -join "`n") }
}

function Get-SharedObservation([string]$Kind) {
    $pattern = if ($Kind -eq 'node') { '^Node\.js' } else { '^Python ' }
    $command = if ($Kind -eq 'node') { 'node.exe' } else { 'py.exe' }
    $apps = @()
    foreach ($registryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (Test-Path $registryRoot) {
            $apps += @(Get-ItemProperty "$registryRoot\*" -ErrorAction Stop | Where-Object { $_.DisplayName -match $pattern } | ForEach-Object { "$($_.DisplayName) $($_.DisplayVersion)" })
        }
    }
    $cmd = Get-Command $command -ErrorAction SilentlyContinue
    $python = if ($Kind -eq 'python') { Get-Command python.exe -ErrorAction SilentlyContinue }
    $found = [bool]($cmd -or $python -or $apps.Count)
    return @{ state = $(if ($found) { 'present' } else { 'not-detected' }); path = [string]$cmd.Source; apps = $apps }
}

function Begin-Component([string]$Name, $Observation) {
    if (-not $script:InstallState.components.ContainsKey($Name)) {
        $script:InstallState.components[$Name] = @{ before = $Observation; status = 'pending'; attempted = $false }
        Save-InstallState
    }
}

function Set-ComponentAttempt([string]$Name) {
    $script:InstallState.components[$Name].attempted = $true
    $script:InstallState.components[$Name].status = 'in-progress'
    Save-InstallState
}

function Complete-Component([string]$Name, $Observation) {
    $script:InstallState.components[$Name].after = $Observation
    $script:InstallState.components[$Name].status = 'complete'
    Save-InstallState
}
