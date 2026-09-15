# Magnusim first-run installer. Called by Setup.bat (do not double-click this file).

# Idempotent: already-installed pieces are skipped. After a WSL reboot, run Setup.bat again.

param(

    [switch]$Elevated

)



$ErrorActionPreference = 'Stop'

$ProgressPreference = 'SilentlyContinue'



$SetupDir = $PSScriptRoot

$WebRoot = (Resolve-Path (Join-Path $SetupDir '..')).Path

$RepoRoot = (Resolve-Path (Join-Path $WebRoot '..')).Path

$LogDir = Join-Path $WebRoot '.cache\setup'

$LogPath = Join-Path $LogDir 'setup.log'

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



New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Start-Transcript -Path $LogPath -Append | Out-Null



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



function Restart-Elevated {

    Write-Host ''

    Write-Host 'Windows needs Administrator once to enable WSL / Ubuntu.' -ForegroundColor Yellow

    Write-Host 'Approve the UAC prompt, then this window will finish (or ask you to reboot).' -ForegroundColor Yellow

    $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Elevated"

    $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `

        -Verb RunAs -ArgumentList $arg -Wait -PassThru

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

    if (Test-Cmd 'node') {

        Write-Ok ("Node.js {0}" -f (node -v))

        return

    }

    Write-Step 'Installing Node.js LTS'

    if (Install-WingetId 'OpenJS.NodeJS.LTS') {

        Refresh-Path

        if (Test-Cmd 'node') { Write-Ok ("Node.js {0}" -f (node -v)); return }

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

    $found = Resolve-PythonLauncher

    if ($found) {

        Write-Ok ("Python launcher: {0}" -f ($found -join ' '))

        return $found

    }

    Write-Step 'Installing Python 3.12'

    if (Install-WingetId 'Python.Python.3.12') {

        Refresh-Path

        $found = Resolve-PythonLauncher

        if ($found) { Write-Ok 'Python 3.12'; return $found }

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

    Write-Ok 'Python 3.12'

    return $found

}



function Install-NpmPackages {

    Set-Location $WebRoot

    if ((Test-Path (Join-Path $WebRoot 'node_modules\vite\package.json')) -and `

        (Test-Path (Join-Path $WebRoot 'node_modules\@kitware\vtk.js\package.json'))) {

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

        & $VenvPython -c "import cfddesk, pyvista, gmsh" 2>$null

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

    & $VenvPython -m pip install --upgrade pip

    if ($LASTEXITCODE -ne 0) { throw 'pip upgrade failed' }

    $Lock = Join-Path $PythonDir 'requirements.lock'

    if (Test-Path $Lock) {

        & $VenvPython -m pip install -r $Lock

        if ($LASTEXITCODE -ne 0) { throw 'pip install -r requirements.lock failed' }

        & $VenvPython -m pip install -e . --no-deps

    } else {

        & $VenvPython -m pip install -e .

    }

    if ($LASTEXITCODE -ne 0) { throw 'pip install -e . failed (cfddesk + pyvista + gmsh + cadquery-ocp)' }

    & $VenvPython -c "import cfddesk, pyvista, gmsh; print('python-ok')"

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



function Test-WslExe {

    return Test-Path (Join-Path $env:SystemRoot 'System32\wsl.exe')

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

    if (-not (Test-WslExe)) {

        if (-not (Test-Admin)) { Restart-Elevated }

        Write-Step 'Enabling Windows Subsystem for Linux'

        & wsl.exe --install --no-distribution

        Write-Host ''

        Write-Host 'Windows needs a restart to finish enabling WSL.' -ForegroundColor Yellow

        Write-Host 'Reboot, then double-click Setup.bat again. It will resume from here.' -ForegroundColor Yellow

        Set-Content -Path (Join-Path $LogDir 'reboot-required.txt') -Value 'wsl-feature' -Encoding utf8

        exit 2

    }



    try { & wsl.exe --status | Out-Host } catch {}



    $names = Get-WslDistroNames

    if (Test-HasDistro $wanted $names) {

        Write-Ok "WSL distro $wanted is installed"

        return $wanted

    }



    if (-not (Test-Admin)) { Restart-Elevated }

    Write-Step "Installing $wanted (one-time, needs Administrator)"

    & wsl.exe --install -d $wanted --no-launch

    if ($LASTEXITCODE -ne 0) {

        Write-Warn "wsl --install -d $wanted failed; trying without --no-launch"

        & wsl.exe --install -d $wanted

    }

    Start-Sleep -Seconds 2

    $names = Get-WslDistroNames

    if (Test-HasDistro $wanted $names) {

        Write-Ok "$wanted installed"

        return $wanted

    }

    foreach ($fallback in @('Ubuntu', 'Ubuntu-22.04')) {

        if (Test-HasDistro $fallback $names) {

            Write-Warn "Using existing distro $fallback (preferred $wanted was not installed)"

            return $fallback

        }

    }

    throw @"

Could not install $wanted.

Enable Virtualization in BIOS, turn on 'Virtual Machine Platform' in Windows Features,

then run Setup.bat again. List of distros: $($names -join ', ')

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



    & wsl.exe -d $Distro -u root -- bash $wslSh $preferred 2>&1 | Tee-Object -FilePath $outLog | Out-Host

    if ($LASTEXITCODE -ne 0) {

        throw "OpenFOAM install inside WSL failed (exit $LASTEXITCODE). See $outLog"

    }



    $jsonLine = Get-Content -Path $outLog -ErrorAction SilentlyContinue |

        Where-Object { $_.Trim().StartsWith('{') } |

        Select-Object -Last 1

    if (-not $jsonLine) { throw "WSL bootstrap did not print the expected JSON summary. See $outLog" }

    return ($jsonLine | ConvertFrom-Json)

}



function Write-LocalConfig($Distro, $Info) {

    $doc = [ordered]@{

        wsl_distro       = $Distro

        wsl_case_root    = [string]$Info.cases

        wsl_user         = [string]$Info.user

        cartesianMesh    = [string]$Info.cartesianMesh

        openfoam_version = [string]$Info.openfoam_version

        cfmesh_version   = [string]$Info.cfmesh_version

        setup_completed  = (Get-Date).ToUniversalTime().ToString('o')

    }

    $doc | ConvertTo-Json | Set-Content -Path $LocalJson -Encoding utf8

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



    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {

        Write-Warn 'This installer targets 64-bit Intel/AMD PCs. OpenFOAM v2606 packages are x86_64.'

    }



    $free = Get-FreeGb $WebRoot

    if ($null -ne $free -and $free -lt 15) {

        Write-Warn "Only ${free} GB free on this drive. OpenFOAM + Node + Python need ~12 GB. Free space if this fails."

    }



    Install-Node

    $pyLauncher = @(Install-Python)

    Install-NpmPackages

    Install-PythonVenv -PyLauncher $pyLauncher



    $distro = Ensure-WslUbuntu

    $info = Invoke-WslBootstrap $distro

    Write-LocalConfig $distro $info

    Write-ReadyStamp $distro $info



    if ([string]$info.cartesianMesh -ne 'yes') {

        Write-Warn 'cartesianMesh (cfMesh) was not found. Standard mesh + solve still work. Hex element core will not.'

    }



    Write-Host ''

    Write-Host 'Setup finished.' -ForegroundColor Green

    Write-Host 'Double-click start.bat. The first launch opens a short setup wizard (units, this PC, port).'

    Write-Host 'Double-click stop.bat when you are done.'

    if ($WebRoot -ne $RepoRoot -and (Test-Path (Join-Path $RepoRoot 'start.bat'))) {

        Write-Host "(Those .bat files are in the cfd-web folder.)"

    }

    exit 0

}

catch {

    Write-Host ''

    Write-Host 'Setup failed.' -ForegroundColor Red

    Write-Host $_.Exception.Message -ForegroundColor Red

    Write-Host "Details: $LogPath"

    exit 1

}

finally {

    try { Stop-Transcript | Out-Null } catch {}

}

