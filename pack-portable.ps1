# Build dist/Magnusim-<shortsha>.zip from this repo (the same tree you run).
# git archive only packs committed files; no projects, venv, or cache.
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root

if (-not (Test-Path (Join-Path $Root '.git'))) {
  throw "Not a git repo. Run from CFD root after git init."
}

$sha = (git rev-parse --short HEAD).Trim()
if (-not $sha) { throw "Could not resolve HEAD short sha" }

if (git status --porcelain --untracked-files=normal) {
  throw "The working tree has unpublished changes. Review and commit the intended release first; git archive only packages HEAD."
}

$dist = Join-Path $Root 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$zipName = "Magnusim-$sha.zip"
$zipPath = Join-Path $dist $zipName

if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

# git archive packs tracked files only (respects .gitattributes export-ignore if set)
git archive --format=zip -o $zipPath HEAD
if ($LASTEXITCODE -ne 0) { throw "git archive failed ($LASTEXITCODE)" }

$size = (Get-Item $zipPath).Length
Write-Host "Wrote $zipPath ($([math]::Round($size/1MB, 2)) MB)"
