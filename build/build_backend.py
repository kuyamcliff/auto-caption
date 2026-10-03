"""Build the self-contained Windows x64 backend folder.

  python build/build_backend.py <out_backend_dir> [--models <dir with models/>] [--no-cuda]

Result layout (relocatable, no absolute paths):
  backend/AutoCaptionBackend.exe     native launcher (build/launcher/launcher.c)
  backend/runtime/                   embeddable CPython 3.11 + site-packages
  backend/runtime/cuda/              cuBLAS / cuDNN DLLs for optional GPU use
  backend/app/autocaption/           backend source (+ precompiled .pyc)
  backend/models/                    whisper base+small, alignment, VAD, NLTK data
  backend/ffmpeg/ffmpeg.exe          FFmpeg (GPL build, see licenses/)
  backend/selftest/selftest.wav      synthetic test speech
  backend/licenses/, schemas/, config/, manifest.json

Runs on Linux or Windows: wheels are resolved for win_amd64 by `uv` using
build/requirements-win.lock, so the build machine's Python is never shipped.
"""
from __future__ import annotations

import argparse
import compileall
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
CACHE = Path(os.environ.get("AUTOCAPTION_BUILD_CACHE", REPO / ".build-cache"))

PYTHON_VERSION = "3.11.9"
PYTHON_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip"
FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip"
CUDA_WHEELS = ["nvidia-cublas-cu12==12.9.2.10", "nvidia-cudnn-cu12==9.27.0.42"]
TORCH_INDEX = "https://download.pytorch.org/whl/cpu"

# Files never needed at runtime (headers, static import libs, tests, caches).
PRUNE_DIRS = {"__pycache__", "tests", "benchmarks"}
PRUNE_KEEP_DIRS = {"torch/testing", "torch/include"}  # torch imports torch.testing at runtime
PRUNE_SUFFIXES = {".lib", ".pdb", ".a", ".h", ".hpp", ".cuh", ".pyi"}


def log(msg: str) -> None:
    print(f"[backend] {msg}", flush=True)


def fetch(url: str, name: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / name
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    log(f"download {url}")
    tmp = dest.with_suffix(".part")
    for attempt in range(6):
        have = tmp.stat().st_size if tmp.exists() else 0
        req = urllib.request.Request(url, headers={"Range": f"bytes={have}-", "User-Agent": "autocaption-build"} if have else {"User-Agent": "autocaption-build"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "ab" if have and r.status == 206 else "wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
                total = r.headers.get("Content-Range", "").split("/")[-1] or r.headers.get("Content-Length")
            if not total or tmp.stat().st_size >= int(total):
                break
        except OSError as exc:
            log(f"retry {attempt + 1}: {exc}")
    tmp.replace(dest)
    return dest


def uv() -> str:
    exe = shutil.which("uv")
    if exe:
        return exe
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "uv==0.12.22"], check=True)
    return shutil.which("uv") or str(Path(sys.executable).parent / "uv")


def install_runtime(out: Path) -> dict:
    rt = out / "runtime"
    log("embeddable CPython " + PYTHON_VERSION)
    with zipfile.ZipFile(fetch(PYTHON_URL, f"python-{PYTHON_VERSION}-embed-amd64.zip")) as z:
        z.extractall(rt)
    # Isolated module search path: stdlib zip, site-packages, our app. No user
    # site, no PYTHONPATH, no system Python can leak in.
    (rt / "python311._pth").write_text("python311.zip\n.\nLib\\site-packages\n..\\app\nimport site\n", encoding="ascii")
    site = rt / "Lib" / "site-packages"
    site.mkdir(parents=True, exist_ok=True)
    log("installing locked wheels for win_amd64 / cp311")
    subprocess.run([uv(), "pip", "install", "--quiet", "--target", str(site), "--no-deps",
                    "--python-platform", "x86_64-pc-windows-msvc", "--python-version", "3.11",
                    "--index-strategy", "unsafe-best-match", "--extra-index-url", TORCH_INDEX,
                    "--link-mode", "copy", "-r", str(HERE / "requirements-win.lock")], check=True,
                   env={**os.environ, "UV_CACHE_DIR": str(CACHE / "uv")})
    versions = {}
    for dist in site.glob("*.dist-info"):
        name, _, ver = dist.name[: -len(".dist-info")].rpartition("-")
        versions[name.lower().replace("_", "-")] = ver
    return versions


def install_cuda(out: Path) -> list[str]:
    cuda = out / "runtime" / "cuda"
    cuda.mkdir(parents=True, exist_ok=True)
    tmp = CACHE / "cuda-wheels"
    tmp.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, "-m", "pip", "download", "-q", "--no-deps", "--platform", "win_amd64",
                    "--only-binary=:all:", "-d", str(tmp), *CUDA_WHEELS], check=True)
    names = []
    for whl in sorted(tmp.glob("*.whl")):
        with zipfile.ZipFile(whl) as z:
            for info in z.infolist():
                if info.filename.lower().endswith(".dll"):
                    target = cuda / Path(info.filename).name
                    with z.open(info) as src, open(target, "wb") as dst:
                        shutil.copyfileobj(src, dst, 1 << 20)
                    names.append(target.name)
                elif "license" in info.filename.lower() and info.filename.lower().endswith((".txt", "license")):
                    (out / "licenses" / "nvidia").mkdir(parents=True, exist_ok=True)
                    (out / "licenses" / "nvidia" / f"{whl.name.split('-')[0]}-LICENSE.txt").write_bytes(z.read(info))
    log(f"CUDA runtime DLLs: {len(names)}")
    return names


def install_ffmpeg(out: Path) -> str:
    zpath = fetch(FFMPEG_URL, Path(FFMPEG_URL).name)
    ff = out / "ffmpeg"
    ff.mkdir(parents=True, exist_ok=True)
    version = Path(FFMPEG_URL).name.split("-")[1]
    with zipfile.ZipFile(zpath) as z:
        for info in z.infolist():
            base = Path(info.filename).name
            if base == "ffmpeg.exe":
                (ff / base).write_bytes(z.read(info))
            elif base in ("LICENSE", "README.txt"):
                (out / "licenses" / "ffmpeg").mkdir(parents=True, exist_ok=True)
                (out / "licenses" / "ffmpeg" / base).write_bytes(z.read(info))
    return version


def prune(site: Path) -> int:
    freed = 0
    for p in sorted(site.rglob("*"), key=lambda x: -len(x.parts)):
        rel = p.relative_to(site).as_posix()
        if p.is_dir() and p.name in PRUNE_DIRS and not any(rel.startswith(k) for k in PRUNE_KEEP_DIRS):
            freed += sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
            shutil.rmtree(p, ignore_errors=True)
        elif p.is_file() and p.suffix.lower() in PRUNE_SUFFIXES and not rel.startswith("torch/include"):
            freed += p.stat().st_size
            p.unlink()
    # torch's C++ headers are only needed to build extensions
    inc = site / "torch" / "include"
    if inc.is_dir():
        freed += sum(f.stat().st_size for f in inc.rglob("*") if f.is_file())
        shutil.rmtree(inc)
    return freed


def build_launcher(out: Path) -> None:
    src = HERE / "launcher" / "launcher.c"
    exe = out / "AutoCaptionBackend.exe"
    cc = shutil.which("x86_64-w64-mingw32-gcc") or shutil.which("gcc")
    if cc is None:
        raise SystemExit("A C compiler (mingw-w64) is required to build the launcher.")
    subprocess.run([cc, "-O2", "-s", "-municode", "-o", str(exe), str(src), "-lshlwapi"], check=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--models", required=True, help="directory containing models/ (from fetch_models.py)")
    ap.add_argument("--no-cuda", action="store_true")
    args = ap.parse_args()
    out = Path(args.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    (out / "licenses").mkdir(parents=True)

    versions = install_runtime(out)
    site = out / "runtime" / "Lib" / "site-packages"
    freed = prune(site)
    log(f"pruned {freed / 1e6:.0f} MB of headers/tests/import libs")
    cuda = [] if args.no_cuda else install_cuda(out)
    ffmpeg_version = install_ffmpeg(out)

    log("app + data")
    shutil.copytree(REPO / "backend" / "autocaption", out / "app" / "autocaption",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copytree(REPO / "backend" / "selftest", out / "selftest")
    shutil.copytree(REPO / "backend" / "schemas", out / "schemas")
    (out / "config").mkdir()
    (out / "config" / "defaults.json").write_text(json.dumps(
        {"device": "auto", "defaultModel": "base", "vad": "pyannote", "workerIdleUnloadSec": 600}, indent=1))
    log("models")
    shutil.copytree(Path(args.models) / "models", out / "models")
    build_launcher(out)

    # Precompile bytecode (CPython 3.11 .pyc is platform independent) so the
    # first start does not have to write into the install folder.
    log("precompiling bytecode")
    if sys.version_info[:2] == (3, 11):
        compileall.compile_dir(str(site), quiet=1, workers=0, invalidation_mode=compileall.py_compile.PycInvalidationMode.UNCHECKED_HASH)
        compileall.compile_dir(str(out / "app"), quiet=1, workers=0, invalidation_mode=compileall.py_compile.PycInvalidationMode.UNCHECKED_HASH)
    else:
        log("skipping precompile (build Python is not 3.11)")

    info = {
        "runtimeVersion": f"CPython {PYTHON_VERSION} (embeddable, win-amd64)",
        "whisperxVersion": versions.get("whisperx"),
        "fasterWhisperVersion": versions.get("faster-whisper"),
        "ctranslate2Version": versions.get("ctranslate2"),
        "torchVersion": versions.get("torch"),
        "torchaudioVersion": versions.get("torchaudio"),
        "pyannoteVersion": versions.get("pyannote.audio") or versions.get("pyannote-audio"),
        "ffmpegVersion": ffmpeg_version,
        "cudaRuntime": "cuBLAS 12.9 + cuDNN 9.27 (optional GPU)" if cuda else None,
        "packages": dict(sorted(versions.items())),
    }
    (out.parent / "build-versions.json").write_text(json.dumps(info, indent=1))
    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
