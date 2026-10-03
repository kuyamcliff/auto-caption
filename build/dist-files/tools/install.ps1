# AutoCaption AE installer. Per-user, no administrator rights.
# Changes made:
#   1. Copies extension\ to %APPDATA%\Adobe\CEP\extensions\com.autocaption.ae
#   2. Sets PlayerDebugMode=1 under HKCU\Software\Adobe\CSXS.10 .. CSXS.13
#      (After Effects needs it to load a panel installed outside Adobe's
#      marketplace; no other Adobe setting is touched)
#   3. Remembers the engine folder for the panel's first run
param([string]$PackageDir = $PSScriptRoot + "\..")
$ErrorActionPreference = "Stop"
$pkg = (Resolve-Path $PackageDir).Path
Write-Host ""
Write-Host "AutoCaption AE 1.0.0 setup" -ForegroundColor Cyan
Write-Host "Made by cyriqvfx"
Write-Host ""

$found = @()
foreach ($root in @("$env:ProgramFiles\Adobe", "${env:ProgramFiles(x86)}\Adobe")) {
  if (Test-Path $root) {
    Get-ChildItem $root -Directory -Filter "Adobe After Effects*" -ErrorAction SilentlyContinue | ForEach-Object {
      if (Test-Path (Join-Path $_.FullName "Support Files\AfterFX.exe")) { $found += $_.Name }
    }
  }
}
if ($found.Count -gt 0) { Write-Host ("After Effects found: " + ($found -join ", ")) }
else { Write-Host "After Effects was not found in Program Files. Installing anyway." -ForegroundColor Yellow }

$src = Join-Path $pkg "extension"
if (-not (Test-Path (Join-Path $src "CSXS\manifest.xml"))) {
  Write-Host "The extension folder is missing next to this installer. Extract the full download and try again." -ForegroundColor Red
  exit 1
}
$dest = Join-Path $env:APPDATA "Adobe\CEP\extensions\com.autocaption.ae"
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Copy-Item $src $dest -Recurse -Force
Write-Host "Panel installed:  $dest" -ForegroundColor Green

foreach ($v in 10..13) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -PropertyType String -Force | Out-Null
}
Write-Host "After Effects is allowed to load the panel."

$engine = Join-Path $pkg "AutoCaption Engine"
$cfgDir = Join-Path $env:APPDATA "AutoCaptionAE"
$cfg = Join-Path $cfgDir "config.json"
if ((Test-Path (Join-Path $engine "AutoCaption Engine.exe")) -and (Test-Path (Join-Path $engine "engine.pak"))) {
  New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
  $data = @{ version = 1; onboarded = $false }
  if (Test-Path $cfg) {
    try { $data = Get-Content $cfg -Raw | ConvertFrom-Json } catch { }
  }
  $data | Add-Member -NotePropertyName backendDir -NotePropertyValue $engine -Force
  $data | ConvertTo-Json | Set-Content -Path $cfg -Encoding UTF8
  Write-Host "Engine folder:    $engine"
} else {
  Write-Host "The AutoCaption Engine folder was not found next to this installer. The panel will ask for it." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "Restart After Effects, then open Window > Extensions > AutoCaption AE."
