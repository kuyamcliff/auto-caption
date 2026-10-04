@echo off
setlocal
title AutoCaption AE Setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1" -PackageDir "%~dp0."
echo.
pause
