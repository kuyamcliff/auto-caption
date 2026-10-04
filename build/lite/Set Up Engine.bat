@echo off
setlocal
title AutoCaption Engine Setup
cd /d "%~dp0"
REM Find a 64-bit Python 3.11, 3.12 or 3.13: the py launcher first, then python on PATH.
set "PY="
for %%V in (3.11 3.12 3.13) do (
  if not defined PY (
    py -%%V -c "import sys; sys.exit(0 if sys.maxsize > 2**32 else 1)" >nul 2>&1 && set "PY=py -%%V"
  )
)
if not defined PY (
  python -c "import sys; sys.exit(0 if sys.version_info[:2] in ((3,11),(3,12),(3,13)) and sys.maxsize > 2**32 else 1)" >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo AutoCaption Engine setup needs 64-bit Python 3.11, 3.12 or 3.13.
  echo Install it from python.org, then run this file again.
  echo.
  pause
  exit /b 1
)
%PY% "%~dp0setup\setup_engine.py" %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
