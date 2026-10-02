@echo off
REM ---------------------------------------------------------------------------
REM AutoCaption AE - full release build on Windows.
REM Requires on the BUILD machine only (end users need none of these):
REM   Python 3.11 (py launcher), Node.js 22, mingw-w64 gcc on PATH, internet.
REM Steps: clean -> locked deps -> models -> backend -> extension -> tests ->
REM        package self-test -> archives -> SHA-256 checksums -> sizes.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
if exist out rmdir /s /q out
py -3.11 -m venv .build-venv || goto :fail
.build-venv\Scripts\python -m pip install -q --upgrade pip uv==0.12.22 huggingface_hub==0.36.2 || goto :fail
pushd extension && call npm ci && popd || goto :fail
.build-venv\Scripts\python build\fetch_models.py out\models-stage || goto :fail
.build-venv\Scripts\python build\build_backend.py out\build\backend --models out\models-stage || goto :fail
.build-venv\Scripts\python build\make_manifest.py out\build\backend --versions out\build\build-versions.json --platform win-x64 || goto :fail
out\build\backend\AutoCaptionBackend.exe --self-test || goto :fail
.build-venv\Scripts\python build\build_release.py --backend out\build\backend --out out\release || goto :fail
echo.
echo Release ready in out\release
exit /b 0
:fail
echo BUILD FAILED
exit /b 1
