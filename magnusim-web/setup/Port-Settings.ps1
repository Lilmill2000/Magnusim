# Shared setup settings helpers. Write UTF-8 without BOM for the Node JSON reader.
function Get-SetupLocalPath([string]$WebRoot) {
    foreach ($name in @('.magnusim-local.json','.cfddesk-local.json')) {
        $path = Join-Path $WebRoot $name
        if (Test-Path -LiteralPath $path) { return $path }
    }
    return Join-Path $WebRoot '.magnusim-local.json'
}

function Save-SetupSettings([string]$Path, [System.Collections.IDictionary]$Patch) {
    $doc = @{}
    if (Test-Path -LiteralPath $Path) {
        $existing = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
        foreach ($property in $existing.PSObject.Properties) { $doc[$property.Name] = $property.Value }
    }
    foreach ($key in $Patch.Keys) { $doc[$key] = $Patch[$key] }
    [IO.File]::WriteAllText($Path, ($doc | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
}

function Request-SetupPort([string]$WebRoot) {
    $path = Get-SetupLocalPath $WebRoot
    $defaultPort = 8082
    if (Test-Path -LiteralPath $path) {
        $doc = [IO.File]::ReadAllText($path) | ConvertFrom-Json
        $saved = 0
        if ([int]::TryParse([string]$doc.port, [ref]$saved) -and $saved -ge 1024 -and $saved -le 65535) { $defaultPort = $saved }
    }
    Write-Host 'Choose the local port for Magnusim before installation begins.'
    while ($true) {
        $answer = (Read-Host "Port [$defaultPort] - press Enter to keep this port").Trim()
        $port = $defaultPort
        if ($answer -and (-not [int]::TryParse($answer, [ref]$port) -or $port -lt 1024 -or $port -gt 65535)) {
            Write-Host 'Enter a whole number from 1024 to 65535.' -ForegroundColor Yellow
            continue
        }
        Save-SetupSettings $path @{ port = $port }
        Write-Host "Saved port $port. run.bat will open http://127.0.0.1:$port"
        return $port
    }
}
