$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# PowerShell 5.1 defaults to TLS 1.0 — GitHub requires TLS 1.2
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = "hienlh/ppm"
$InstallDir = if ($env:PPM_INSTALL_DIR) { $env:PPM_INSTALL_DIR } else { "$env:USERPROFILE\.ppm\bin" }
$Artifact = "ppm-windows-x64.exe"

Write-Host "Detected: windows/x64"

# Check current version
$Current = ""
if (Test-Path "$InstallDir\ppm.exe") {
    try { $Current = & "$InstallDir\ppm.exe" --version 2>$null } catch {}
}

# Get latest release
Write-Host "Fetching latest release..."
$Release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
$Tag = $Release.tag_name
if (-not $Tag) { Write-Host "Failed to fetch latest release"; exit 1 }
$Latest = $Tag -replace "^v", ""

# Check if upgrade needed
if ($Current -eq $Latest) {
    Write-Host "Already up to date: v$Current"
    exit 0
}
if ($Current) {
    Write-Host "Upgrading: v$Current -> v$Latest"
} else {
    Write-Host "Installing: v$Latest"
}

# Download binary
$Url = "https://github.com/$Repo/releases/download/$Tag/$Artifact"
Write-Host "Downloading $Artifact..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
# curl.exe ships with Windows 10+ and handles redirects/progress natively
& curl.exe -fSL# -o "$InstallDir\ppm.exe" $Url
if ($LASTEXITCODE -ne 0) {
    Write-Host "Download failed. Binary may not be available for this version."
    Write-Host "Try installing via: bunx @hienlh/ppm start"
    exit 1
}

# Show changelog
Write-Host ""
Write-Host "========== Changelog =========="
try {
    $Changelog = Invoke-RestMethod "https://raw.githubusercontent.com/$Repo/$Tag/CHANGELOG.md" -ErrorAction Stop
    if ($Current) {
        $Print = $false
        foreach ($Line in $Changelog -split "`n") {
            if ($Line -match "^## \[(.+?)\]") {
                if ($Matches[1] -eq $Current) { break }
                $Print = $true
            }
            if ($Print) { Write-Host $Line }
        }
    } else {
        $Count = 0
        foreach ($Line in $Changelog -split "`n") {
            if ($Line -match "^## \[") { $Count++ }
            if ($Count -gt 1) { break }
            if ($Count -eq 1) { Write-Host $Line }
        }
    }
} catch {
    Write-Host "(changelog unavailable)"
}
Write-Host "================================"

Write-Host ""
if ($Current) {
    Write-Host "Upgraded ppm v$Current -> v$Latest"
} else {
    Write-Host "Installed ppm v$Latest to $InstallDir\ppm.exe"
}

# Add to PATH
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$InstallDir;$UserPath", "User")
    $env:Path = "$InstallDir;$env:Path"
    Write-Host "Added to PATH. Restart your terminal to use ppm."
}

# Getting started (fresh install)
if (-not $Current) {
    Write-Host ""
    Write-Host "========== Getting Started =========="
    Write-Host "1. Restart your terminal"
    Write-Host "2. Run the setup wizard:"
    Write-Host "     ppm init"
    Write-Host "3. Start the server:"
    Write-Host "     ppm start"
    Write-Host "4. Open in browser:"
    Write-Host "     ppm open"
    Write-Host ""
    Write-Host "For remote access (public URL via Cloudflare tunnel):"
    Write-Host "     ppm start --share"
    Write-Host ""
    Write-Host "Docs: https://github.com/$Repo#readme"
    Write-Host "====================================="
}
