"""Build the lite engine folder (download under 500 MB) and the optional add-on packs.

  python build/build_lite.py <out_dir> --models <dir with models/> --notices "<full engine>/Third-party notices.txt"

Result:
  <out_dir>/AutoCaption Engine/
    AutoCaption Engine.exe     same launcher as the full build (uses bin\\venv when bin\\python.exe is absent)
    engine.pak                 engine code + Fast quality + English word timing + speech detection
    Set Up Engine.bat          creates bin\\venv from the user's Python 3.11 to 3.13 and installs the pinned libraries
    setup/                     setup_engine.py, requirements.txt, requirements-gpu.txt
    bin/manifest.json
    Third-party notices.txt
  <out_dir>/Accurate quality.pak    optional: drop into the engine folder
  <out_dir>/More languages.pak      optional: French, German, Spanish and Italian word timing

Must run on CPython 3.11 with torch/torchaudio (make_pak.py converts timing weights).
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_backend import CUDA_WHEELS, build_launcher, log  # noqa: E402

# Distributions the engine never imports (same set the full build removes).
LITE_SKIP = {"aiohappyeyeballs", "aiohttp", "aiosignal", "alembic", "click", "frozenlist", "grpcio", "hf-xet", "mako",
             "markdown-it-py", "mdurl", "multidict", "propcache", "pygments", "pytorch-lightning",
             "pytorch-metric-learning", "sqlalchemy", "yarl"}
EXTRA = ["imageio-ffmpeg==0.6.0"]  # the audio decoder, installed into the engine's environment


def requirements() -> str:
    lines = ["# AutoCaption Engine (lite): pinned libraries, installed by Set Up Engine.bat with --no-deps.",
             "# Same versions as the full download (build/requirements-win.lock)."]
    for line in (HERE / "requirements-win.lock").read_text().splitlines():
        m = re.match(r"([A-Za-z0-9_.\-]+)==", line)
        if m and m.group(1).lower().replace("_", "-") not in LITE_SKIP:
            lines.append(line)
    return "\n".join(lines + EXTRA) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--models", required=True)
    ap.add_argument("--notices", required=True, help="Third-party notices.txt from the full engine build")
    ap.add_argument("--skip-packs", action="store_true")
    args = ap.parse_args()
    out = Path(args.out).resolve()
    eng = out / "AutoCaption Engine"
    if out.exists():
        shutil.rmtree(out)
    (eng / "setup").mkdir(parents=True)
    (eng / "bin").mkdir()

    log("lite engine.pak (Fast quality, English word timing)")
    pak = [sys.executable, str(HERE / "make_pak.py"), args.models]
    subprocess.run(pak + [str(eng / "engine.pak"), "--speech", "fast", "--timing", "en"], check=True)
    if not args.skip_packs:
        log("add-on packs")
        subprocess.run(pak + [str(out / "Accurate quality.pak"), "--pack", "Accurate quality", "--speech", "accurate", "--timing", ""], check=True)
        subprocess.run(pak + [str(out / "More languages.pak"), "--pack", "More languages", "--speech", "", "--timing", "de,es,fr,it"], check=True)

    build_launcher(eng)
    (eng / "setup" / "requirements.txt").write_text(requirements(), encoding="ascii")
    (eng / "setup" / "requirements-gpu.txt").write_text("# Optional NVIDIA graphics card support\n" + "\n".join(CUDA_WHEELS) + "\n", encoding="ascii")
    shutil.copy2(HERE / "lite" / "setup_engine.py", eng / "setup" / "setup_engine.py")
    shutil.copy2(HERE / "lite" / "Set Up Engine.bat", eng / "Set Up Engine.bat")
    notices = Path(args.notices).read_text(encoding="utf-8")
    head = ("Lite download: the components below are not included in the download. \"Set Up Engine.bat\" installs\r\n"
            "the same versions from their official package indexes. The audio decoder comes from imageio-ffmpeg 0.6.0\r\n"
            "(BSD-2-Clause; its FFmpeg binary is LGPL/GPL, source: https://ffmpeg.org/download.html).\r\n\r\n")
    (eng / "Third-party notices.txt").write_text(notices.replace("SUMMARY", head + "SUMMARY", 1), encoding="utf-8")

    versions = out / "versions.json"
    versions.write_text(json.dumps({"runtime": "user Python 3.11 to 3.13 (lite)", "edition": "lite"}))
    subprocess.run([sys.executable, str(HERE / "make_manifest.py"), str(eng), "--versions", str(versions)], check=True)
    versions.unlink()
    size = sum(f.stat().st_size for f in eng.rglob("*") if f.is_file())
    log(f"lite engine folder: {size / 1e6:.0f} MB")
    for f in sorted(out.glob("*.pak")):
        log(f"{f.name}: {f.stat().st_size / 1e6:.0f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
