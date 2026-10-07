# Magnusim first-run installer. Called by Setup.bat (do not double-click this file).

# Idempotent: already-installed pieces are skipped. After a WSL reboot, run Setup.bat again.

param(

    [switch]$Elevated,

    # Also build the own Python environments of bundled plugins that declare [python].

    [switch]$Plugins

)



$ErrorActionPreference = 'Stop'

$ProgressPreference = 'SilentlyContinue'



$SetupDir = $PSScriptRoot

$WebRoot = (Resolve-Path (Join-Path $SetupDir '..')).Path

$RepoRoot = (Resolve-Path (Join-Path $WebRoot '..')).Path

$LogDir = Join-Path $WebRoot '.cache\setup'

$LogPath = Join-Path $LogDir $(if ($Elevated) { 'setup-elevated.log' } else { 'setup.log' })

$MagnusimLocal = Join-Path $WebRoot '.magnusim-local.json'
$LegacyLocal = Join-Path $WebRoot '.cfddesk-local.json'
if (Test-Path $MagnusimLocal) { $LocalJson = $MagnusimLocal }
elseif (Test-Path $LegacyLocal) { $LocalJson = $LegacyLocal }
else { $LocalJson = $MagnusimLocal }

$MagnusimReady = Join-Path $WebRoot '.magnusim-ready'
$LegacyReady = Join-Path $WebRoot '.cfddesk-ready'
if (Test-Path $MagnusimReady) { $StampPath = $MagnusimReady }
elseif (Test-Path $LegacyReady) { $StampPath = $LegacyReady }
else { $StampPath = $MagnusimReady }

$PythonDir = Join-Path $WebRoot 'python'

$VenvPython = Join-Path $PythonDir '.venv\Scripts\python.exe'

. (Join-Path $SetupDir 'Port-Settings.ps1')
. (Join-Path $SetupDir 'Install-State.ps1')

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Start-Transcript -Path $LogPath -Append | Out-Null

# What Setup found and what it installed (.cache\setup\installation.json), so uninstall.bat
# can offer to remove only the shared software Setup itself added. A failure here never
# fails Setup: uninstall then keeps all shared software.
$script:RecordOn = $true
function Invoke-Record([scriptblock]$Action) {
    if (-not $script:RecordOn) { return }
    try { . $Action } catch {
        $script:RecordOn = $false
        Write-Host "    Install record not written: $($_.Exception.Message). Uninstall will keep shared software." -ForegroundColor Yellow
    }
}
function Get-DistroObservation {
    $distros = @()
    $lxss = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    if (Test-Path $lxss) {
        foreach ($key in @(Get-ChildItem $lxss -ErrorAction SilentlyContinue)) {
            $name = (Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue).DistributionName
            if ($name) { $distros += @{ name = [string]$name; id = [string]$key.PSChildName } }
        }
    }
    return @{ state = 'observed'; distros = $distros }
}
Invoke-Record { Initialize-InstallState (Join-Path $LogDir 'installation.json') $WebRoot }



function Write-Step([string]$Message) {

    Write-Host ''

    Write-Host "==> $Message" -ForegroundColor Cyan

}



function Write-Ok([string]$Message) {

    Write-Host "    $Message" -ForegroundColor Green

}



function Write-Warn([string]$Message) {

    Write-Host "    $Message" -ForegroundColor Yellow

}



function Test-Admin {

    $id = [Security.Principal.WindowsIdentity]::GetCurrent()

    $p = New-Object Security.Principal.WindowsPrincipal($id)

    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

}

function Enable-WinLongPaths {

    try {

        $cur = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled

        if ([int]$cur -eq 1) { Write-Ok 'Windows long paths already enabled'; return }

    } catch { }

    if (-not (Test-Admin)) { Restart-Elevated 'turn on Windows long paths (paths over 260 characters)' }

    try {

        Set-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -Type DWord

        Write-Ok 'Enabled Windows long paths (over 260 characters)'

    } catch {

        throw "Could not enable Windows long paths: $($_.Exception.Message)"

    }

}



function Restart-Elevated([string]$Why) {

    Write-Host ''

    Write-Host "Windows needs Administrator once to $Why." -ForegroundColor Yellow

    Write-Host 'Approve the UAC prompt, then this window will finish (or ask you to reboot).' -ForegroundColor Yellow

    $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Elevated"

    if ($Plugins) { $arg += ' -Plugins' }

    # One line: a blank line after a backtick continuation ends the command, and
    # -Verb then ran as a command of its own ("The term '-Verb' is not recognized").
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

    try {

        $p = Start-Process -FilePath $ps -Verb RunAs -ArgumentList $arg -Wait -PassThru

    } catch {

        # The prompt was refused, or this account may not approve it (a work PC).
        throw @"
Windows did not give Setup Administrator rights ($($_.Exception.Message)).
Setup needs them once to $Why. Run Setup.bat again and approve the prompt, or, on a
work PC, ask IT to run Setup.bat as Administrator once (or to turn on Windows long
paths and install WSL with Ubuntu-24.04), then run Setup.bat again yourself.
"@

    }

    # What the Administrator window did (it closes when it ends), here and in setup.log.
    $elog = Join-Path $LogDir 'setup-elevated.log'
    if (Test-Path $elog) {
        Write-Host ''
        Write-Host "The Administrator window ended (exit $($p.ExitCode)). Its last lines (all of it: $elog):"
        Get-Content -LiteralPath $elog -Tail 30 | Where-Object { $_ -notmatch '^\*+$|^(Windows PowerShell transcript|Start time|End time|Username|RunAs User|Configuration Name|Machine|Host Application|Process ID|PS[A-Z]|BuildVersion|CLRVersion|WSManStackVersion|PSRemotingProtocolVersion|SerializationVersion)' } | ForEach-Object { Write-Host "    $_" }
    }

    exit $p.ExitCode

}



function Refresh-Path {

    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')

    $user = [Environment]::GetEnvironmentVariable('Path', 'User')

    $env:Path = @($machine, $user) -join ';'

}



function Test-Cmd([string]$Name) {

    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)

}



function Get-FreeGb([string]$Path) {

    $root = [IO.Path]::GetPathRoot((Resolve-Path $Path).Path)

    $drive = Get-PSDrive -Name $root.TrimEnd('\').TrimEnd(':') -ErrorAction SilentlyContinue

    if (-not $drive) { return $null }

    return [math]::Round($drive.Free / 1GB, 1)

}



function Install-WingetId([string]$Id) {

    if (-not (Test-Cmd 'winget')) { return $false }

    $common = @('install', '--id', $Id, '-e', '--accept-package-agreements', '--accept-source-agreements')

    & winget @common --disable-interactivity --scope user | Out-Host

    if ($LASTEXITCODE -eq 0) { Refresh-Path; return $true }

    & winget @common --scope user | Out-Host

    if ($LASTEXITCODE -eq 0) { Refresh-Path; return $true }

    & winget @common | Out-Host

    Refresh-Path

    return $LASTEXITCODE -eq 0

}



function Install-Node {

    Refresh-Path

    Invoke-Record { Begin-Component 'node' (Get-SharedObservation 'node') }

    if ((Test-Cmd 'node') -and ([version]((node -v).TrimStart('v')) -ge [version]'22.12.0')) {

        Write-Ok ("Node.js {0}" -f (node -v))

        return

    }

    Write-Step 'Installing Node.js LTS'

    Invoke-Record { Set-ComponentAttempt 'node' }

    if (Install-WingetId 'OpenJS.NodeJS.LTS') {

        Refresh-Path

        if ((Test-Cmd 'node') -and ([version]((node -v).TrimStart('v')) -ge [version]'22.12.0')) {
            Invoke-Record { Complete-Component 'node' (Get-SharedObservation 'node') }
            Write-Ok ("Node.js {0}" -f (node -v)); return
        }

    }

    $ver = '22.18.0'

    $msi = Join-Path $env:TEMP "cfddesk-node-$ver.msi"

    $url = "https://nodejs.org/dist/v$ver/node-v$ver-x64.msi"

    Write-Host "    Downloading $url"

    Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing

    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait

    Refresh-Path

    if (-not (Test-Cmd 'node')) {

        throw 'Node.js installed but is not on PATH. Close this window, open a new one, and run Setup.bat again.'

    }

    Invoke-Record { Complete-Component 'node' (Get-SharedObservation 'node') }

    Write-Ok ("Node.js {0}" -f (node -v))

}



function Test-PythonOk {

    param([string]$Exe, [string[]]$PrefixArgs = @())

    try {

        $all = @($PrefixArgs) + @('-c', 'import sys; raise SystemExit(0 if (3,10) <= sys.version_info < (3,13) else 1)')

        & $Exe @all 2>$null | Out-Null

        return $LASTEXITCODE -eq 0

    } catch {

        return $false

    }

}



function Resolve-PythonLauncher {

    Refresh-Path

    if (Test-Cmd 'py') {

        foreach ($v in @('3.12', '3.11', '3.10')) {

            if (Test-PythonOk -Exe 'py' -PrefixArgs @("-$v")) { return @('py', "-$v") }

        }

    }

    if (Test-Cmd 'python') {

        $src = (Get-Command python).Source

        if ($src -notmatch 'WindowsApps' -and (Test-PythonOk -Exe 'python')) {

            return @('python')

        }

    }

    return $null

}



function Install-Python {

    Invoke-Record { Begin-Component 'python' (Get-SharedObservation 'python') }

    $found = Resolve-PythonLauncher

    if ($found) {

        Write-Ok ("Python launcher: {0}" -f ($found -join ' '))

        return $found

    }

    Write-Step 'Installing Python 3.12'

    Invoke-Record { Set-ComponentAttempt 'python' }

    if (Install-WingetId 'Python.Python.3.12') {

        Refresh-Path

        $found = Resolve-PythonLauncher

        if ($found) {
            Invoke-Record { Complete-Component 'python' (Get-SharedObservation 'python') }
            Write-Ok 'Python 3.12'; return $found
        }

    }

    $ver = '3.12.10'

    $exe = Join-Path $env:TEMP "cfddesk-python-$ver.exe"

    $url = "https://www.python.org/ftp/python/$ver/python-$ver-amd64.exe"

    Write-Host "    Downloading $url"

    Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing

    Start-Process $exe -ArgumentList '/quiet InstallAllUsers=0 PrependPath=1 Include_test=0 Include_launcher=1' -Wait

    Refresh-Path

    $found = Resolve-PythonLauncher

    if (-not $found) {

        throw 'Python installed but is not on PATH. Close this window and run Setup.bat again.'

    }

    Invoke-Record { Complete-Component 'python' (Get-SharedObservation 'python') }

    Write-Ok 'Python 3.12'

    return $found

}



function Install-NpmPackages {

    Set-Location $WebRoot

    $vite = Join-Path $WebRoot 'node_modules\vite\package.json'

    $vtk = Join-Path $WebRoot 'node_modules\@kitware\vtk.js\package.json'

    if ((Test-Path $vite) -and (Test-Path $vtk)) {

        Write-Ok 'npm packages already installed'

        return

    }

    Write-Step 'Installing web app packages (npm ci)'

    if (-not (Test-Cmd 'npm')) { throw 'npm is not on PATH after Node.js install. Re-run Setup.bat in a new window.' }

    if (Test-Path (Join-Path $WebRoot 'package-lock.json')) {

        & npm.cmd ci --no-fund --no-audit

    } else {

        & npm.cmd install --no-fund --no-audit

    }

    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }

    Write-Ok 'npm packages installed'

}



function Install-PythonVenv([string[]]$PyLauncher) {

    if (Test-Path $VenvPython) {

        & $VenvPython -c "import cfddesk, pyvista, gmsh, scipy" 2>$null

        if ($LASTEXITCODE -eq 0) {

            Write-Ok 'Python environment already ready'

            return

        }

        Write-Warn 'Existing python\.venv is incomplete - repairing'

    }

    Write-Step 'Creating Python environment (CAD, gmsh, VTK). This can take several minutes.'

    Set-Location $PythonDir

    $venvArgs = @()

    if ($PyLauncher.Count -gt 1) { $venvArgs += $PyLauncher[1..($PyLauncher.Count - 1)] }

    $venvArgs += @('-m', 'venv', '.venv')

    & $PyLauncher[0] @venvArgs

    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $VenvPython)) {

        throw 'Failed to create python\.venv'

    }

    & $VenvPython -m pip install --upgrade "pip>=26.2" "setuptools>=83"

    if ($LASTEXITCODE -ne 0) { throw 'pip upgrade failed' }

    $Lock = Join-Path $PythonDir 'requirements.lock'

    if (Test-Path $Lock) {

        & $VenvPython -m pip install -r $Lock

        if ($LASTEXITCODE -ne 0) { throw 'pip install -r requirements.lock failed' }

        & $VenvPython -m pip install -e .

    } else {

        & $VenvPython -m pip install -e .

    }

    if ($LASTEXITCODE -ne 0) { throw 'pip install -e . failed (cfddesk + pyvista + gmsh + scipy + cadquery-ocp)' }

    & $VenvPython -m pip install -e sdk

    if ($LASTEXITCODE -ne 0) { throw 'pip install -e sdk failed (magnusim_sdk)' }

    & $VenvPython -c "import cfddesk, magnusim_sdk, pyvista, gmsh, scipy; print('python-ok')"

    if ($LASTEXITCODE -ne 0) { throw 'Python packages imported with errors' }

    Write-Ok 'Python environment ready'

}



function Get-WslDistroNames {

    $prev = [Console]::OutputEncoding

    try {

        [Console]::OutputEncoding = [Text.Encoding]::Unicode

        $raw = & wsl.exe -l -q 2>$null | Out-String

    } catch {

        return @()

    } finally {

        [Console]::OutputEncoding = $prev

    }

    if (-not $raw) { return @() }

    return @(

        $raw -split '\r?\n' |

            ForEach-Object { ($_ -replace "`0", '').Trim() } |

            Where-Object { $_ -and $_ -notmatch '^(Windows Subsystem|Copyright|Usage)' }

    )

}



function Invoke-WslText([string[]]$WslArgs) {
    # wsl.exe writes its own messages in UTF-16: read them as such. Returns {Code, Text}.
    # What it writes to stderr is text to show, not a failure of this script.
    $ErrorActionPreference = 'Continue'
    $prev = [Console]::OutputEncoding
    $text = ''
    $code = -1
    try {
        [Console]::OutputEncoding = [Text.Encoding]::Unicode
        $text = (& wsl.exe @WslArgs 2>&1 | Out-String) -replace "`0", ''
        $code = $LASTEXITCODE
    } catch {
        $text = $_.Exception.Message
    } finally {
        [Console]::OutputEncoding = $prev
    }
    return [pscustomobject]@{ Code = $code; Text = $text.Trim() }
}

function Test-WslOn {
    # WSL is turned on when Windows has its service (LxssManager: the Windows feature;
    # WSLService: WSL from the Store), or when wsl --status answers. wsl.exe alone says
    # nothing: Windows ships it before WSL is turned on. --status alone is not enough
    # either: on Windows 10 it fails while no distro or WSL 2 kernel is installed yet.
    if (-not (Test-Path (Join-Path $env:SystemRoot 'System32\wsl.exe'))) { return $false }
    if (Get-Service -Name 'LxssManager', 'WSLService' -ErrorAction SilentlyContinue) { return $true }
    return (Invoke-WslText @('--status')).Code -eq 0
}

function Get-BootTime {
    try { return ([datetime](Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToString('o') } catch { return '' }
}

function Read-RebootMarker {
    # What Setup last asked a restart for ("wsl-feature" or "ubuntu") and the boot it asked in.
    $marker = Join-Path $LogDir 'reboot-required.txt'
    if (-not (Test-Path $marker)) { return $null }
    $parts = ((Get-Content -LiteralPath $marker -Raw) -replace "^$([char]0xFEFF)", '').Trim() -split '\|', 2
    return [pscustomobject]@{ Step = $parts[0]; Boot = $(if ($parts.Count -gt 1) { $parts[1] } else { '' }) }
}

function Request-Reboot([string]$Step, [string]$What) {
    Set-Content -Path (Join-Path $LogDir 'reboot-required.txt') -Value "$Step|$(Get-BootTime)" -Encoding utf8
    Write-Host ''
    Write-Host "Windows needs a restart to finish $What." -ForegroundColor Yellow
    Write-Host 'Reboot, then double-click Setup.bat again. It will resume from here.' -ForegroundColor Yellow
    exit 2
}

function Clear-RebootMarker {
    Remove-Item -LiteralPath (Join-Path $LogDir 'reboot-required.txt') -ErrorAction SilentlyContinue
}

function Get-FeatureState([string]$Name) {
    # A Windows feature's state from DISM ("Enabled", "Disabled", "Enable Pending", ...);
    # '' when it cannot be read (DISM needs Administrator).
    try {
        $out = & dism.exe /online /get-featureinfo /featurename:$Name 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0 -and $out -match '(?m)^\s*State\s*:\s*(.+?)\s*$') { return $Matches[1] }
    } catch { }
    return ''
}

function Test-VirtualizationOn {
    # On when the firmware has it on, or a hypervisor already runs (the firmware flag then
    # reads false). $null when Windows does not say.
    try {
        if ((Get-CimInstance Win32_ComputerSystem).HypervisorPresent) { return $true }
        $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
        if ($null -eq $cpu.VirtualizationFirmwareEnabled) { return $null }
        return [bool]$cpu.VirtualizationFirmwareEnabled
    } catch {
        return $null
    }
}

# wsl --update's answer in this run (Ensure-WslUbuntu), for the report.
$script:WslUpdate = $null

function Test-DownloadBlocked([string]$Text) {
    # WinINet errors for a connection that was refused, cut or timed out.
    return $Text -match '0x80072ee[2-7]|0x80072ef[13de]|0x8007274c|0x80072f8f'
}

function Get-WslFixes {
    # What to fix, from what Windows says now.
    $fixes = @()
    $virt = Test-VirtualizationOn
    if ($virt -eq $false) {
        $fixes += "Turn on virtualization in the BIOS/UEFI settings (Intel VT-x or AMD-V, often called 'Virtualization Technology' or 'SVM'). On a work PC, IT may have to."
    }
    $vmp = Get-FeatureState 'VirtualMachinePlatform'
    if ($vmp -and $vmp -ne 'Enabled') {
        $fixes += "Turn on 'Virtual Machine Platform' in Windows Features (it is $vmp), then restart."
    }
    if ($script:WslUpdate -and $script:WslUpdate.Code -ne 0) {
        if (Test-DownloadBlocked $script:WslUpdate.Text) {
            $fixes += 'Let WSL download its update: wsl --update could not reach Microsoft (the connection was cut or timed out, usually a company proxy or firewall). Ask IT to allow it, or install the WSL .msi from https://github.com/microsoft/WSL/releases, then run Setup.bat again.'
        } else {
            $fixes += "Update WSL: wsl --update failed (exit $($script:WslUpdate.Code)). Run 'wsl --update' in a PowerShell window as Administrator, or install the WSL .msi from https://github.com/microsoft/WSL/releases."
        }
    }
    if (-not $fixes.Count) {
        $fixes += "Turn on virtualization in the BIOS and 'Virtual Machine Platform' in Windows Features (on a work PC, ask IT)."
    }
    return $fixes
}

function Get-WslReport {
    # What Windows says about WSL, and what to fix, for an error that has to stop Setup.
    $lines = @()
    foreach ($a in @(@('--status'), @('--version'), @('-l', '-v'))) {
        $r = Invoke-WslText $a
        $lines += "wsl $($a -join ' ') (exit $($r.Code)):"
        $lines += ($r.Text -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -First 6 | ForEach-Object { "  $_" })
    }
    if ($script:WslUpdate) {
        $first = ($script:WslUpdate.Text -split '\r?\n' | Where-Object { $_.Trim() }) -join ' / '
        $lines += "wsl --update (exit $($script:WslUpdate.Code)): $first"
    }
    $svc = @(Get-Service -Name 'LxssManager', 'WSLService' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Name)=$($_.Status)" })
    $lines += "WSL services: $(if ($svc.Count) { $svc -join ', ' } else { 'none' })"
    $vmp = Get-FeatureState 'VirtualMachinePlatform'
    $lines += "Virtual Machine Platform: $(if ($vmp) { $vmp } else { 'unknown (needs Administrator)' })"
    $virt = Test-VirtualizationOn
    $lines += "Virtualization (BIOS): $(if ($virt -eq $true) { 'on' } elseif ($virt -eq $false) { 'off' } else { 'unknown' })"
    $lines += ''
    $lines += 'To fix:'
    $lines += (Get-WslFixes | ForEach-Object { "  - $_" })
    return ($lines -join "`n")
}

function Enable-WslFeature {
    # wsl --install turns WSL on (Windows 10 2004+ and 11). When it cannot (an older
    # wsl.exe, or a policy), turn the two Windows features on directly.
    Write-Step 'Enabling Windows Subsystem for Linux'
    $r = Invoke-WslText @('--install', '--no-distribution')
    if ($r.Text) { Write-Host $r.Text }
    if ($r.Code -eq 0) { return }
    Write-Warn "wsl --install did not turn WSL on (exit $($r.Code)); turning the Windows features on instead"
    foreach ($feature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        $out = & dism.exe /online /enable-feature /featurename:$feature /all /norestart 2>&1 | Out-String
        $code = $LASTEXITCODE
        Write-Host $out.Trim()
        # 3010: done, a restart finishes it.
        if ($code -ne 0 -and $code -ne 3010) {
            throw @"
Windows did not turn on $feature (DISM exit $code).
On a work PC this is often switched off by company policy: ask IT to turn on
'Windows Subsystem for Linux' and 'Virtual Machine Platform' (and virtualization
in the BIOS), then run Setup.bat again.
"@
        }
    }
}

function Test-HasDistro([string]$Name, [string[]]$All) {
    foreach ($d in $All) {
        if ($d -eq $Name) { return $true }
        if ($d -replace '\s+\(.*\)$', '' -eq $Name) { return $true }
    }
    return $false
}

function Ensure-WslUbuntu {
    $wanted = 'Ubuntu-24.04'
    $asked = Read-RebootMarker
    $boot = Get-BootTime
    # A note from Setup before boot times were kept has none: it is never taken as "restarted".
    $sameBoot = $asked -and $asked.Boot -and ($asked.Boot -eq $boot)
    $rebooted = $asked -and $asked.Boot -and ($asked.Boot -ne $boot)

    if (-not (Test-WslOn)) {
        # Asked for a restart to turn WSL on, restarted, and it is still off: say why, never loop.
        if ($asked -and $asked.Step -eq 'wsl-feature' -and $rebooted) {
            throw @"
WSL is still not turned on after the restart. What Windows reports:
$(Get-WslReport)

Then run Setup.bat again. Details: $LogPath
"@
        }
        if ($asked -and $asked.Step -eq 'wsl-feature' -and $sameBoot) {
            Request-Reboot 'wsl-feature' 'turning on WSL (it has not restarted since)'
        }
        if (-not (Test-Admin)) { Restart-Elevated 'turn on the Windows Subsystem for Linux (WSL)' }
        Enable-WslFeature
        Request-Reboot 'wsl-feature' 'turning on WSL'
    }

    Write-Host (Invoke-WslText @('--status')).Text
    Invoke-Record { Begin-Component 'ubuntu' (Get-DistroObservation) }
    $names = Get-WslDistroNames
    if (Test-HasDistro $wanted $names) {
        Write-Ok "WSL distro $wanted is installed"
        Clear-RebootMarker
        return $wanted
    }

    if (-not (Test-Admin)) { Restart-Elevated "install $wanted in WSL" }

    # WSL 2 needs the Virtual Machine Platform feature; WSL's own service can be on without it.
    $vmp = Get-FeatureState 'VirtualMachinePlatform'
    if ($vmp -match 'Pending') {
        if ($asked -and $asked.Step -eq 'vmp' -and $rebooted) {
            throw @"
Virtual Machine Platform is still waiting for a restart ($vmp). What Windows reports:
$(Get-WslReport)
"@
        }
        Request-Reboot 'vmp' 'turning on Virtual Machine Platform'
    }
    if ($vmp -eq 'Disabled') {
        Write-Step 'Turning on Virtual Machine Platform (WSL 2 needs it)'
        $out = & dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart 2>&1 | Out-String
        $code = $LASTEXITCODE
        Write-Host $out.Trim()
        if ($code -ne 0 -and $code -ne 3010) {
            throw @"
Windows did not turn on Virtual Machine Platform (DISM exit $code).
On a work PC this is often switched off by company policy: ask IT to turn on
'Virtual Machine Platform' (and virtualization in the BIOS), then run Setup.bat again.
"@
        }
        Request-Reboot 'vmp' 'turning on Virtual Machine Platform'
    }

    Write-Step "Installing $wanted (one-time, needs Administrator)"
    Invoke-Record { Set-ComponentAttempt 'ubuntu' }
    # Windows 10's own WSL is too old to install current Ubuntu (and has no WSL 2 kernel):
    # wsl --update fetches current WSL from Microsoft.
    $script:WslUpdate = Invoke-WslText @('--update')
    if ($script:WslUpdate.Text) { Write-Host $script:WslUpdate.Text }
    if ($script:WslUpdate.Code -ne 0) {
        $why = if (Test-DownloadBlocked $script:WslUpdate.Text) { ': it could not reach Microsoft (a proxy or firewall?)' } else { '' }
        Write-Warn "wsl --update did not finish (exit $($script:WslUpdate.Code))$why; trying the install anyway"
    }
    $r = Invoke-WslText @('--install', '-d', $wanted, '--no-launch')
    if ($r.Text) { Write-Host $r.Text }
    $installed = $r.Code -eq 0
    if (-not $installed) {
        # An older wsl.exe has no --no-launch; this one opens Ubuntu to make its user.
        Write-Warn "wsl --install -d $wanted --no-launch failed; trying without --no-launch"
        & wsl.exe --install -d $wanted
        $installed = $LASTEXITCODE -eq 0
    }
    Start-Sleep -Seconds 2
    $names = Get-WslDistroNames
    if (Test-HasDistro $wanted $names) {
        Invoke-Record { Complete-Component 'ubuntu' (Get-DistroObservation) }
        Write-Ok "$wanted installed"
        Clear-RebootMarker
        return $wanted
    }

    foreach ($fallback in @('Ubuntu', 'Ubuntu-22.04')) {
        if (Test-HasDistro $fallback $names) {
            Write-Warn "Using existing distro $fallback (preferred $wanted was not installed)"
            return $fallback
        }
    }

    # An install that said it worked can need a restart before the distro is listed: ask
    # once. One that failed gains nothing from a restart: say what to fix instead.
    if ($installed -and -not ($asked -and $asked.Step -eq 'ubuntu' -and $rebooted)) {
        Request-Reboot 'ubuntu' "installing $wanted"
    }

    throw @"
Could not install $wanted. What Windows reports:
$(Get-WslReport)

Then run Setup.bat again. Details: $LogPath
"@
}



function ConvertTo-WslPath([string]$WinPath) {

    $full = [IO.Path]::GetFullPath($WinPath)

    $drive = $full.Substring(0, 1).ToLowerInvariant()

    $rest = $full.Substring(2) -replace '\\', '/'

    return "/mnt/$drive$rest"

}



function Invoke-WslBootstrap([string]$Distro) {

    Write-Step "Installing OpenFOAM v2606 inside $Distro (can take 20-60 minutes the first time)"

    $preferred = ($env:USERNAME -replace '[^A-Za-z0-9_]', '').ToLower()

    if ([string]::IsNullOrWhiteSpace($preferred)) { $preferred = 'cfddesk' }

    if ($preferred -match '^[0-9]') { $preferred = "u$preferred" }



    $src = Join-Path $SetupDir 'wsl-bootstrap.sh'

    $sh = [IO.File]::ReadAllText($src) -replace "`r", ''

    $copy = Join-Path $LogDir 'wsl-bootstrap.sh'

    $utf8 = New-Object System.Text.UTF8Encoding $false

    [IO.File]::WriteAllText($copy, $sh, $utf8)

    $wslSh = ConvertTo-WslPath $copy

    $outLog = Join-Path $LogDir 'wsl-bootstrap.out.log'



    Write-Host "    Waking $Distro..."

    & wsl.exe -d $Distro -u root -- echo ready | Out-Host



    # apt and the installer print warnings on stderr. Windows PowerShell 5.1 turns each
    # redirected stderr line into an error record, and with 'Stop' the first warning
    # (e.g. a legacy apt key) failed Setup. Judge the run by its exit code instead.
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & wsl.exe -d $Distro -u root -- bash $wslSh $preferred 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $outLog | Out-Host
        $bootstrapExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevPref
    }

    if ($bootstrapExit -ne 0) {

        throw "OpenFOAM install inside WSL failed (exit $bootstrapExit). See $outLog"

    }



    $jsonLine = Get-Content -Path $outLog -ErrorAction SilentlyContinue |

        Where-Object { $_.Trim().StartsWith('{') } |

        Select-Object -Last 1

    if (-not $jsonLine) { throw "WSL bootstrap did not print the expected JSON summary. See $outLog" }

    return ($jsonLine | ConvertFrom-Json)

}



function Write-LocalConfig($Distro, $Info) {

    Save-SetupSettings $LocalJson @{

        wsl_distro       = $Distro

        wsl_case_root    = [string]$Info.cases

        wsl_user         = [string]$Info.user

        cartesianMesh    = [string]$Info.cartesianMesh

        openfoam_version = [string]$Info.openfoam_version

        cfmesh_version   = [string]$Info.cfmesh_version

        setup_completed  = (Get-Date).ToUniversalTime().ToString('o')

    }

    Write-Ok "Wrote $LocalJson"

}



function Write-ReadyStamp($Distro, $Info) {

    $nodeV = if (Test-Cmd 'node') { node -v } else { '?' }

    $lines = @(

        "ready=1"

        "node=$nodeV"

        "python=$VenvPython"

        "wsl_distro=$Distro"

        "wsl_case_root=$($Info.cases)"

        "cartesianMesh=$($Info.cartesianMesh)"

        "at=$((Get-Date).ToUniversalTime().ToString('o'))"

    )

    Set-Content -Path $StampPath -Value $lines -Encoding utf8

}



# ---------------------------------------------------------------------------

try {

    Set-Location $WebRoot

    Write-Host ''

    Write-Host 'Magnusim setup' -ForegroundColor White

    Write-Host "App folder: $WebRoot"

    Write-Host "Log:        $LogPath"

    if ($Elevated) { Write-Host 'Running elevated (WSL install).' }

    if (-not $Elevated) { Request-SetupPort $WebRoot }



    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {

        Write-Warn 'This installer targets 64-bit Intel/AMD PCs. OpenFOAM v2606 packages are x86_64.'

    }



    $free = Get-FreeGb $WebRoot

    if ($null -ne $free -and $free -lt 15) {

        Write-Warn "Only ${free} GB free on this drive. OpenFOAM + Node + Python need ~12 GB. Free space if this fails."

    }



    Enable-WinLongPaths

    Install-Node

    $pyLauncher = @(Install-Python)

    Install-NpmPackages

    Install-PythonVenv -PyLauncher $pyLauncher

    if ($Plugins) {

        Write-Step 'Plugin environments (bundled plugins with their own Python packages)'

        & $VenvPython (Join-Path $PythonDir 'tools\plugin_env.py') create-bundled

        if ($LASTEXITCODE -ne 0) { throw 'A bundled plugin environment did not build (its error is above)' }

        Write-Ok 'Plugin environments ready'

    }



    $distro = Ensure-WslUbuntu

    $info = Invoke-WslBootstrap $distro

    Write-LocalConfig $distro $info

    Write-ReadyStamp $distro $info



    if ([string]$info.cartesianMesh -ne 'yes') {

        Write-Warn 'cartesianMesh (cfMesh) was not found. Standard mesh + solve still work. Hex element core will not.'

    }



    Write-Host ''

    Write-Host 'Setup finished.' -ForegroundColor Green

    Write-Host 'Double-click run.bat. The first launch opens a short setup wizard (units and this PC).'

    Write-Host 'Double-click stop.bat when you are done.'

    if ($WebRoot -ne $RepoRoot -and (Test-Path (Join-Path $RepoRoot 'run.bat'))) {

        Write-Host '(Those .bat files are in the same folder as Setup.bat.)'

    }

    exit 0

}

catch {

    Write-Host ''

    Write-Host 'Setup failed.' -ForegroundColor Red

    Write-Host $_.Exception.Message -ForegroundColor Red

    Write-Host "Details: $LogPath"

    # The Administrator window closes when it ends: keep its message on screen.

    if ($Elevated) { Read-Host 'Press Enter to close this window' | Out-Null }

    exit 1

}

finally {

    try { Stop-Transcript | Out-Null } catch {}

}

