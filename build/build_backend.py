"""Build the self-contained Windows x64 engine folder.

  python build/build_backend.py <out_dir> --models <dir with models/> [--no-cuda] [--reuse-runtime <old bin dir>]

Result (relocatable, no absolute paths):
  AutoCaption Engine/
    AutoCaption Engine.exe     native launcher (build/launcher/launcher.c); runs only when the panel starts it
    engine.pak                 engine code, models and data, read in place (build/make_pak.py)
    bin/                       embeddable CPython 3.11 + trimmed site-packages, cuda/ DLLs,
                               ffmpeg.exe, manifest.json
    Third-party notices.txt    every bundled component and its license

Runs on Linux or Windows: wheels are resolved for win_amd64 by `uv` using
build/requirements-win.lock, so the build machine's Python is never shipped.
"""
from __future__ import annotations

import argparse
import compileall
import json
import os
import re
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
# Packages pulled in by the dependency tree that no engine code path imports
# (measured by recording every import across transcription, timing, speech
# detection, GPU/CPU fallback and the self test). Removed with their metadata.
UNUSED_PACKAGES = ["sqlalchemy", "grpc", "hf_xet", "pygments", "pytorch_lightning", "lightning_fabric", "aiohttp",
                   "yarl", "multidict", "propcache", "frozenlist", "aiosignal", "aiohappyeyeballs", "alembic", "click",
                   "pytorch_metric_learning", "mako", "markdown_it", "mdurl", "functorch"]
DIST_NAMES = {"grpc": "grpcio", "markdown_it": "markdown_it_py"}
PTH = "python311.zip\n.\nLib\\site-packages\n..\\engine.pak\\app\nimport site\n"
NOTICES: list[tuple[str, str]] = []


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
    rt = out / "bin"
    log("embeddable CPython " + PYTHON_VERSION)
    with zipfile.ZipFile(fetch(PYTHON_URL, f"python-{PYTHON_VERSION}-embed-amd64.zip")) as z:
        z.extractall(rt)
    # Isolated module search path: stdlib zip, site-packages, engine code inside
    # engine.pak. No user site, no PYTHONPATH, no system Python can leak in.
    (rt / "python311._pth").write_text(PTH, encoding="ascii")
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
    cuda = out / "bin" / "cuda"
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
                    NOTICES.append((f"NVIDIA {whl.name.split('-')[0]} (GPU runtime DLLs in bin/cuda)",
                                    z.read(info).decode("utf-8", "replace")))
    log(f"CUDA runtime DLLs: {len(names)}")
    return names


def install_ffmpeg(out: Path) -> str:
    zpath = fetch(FFMPEG_URL, Path(FFMPEG_URL).name)
    ff = out / "bin"
    ff.mkdir(parents=True, exist_ok=True)
    version = Path(FFMPEG_URL).name.split("-")[1]
    with zipfile.ZipFile(zpath) as z:
        for info in z.infolist():
            base = Path(info.filename).name
            if base == "ffmpeg.exe":
                (ff / base).write_bytes(z.read(info))
            elif base == "LICENSE":
                NOTICES.append((f"FFmpeg {version} (bin/ffmpeg.exe, gyan.dev essentials build, GPL v3, run as a separate "
                                "program; source: https://ffmpeg.org/download.html)", z.read(info).decode("utf-8", "replace")))
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


def trim_unused(site: Path) -> int:
    freed = 0
    for name in UNUSED_PACKAGES:
        dist = DIST_NAMES.get(name, name)
        targets = [site / name] + [d for d in site.glob("*.dist-info")
                                   if d.name[: -len(".dist-info")].rpartition("-")[0].lower().replace("-", "_") == dist]
        for t in targets:
            if t.is_dir():
                freed += sum(f.stat().st_size for f in t.rglob("*") if f.is_file())
                shutil.rmtree(t)
    return freed


def write_notices(out: Path, site: Path, registry: dict) -> None:
    """One aggregated license file for everything bundled with the engine."""
    import email.parser

    lines = ["AutoCaption AE Engine: third-party notices", "", "Made by cyriqvfx.",
             "The engine bundles the software and data listed below. Each component remains under its own license;",
             "the full license texts follow the summary.", "", "SUMMARY", ""]
    texts: list[tuple[str, str]] = []
    for dist in sorted(site.glob("*.dist-info"), key=lambda p: p.name.lower()):
        meta_path = dist / "METADATA"
        if not meta_path.exists():
            continue
        meta = email.parser.Parser().parsestr(meta_path.read_text(encoding="utf-8", errors="replace"))
        name, ver = meta.get("Name", dist.name), meta.get("Version", "")
        lic = meta.get("License-Expression") or ((meta.get("License") or "").splitlines() or [""])[0]
        if not lic or len(lic) > 80:
            cls = [c.split("::")[-1].strip() for c in meta.get_all("Classifier") or [] if c.startswith("License ::")]
            lic = ", ".join(cls) or "see license text"
        url = meta.get("Home-page") or (meta.get_all("Project-URL") or [""])[0].split(",")[-1].strip()
        lines.append(f"  {name} {ver}: {lic}" + (f" ({url})" if url else ""))
        for f in sorted(p for p in dist.rglob("*") if p.is_file() and re.search(r"(LICEN[CS]E|COPYING|NOTICE)", p.name, re.I)):
            texts.append((f"{name} {ver}: {f.name}", f.read_text(encoding="utf-8", errors="replace")))
    lines += ["", f"  CPython {PYTHON_VERSION} embeddable distribution: PSF License"]
    py_lic = out / "bin" / "LICENSE.txt"
    if py_lic.exists():
        texts.append((f"CPython {PYTHON_VERSION}", py_lic.read_text(encoding="utf-8", errors="replace")))
        py_lic.unlink()
    for title, _ in NOTICES:
        lines.append(f"  {title}")
    texts += NOTICES
    lines += ["", "MODELS AND DATA (inside engine.pak)", ""]
    for key, n in sorted(registry.get("notices", {}).items()):
        if isinstance(n, dict):
            lines.append(f"  {key}: {n.get('license')} (source: {n.get('source')}" +
                         (f", revision {n['revision']})" if n.get("revision") else ")"))
        else:
            lines.append(f"  {key}: {n}")
    lines += ["  data/nltk: NLTK punkt_tab tokenizer data, Apache 2.0",
              "  Note: the French, German, Spanish and Italian word-timing models are licensed CC BY-NC 4.0",
              "  (non-commercial use). The English word-timing model is MIT licensed.", "",
              "  The panel is built with Preact (MIT).", "", "LICENSE TEXTS", ""]
    for title, body in texts:
        lines += ["-" * 78, title, "-" * 78, body.strip(), ""]
    (out / "Third-party notices.txt").write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")


def build_launcher(out: Path) -> None:
    src = HERE / "launcher" / "launcher.c"
    exe = out / "AutoCaption Engine.exe"
    cc = shutil.which("x86_64-w64-mingw32-gcc") or shutil.which("gcc")
    if cc is None:
        raise SystemExit("A C compiler (mingw-w64) is required to build the launcher.")
    subprocess.run([cc, "-O2", "-s", "-municode", "-o", str(exe), str(src), "-lshlwapi", "-luser32"], check=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", help="output folder (becomes 'AutoCaption Engine')")
    ap.add_argument("--models", required=True, help="directory containing models/ (from fetch_models.py)")
    ap.add_argument("--no-cuda", action="store_true")
    ap.add_argument("--reuse-runtime", help="copy an already installed bin/ (same lock file) instead of re-downloading wheels")
    args = ap.parse_args()
    out = Path(args.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    if args.reuse_runtime:
        log(f"reusing runtime from {args.reuse_runtime}")
        shutil.copytree(args.reuse_runtime, out / "bin", ignore=shutil.ignore_patterns("ffmpeg.exe", "manifest.json", "__pycache__"))
        # GPU DLLs come along with the runtime; take their license texts from the previous build
        for lic in sorted((Path(args.reuse_runtime).parent / "licenses" / "nvidia").glob("*.txt")):
            NOTICES.append((f"NVIDIA {lic.stem.removesuffix('-LICENSE')} (GPU runtime DLLs in bin/cuda)", lic.read_text("utf-8", "replace")))
        (out / "bin" / "python311._pth").write_text(PTH, encoding="ascii")
        site = out / "bin" / "Lib" / "site-packages"
        versions = {}
        for dist in site.glob("*.dist-info"):
            name, _, ver = dist.name[: -len(".dist-info")].rpartition("-")
            versions[name.lower().replace("_", "-")] = ver
    else:
        versions = install_runtime(out)
    site = out / "bin" / "Lib" / "site-packages"
    log(f"pruned {prune(site) / 1e6:.0f} MB of headers/tests/import libs")
    log(f"removed {trim_unused(site) / 1e6:.0f} MB of unused packages")
    if args.no_cuda:
        shutil.rmtree(out / "bin" / "cuda", ignore_errors=True)
        cuda = []
    elif args.reuse_runtime and (out / "bin" / "cuda").is_dir():
        cuda = [p.name for p in (out / "bin" / "cuda").glob("*.dll")]
    else:
        cuda = install_cuda(out)
    ffmpeg_version = install_ffmpeg(out)

    # Precompile bytecode (CPython 3.11 .pyc is platform independent) so the
    # first start does not have to write into the install folder.
    if sys.version_info[:2] == (3, 11):
        log("precompiling bytecode")
        compileall.compile_dir(str(site), quiet=1, workers=0, invalidation_mode=compileall.py_compile.PycInvalidationMode.UNCHECKED_HASH)
    else:
        log("skipping precompile (build Python is not 3.11)")

    log("engine.pak")
    subprocess.run([sys.executable, str(HERE / "make_pak.py"), args.models, str(out / "engine.pak")], check=True)
    with zipfile.ZipFile(out / "engine.pak") as z:
        registry = json.loads(z.read("registry.json"))
    build_launcher(out)
    write_notices(out, site, registry)

    info = {
        "runtime": f"CPython {PYTHON_VERSION} (embeddable, win-amd64)",
        "ffmpeg": ffmpeg_version,
        "gpuRuntime": "cuBLAS 12.9, cuDNN 9.27" if cuda else None,
        "packages": dict(sorted(versions.items())),
    }
    (out.parent / "build-versions.json").write_text(json.dumps(info, indent=1))
    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
