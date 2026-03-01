# JS Knowledge Prism — one-command install script for Windows
#
# Usage:
#   irm https://raw.githubusercontent.com/user/js-knowledge-prism/main/install.ps1 | iex
#
# Environment variables:
#   JS_PRISM_DIR    Install directory (default: .\skills)
#   JS_PRISM_FORCE  Set to 1 to skip overwrite confirmation

$ErrorActionPreference = "Stop"

$Repo = "user/js-knowledge-prism"
$SkillId = "js-knowledge-prism"
$DefaultDir = ".\skills"

function Write-Info  { param($msg) Write-Host "[info]  $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "[ok]    $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "[warn]  $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "[error] $msg" -ForegroundColor Red }

# -- Prerequisites -------------------------------------------------------------

try { $null = Get-Command node -ErrorAction Stop }
catch { Write-Err "Node.js is required. Install from https://nodejs.org/"; exit 1 }

try { $null = Get-Command npm -ErrorAction Stop }
catch { Write-Err "npm is required. It ships with Node.js."; exit 1 }

$nodeVer = (node -e "process.stdout.write(process.versions.node)")
$nodeMajor = [int]($nodeVer -split '\.')[0]
if ($nodeMajor -lt 18) {
    Write-Err "Node.js >= 18 required (found $nodeVer)"
    exit 1
}

Write-Info "Node.js $nodeVer detected"

# -- Resolve install directory -------------------------------------------------

$InstallBase = if ($env:JS_PRISM_DIR) { $env:JS_PRISM_DIR } else { $DefaultDir }
$InstallDir = Join-Path $InstallBase $SkillId

if ((Test-Path $InstallDir) -and ($env:JS_PRISM_FORCE -ne "1")) {
    Write-Warn "$InstallDir already exists."
    $ans = Read-Host "Overwrite? [y/N]"
    if ($ans -notin @("y", "Y")) {
        Write-Info "Cancelled."
        exit 0
    }
    Remove-Item -Recurse -Force $InstallDir
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# -- Download ------------------------------------------------------------------

$Tag = ""
try {
    $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -ErrorAction Stop
    $Tag = $release.tag_name
} catch {}

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("kp-install-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

$Downloaded = 0

# Try 1: skill zip from release
if ($Tag) {
    $AssetUrl = "https://github.com/$Repo/releases/download/$Tag/js-knowledge-prism-skill.zip"
    Write-Info "Trying release asset: $AssetUrl"
    try {
        Invoke-WebRequest $AssetUrl -OutFile "$TmpDir\skill.zip" -ErrorAction Stop
        $Downloaded = 1
    } catch {}
}

# Try 2: source archive
if ($Downloaded -eq 0) {
    $SrcUrl = "https://github.com/$Repo/archive/refs/heads/main.zip"
    if ($Tag) { $SrcUrl = "https://github.com/$Repo/archive/refs/tags/$Tag.zip" }
    Write-Info "Trying source archive: $SrcUrl"
    try {
        Invoke-WebRequest $SrcUrl -OutFile "$TmpDir\source.zip" -ErrorAction Stop
        $Downloaded = 2
    } catch {}
}

if ($Downloaded -eq 0) {
    Write-Err "Failed to download from all sources"
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
    exit 1
}

Write-Info "Extracting ..."

if ($Downloaded -eq 1) {
    Expand-Archive -Path "$TmpDir\skill.zip" -DestinationPath $InstallDir -Force
} else {
    $ExtractDir = "$TmpDir\extracted"
    Expand-Archive -Path "$TmpDir\source.zip" -DestinationPath $ExtractDir -Force
    $SrcRoot = (Get-ChildItem -Path $ExtractDir -Directory | Select-Object -First 1).FullName

    foreach ($item in @("SKILL.md", "SECURITY.md", "package.json", "LICENSE")) {
        $src = Join-Path $SrcRoot $item
        if (Test-Path $src) { Copy-Item $src $InstallDir }
    }
    foreach ($dir in @("openclaw-plugin", "lib", "templates")) {
        $src = Join-Path $SrcRoot $dir
        if (Test-Path $src) { Copy-Item -Recurse $src (Join-Path $InstallDir $dir) }
    }
}

Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue

# -- Install dependencies ------------------------------------------------------

if (Test-Path (Join-Path $InstallDir "package.json")) {
    Write-Info "Installing dependencies ..."
    Push-Location $InstallDir
    try {
        npm install --production 2>$null
        if ($LASTEXITCODE -ne 0) { npm install }
    } finally {
        Pop-Location
    }
}

$PluginPath = (Join-Path $InstallDir "openclaw-plugin").Replace("\", "/")

Write-Ok "JS Knowledge Prism installed to $InstallDir"
Write-Host ""
Write-Host "Next steps:"
Write-Host ""
Write-Host "  1. Add to ~/.openclaw/openclaw.json:"
Write-Host ""
Write-Host "     plugins.load.paths: [`"$PluginPath`"]"
Write-Host "     plugins.entries.js-knowledge-prism: { `"enabled`": true }"
Write-Host ""
Write-Host "  2. Restart OpenClaw"
Write-Host "  3. Run: openclaw prism status"
Write-Host ""
