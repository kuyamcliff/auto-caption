@echo off
setlocal
title AutoCaption AE - Install Extension
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1" -PackageDir "%~dp0."
echo.
pause
