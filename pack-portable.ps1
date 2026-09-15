# Build dist/CFD-Desk-<shortsha>.zip from git archive (source only; no projects).
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root

if (-not (Test-Path (Join-Path $Root '.git'))) {
  throw "Not a git repo. Run from CFD root after git init."
}

$sha = (git rev-parse --short HEAD).Trim()
if (-not $sha) { throw "Could not resolve HEAD short sha" }

$dist = Join-Path $Root 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$zipName = "CFD-Desk-$sha.zip"
$zipPath = Join-Path $dist $zipName

if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

# git archive packs tracked files only (respects .gitattributes export-ignore if set)
git archive --format=zip -o $zipPath HEAD
if ($LASTEXITCODE -ne 0) { throw "git archive failed ($LASTEXITCODE)" }

$size = (Get-Item $zipPath).Length
Write-Host "Wrote $zipPath ($([math]::Round($size/1MB, 2)) MB)"
