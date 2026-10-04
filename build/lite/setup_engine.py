"""AutoCaption Engine setup (lite download).

Creates the engine's private environment in bin\\venv from the Python already
installed on this PC, installs the pinned libraries into it, and links it to
engine.pak. Nothing outside the engine folder is changed. Safe to run again:
it repairs or completes an earlier setup.

  python setup\\setup_engine.py [--gpu | --no-gpu] [--yes]
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import venv
from pathlib import Path

ENGINE = Path(__file__).resolve().parent.parent
VENV = ENGINE / "bin" / "venv"
REQS = ENGINE / "setup" / "requirements.txt"
GPU_REQS = ENGINE / "setup" / "requirements-gpu.txt"
EXTRA_INDEX = "https://download.pytorch.org/whl/cpu"
SUPPORTED = ((3, 11), (3, 12), (3, 13))
# engine code lives inside engine.pak; this puts it on the environment's path, relative to the folder
PTH_LINE = ("import sys, os; p = os.path.join(os.path.dirname(os.path.dirname(sys.prefix)), 'engine.pak', 'app'); "
            "p in sys.path or sys.path.append(p)\n")
CHECK = ("import numpy, torch, torchaudio, ctranslate2, faster_whisper, whisperx, pyannote.audio, nltk, imageio_ffmpeg, autocaption; "
         "assert os.path.isfile(imageio_ffmpeg.get_ffmpeg_exe()); print('ok')")


def say(msg: str = "") -> None:
    print(msg, flush=True)


def fail(msg: str) -> int:
    say()
    say("Setup did not finish: " + msg)
    return 1


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def run(cmd: list[str], quiet: bool = False) -> int:
    return subprocess.call(cmd, stdout=subprocess.DEVNULL if quiet else None)


def has_nvidia() -> bool:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return False
    try:
        out = subprocess.run([exe, "-L"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "GPU" in out


def ask(question: str, default: bool) -> bool:
    try:
        ans = input(f"{question} [{'Y/n' if default else 'y/N'}] ").strip().lower()
    except EOFError:
        return default
    return default if not ans else ans.startswith("y")


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--gpu", action="store_true", help="also install NVIDIA graphics card support")
    g.add_argument("--no-gpu", action="store_true")
    ap.add_argument("--yes", action="store_true", help="do not ask questions")
    args = ap.parse_args()

    say("AutoCaption Engine setup")
    say("Made by cyriqvfx")
    say()
    if sys.version_info[:2] not in SUPPORTED or sys.maxsize < 2**32:
        return fail(f"this needs 64-bit Python 3.11, 3.12 or 3.13 (found {sys.version.split()[0]}).")
    if not (ENGINE / "engine.pak").is_file() or not REQS.is_file():
        return fail("run this from inside the AutoCaption Engine folder of the download.")
    if (ENGINE / "bin" / "python.exe").is_file():
        say("This engine folder already includes everything it needs. Nothing to do.")
        return 0
    say(f"Engine folder: {ENGINE}")
    say(f"Using Python {sys.version.split()[0]} at {sys.executable}")
    say()

    py = venv_python()
    if not py.is_file():
        say("1/4  Creating the engine's private environment")
        shutil.rmtree(VENV, ignore_errors=True)
        venv.EnvBuilder(with_pip=True, clear=True).create(VENV)
    else:
        say("1/4  Private environment found")
    if not py.is_file():
        return fail("the private environment could not be created.")

    say("2/4  Installing engine libraries (about 1 GB, one time; this takes a few minutes)")
    run([str(py), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--upgrade", "pip"], quiet=True)
    code = run([str(py), "-m", "pip", "install", "--disable-pip-version-check", "--no-deps", "--prefer-binary",
                "--extra-index-url", EXTRA_INDEX, "-r", str(REQS)])
    if code:
        return fail("the libraries could not be installed. Check your internet connection and run setup again.")

    gpu = args.gpu or (not args.no_gpu and has_nvidia() and (args.yes or ask(
        "An NVIDIA graphics card was found. Install graphics card support for faster transcription? (about 2 GB)", True)))
    if gpu:
        say("3/4  Installing graphics card support")
        if run([str(py), "-m", "pip", "install", "--disable-pip-version-check", "--no-deps", "--prefer-binary", "-r", str(GPU_REQS)]):
            say("     Graphics card support could not be installed. The processor will be used.")
    else:
        say("3/4  Graphics card support skipped (the processor will be used)")

    say("4/4  Linking the engine")
    site = subprocess.run([str(py), "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
                          capture_output=True, text=True).stdout.strip()
    if not site:
        return fail("the private environment is not usable.")
    Path(site, "autocaption-engine.pth").write_text(PTH_LINE, encoding="ascii")
    out = subprocess.run([str(py), "-c", "import os; " + CHECK], capture_output=True, text=True)
    if out.stdout.strip() != "ok":
        log = ENGINE / "setup" / "setup-error.txt"
        log.write_text(out.stdout + out.stderr, encoding="utf-8")
        return fail(f"the engine could not load its libraries. Details are in {log}")

    say()
    say("Done. Open After Effects, then Window > Extensions > AutoCaption AE and click Check Engine.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
