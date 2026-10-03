@echo off
REM ---------------------------------------------------------------------------
REM AutoCaption AE: full release build on Windows.
REM Requires on the BUILD machine only (end users need none of these):
REM   Python 3.11 (py launcher), Node.js 22, mingw-w64 gcc on PATH, internet.
REM Steps: clean, locked deps, models, engine folder (engine.pak + bin),
REM        manifest, engine self-test, panel, tests, audits, archive, checksums.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
if exist out rmdir /s /q out
py -3.11 -m venv .build-venv || goto :fail
.build-venv\Scripts\python -m pip install -q --upgrade pip uv==0.12.22 huggingface_hub==0.36.2 || goto :fail
REM torch/torchaudio are only used at build time to store word-timing weights at half precision
.build-venv\Scripts\python -m pip install -q torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cpu || goto :fail
pushd extension && call npm ci && popd || goto :fail
.build-venv\Scripts\python build\fetch_models.py out\models-stage || goto :fail
.build-venv\Scripts\python build\build_backend.py "out\build\AutoCaption Engine" --models out\models-stage || goto :fail
.build-venv\Scripts\python -c "import json; d=json.load(open(r'out\build\build-versions.json')); d.pop('packages'); json.dump(d, open(r'out\build\versions.json','w'))" || goto :fail
.build-venv\Scripts\python build\make_manifest.py "out\build\AutoCaption Engine" --versions out\build\versions.json --platform win-x64 || goto :fail
REM the engine only starts with the panel's launch token; the build signs one the same way
for /f %%T in ('.build-venv\Scripts\python -c "import sys; sys.path.insert(0, 'backend'); from autocaption import launchkey; print(launchkey.token())"') do set AUTOCAPTION_LAUNCH=%%T
"out\build\AutoCaption Engine\AutoCaption Engine.exe" --panel --self-test || goto :fail
set AUTOCAPTION_LAUNCH=
.build-venv\Scripts\python build\build_release.py --engine "out\build\AutoCaption Engine" --out out\release || goto :fail
echo.
echo Release ready in out\release
exit /b 0
:fail
echo BUILD FAILED
exit /b 1
