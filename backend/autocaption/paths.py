"""Filesystem locations used by the engine.

Engine folder layout (relocatable, no absolute build paths):

  AutoCaption Engine/
    AutoCaption Engine.exe     launcher (only starts when the panel launches it)
    engine.pak                 engine code, models and data (read in place)
    bin/                       native runtime, libraries, decoder, manifest.json

Everything the engine *writes* lives in per-user locations: temp audio in
%TEMP%\\AutoCaptionAE, logs and a small data cache in %LOCALAPPDATA%\\AutoCaptionAE.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

APP_DIR_NAME = "AutoCaptionAE"
PAK_NAME = "engine.pak"


def backend_root() -> Path:
    """The engine folder (the one that contains engine.pak)."""
    env = os.environ.get("AUTOCAPTION_BACKEND_ROOT")
    if env:
        return Path(env).resolve()
    # Packaged: this file is .../AutoCaption Engine/engine.pak/app/autocaption/paths.py
    for parent in Path(os.path.abspath(__file__)).parents:
        if parent.name == PAK_NAME:
            return parent.parent
    return Path(__file__).resolve().parent.parent  # development tree


def pak_path() -> Path:
    return backend_root() / PAK_NAME


def bin_dir() -> Path:
    return backend_root() / "bin"


def manifest_path() -> Path:
    return bin_dir() / "manifest.json"


def ffmpeg_exe() -> Path | None:
    for name in ("ffmpeg.exe", "ffmpeg"):
        p = bin_dir() / name
        if p.is_file():
            return p
    if os.environ.get("AUTOCAPTION_DEV") == "1":
        # Development convenience only; packaged builds never look at PATH.
        import shutil

        found = shutil.which("ffmpeg")
        return Path(found) if found else None
    return None


def temp_root() -> Path:
    p = Path(tempfile.gettempdir()) / APP_DIR_NAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def jobs_temp_dir() -> Path:
    p = temp_root() / "jobs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def user_data_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home())
    else:
        base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    p = Path(base) / APP_DIR_NAME
    p.mkdir(parents=True, exist_ok=True)
    return p


def logs_dir() -> Path:
    p = user_data_dir() / "logs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def cache_dir() -> Path:
    p = user_data_dir() / "engine-cache"
    p.mkdir(parents=True, exist_ok=True)
    return p


def configure_offline_environment() -> None:
    """Hard-disable every download/telemetry path of the bundled libraries and
    point their caches at private folders. Must run before importing them."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["DO_NOT_TRACK"] = "1"
    os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    cache = user_data_dir() / "cache"
    os.environ["HF_HOME"] = str(cache / "hf")
    os.environ["TORCH_HOME"] = str(cache / "torch")
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
    ff = ffmpeg_exe()
    if ff is not None:
        os.environ["PATH"] = str(ff.parent) + os.pathsep + os.environ.get("PATH", "")
    if sys.platform == "win32":
        # Graphics-acceleration runtime DLLs ship in bin/cuda.
        cuda = bin_dir() / "cuda"
        if cuda.is_dir():
            os.environ["PATH"] = str(cuda) + os.pathsep + os.environ["PATH"]
            try:
                os.add_dll_directory(str(cuda))
            except (AttributeError, OSError):
                pass
