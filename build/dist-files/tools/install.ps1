# AutoCaption AE extension installer. Per-user, no administrator rights.
# Changes made:
#   1. Copies extension\ to %APPDATA%\Adobe\CEP\extensions\com.autocaption.ae
#   2. Sets PlayerDebugMode=1 under HKCU\Software\Adobe\CSXS.10 .. CSXS.13
#      (required by After Effects to load an unsigned CEP panel; no other
#      Adobe setting is touched)
#   3. Remembers the backend folder for the panel's first run (if not set yet)
param([string]$PackageDir = $PSScriptRoot + "\..")
$ErrorActionPreference = "Stop"
$pkg = (Resolve-Path $PackageDir).Path
Write-Host ""
Write-Host "AutoCaption AE 1.0.0 - extension installer" -ForegroundColor Cyan
Write-Host "-------------------------------------------"

# 1. After Effects detection (informational; installing works either way)
$found = @()
foreach ($root in @("$env:ProgramFiles\Adobe", "${env:ProgramFiles(x86)}\Adobe")) {
  if (Test-Path $root) {
    Get-ChildItem $root -Directory -Filter "Adobe After Effects*" -ErrorAction SilentlyContinue | ForEach-Object {
      if (Test-Path (Join-Path $_.FullName "Support Files\AfterFX.exe")) { $found += $_.Name }
    }
  }
}
if ($found.Count -gt 0) { Write-Host ("After Effects found:  " + ($found -join ", ")) }
else { Write-Host "After Effects was not found in Program Files. Installing anyway." -ForegroundColor Yellow }

# 2. Copy extension
$src = Join-Path $pkg "extension"
if (-not (Test-Path (Join-Path $src "CSXS\manifest.xml"))) {
  $zip = Join-Path $pkg "extension.zip"
  if (Test-Path $zip) {
    $src = Join-Path $env:TEMP "AutoCaptionAE-extension"
    if (Test-Path $src) { Remove-Item $src -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $src -Force
    if (Test-Path (Join-Path $src "extension\CSXS")) { $src = Join-Path $src "extension" }
  } else {
    Write-Host "ERROR: the extension folder is missing next to this installer." -ForegroundColor Red
    exit 1
  }
}
$dest = Join-Path $env:APPDATA "Adobe\CEP\extensions\com.autocaption.ae"
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Copy-Item $src $dest -Recurse -Force
Write-Host "Extension installed:  $dest" -ForegroundColor Green

# 3. Allow the unsigned panel to load
foreach ($v in 10..13) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -PropertyType String -Force | Out-Null
}
Write-Host "Enabled loading of unsigned panels (PlayerDebugMode) for CEP 10-13."

# 4. Remember the backend location for first launch
$backend = Join-Path $pkg "backend"
$cfgDir = Join-Path $env:APPDATA "AutoCaptionAE"
$cfg = Join-Path $cfgDir "config.json"
if ((Test-Path (Join-Path $backend "AutoCaptionBackend.exe")) -and -not (Test-Path $cfg)) {
  New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
  @{ version = 1; backendDir = $backend; onboarded = $false } | ConvertTo-Json | Set-Content -Path $cfg -Encoding UTF8
  Write-Host "Backend folder noted: $backend"
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "Restart After Effects, then open  Window > Extensions > AutoCaption AE."
Write-Host "On first launch, confirm the 'backend' folder and click Verify Backend."
