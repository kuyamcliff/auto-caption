# Runs the backend's real self-test and checks the extension install.
param([string]$PackageDir = $PSScriptRoot + "\..")
$pkg = (Resolve-Path $PackageDir).Path
$exe = Join-Path $pkg "backend\AutoCaptionBackend.exe"
Write-Host ""
Write-Host "AutoCaption AE 1.0.0 - installation check" -ForegroundColor Cyan
Write-Host "------------------------------------------"
$ext = Join-Path $env:APPDATA "Adobe\CEP\extensions\com.autocaption.ae\CSXS\manifest.xml"
if (Test-Path $ext) { Write-Host ("{0,-22} OK" -f "Extension installed") -ForegroundColor Green }
else { Write-Host ("{0,-22} not installed - run INSTALL_EXTENSION.bat" -f "Extension") -ForegroundColor Yellow }
$dbg = (Get-ItemProperty -Path "HKCU:\Software\Adobe\CSXS.12" -Name PlayerDebugMode -ErrorAction SilentlyContinue).PlayerDebugMode
if ($dbg -eq "1") { Write-Host ("{0,-22} OK" -f "Panel loading") -ForegroundColor Green }
else { Write-Host ("{0,-22} not enabled - run INSTALL_EXTENSION.bat" -f "Panel loading") -ForegroundColor Yellow }
if (-not (Test-Path $exe)) { Write-Host "Backend not found at $exe" -ForegroundColor Red; exit 1 }
Write-Host "Running the backend self-test (about 30 seconds)..."
$failed = $false
& $exe --self-test 2>$null | ForEach-Object {
  try { $row = $_ | ConvertFrom-Json } catch { return }
  if ($row.summary) { if (-not $row.summary.ok) { $failed = $true } ; return }
  if ($row.status -eq "running") { return }
  $color = @{ pass = "Green"; fail = "Red"; warn = "Yellow"; info = "Gray" }[$row.status]
  $mark = @{ pass = "OK"; fail = "FAILED"; warn = "LIMITED"; info = "INFO" }[$row.status]
  Write-Host ("{0,-22} {1,-8} {2}" -f $row.label, $mark, $row.detail) -ForegroundColor $color
}
Write-Host ""
if ($failed) { Write-Host "Some checks failed. Replace the backend folder with a fresh copy from the download." -ForegroundColor Red; exit 1 }
Write-Host "Everything is ready." -ForegroundColor Green
