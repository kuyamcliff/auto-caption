@echo off
setlocal
title AutoCaption AE - Verify Installation
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\verify.ps1" -PackageDir "%~dp0."
echo.
pause
