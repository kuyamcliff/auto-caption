"""Filesystem locations used by the backend.

Everything the backend *reads* lives inside the backend folder (relocatable,
no absolute build paths). Everything it *writes* lives in per-user locations:
temp audio in %TEMP%\\AutoCaptionAE, logs in %LOCALAPPDATA%\\AutoCaptionAE\\logs.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

APP_DIR_NAME = "AutoCaptionAE"


def backend_root() -> Path:
    """Folder that contains manifest.json.

    Packaged layout: backend/runtime/python.exe + backend/app/autocaption/...
    Dev layout: repo/backend/autocaption (models via AUTOCAPTION_BACKEND_ROOT).
    """
    env = os.environ.get("AUTOCAPTION_BACKEND_ROOT")
    if env:
        return Path(env).resolve()
    here = Path(__file__).resolve().parent  # .../app/autocaption
    return here.parent.parent


def models_dir() -> Path:
    return backend_root() / "models"


def manifest_path() -> Path:
    return backend_root() / "manifest.json"


def ffmpeg_exe() -> Path | None:
    root = backend_root() / "ffmpeg"
    for name in ("ffmpeg.exe", "ffmpeg"):
        p = root / name
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


def configure_offline_environment() -> None:
    """Hard-disable every download/telemetry path of the ML libraries and point
    their caches at the bundled data. Must run before importing torch & co."""
    root = backend_root()
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["DO_NOT_TRACK"] = "1"
    os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["NLTK_DATA"] = str(root / "models" / "nltk")
    # Caches go to an empty private dir so nothing outside the backend is used.
    cache = user_data_dir() / "cache"
    os.environ["HF_HOME"] = str(cache / "hf")
    os.environ["TORCH_HOME"] = str(cache / "torch")
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
    ff = ffmpeg_exe()
    if ff is not None:
        os.environ["PATH"] = str(ff.parent) + os.pathsep + os.environ.get("PATH", "")
    if sys.platform == "win32":
        # CUDA runtime DLLs for CTranslate2 (cuBLAS / cuDNN) ship in runtime/cuda.
        cuda = root / "runtime" / "cuda"
        if cuda.is_dir():
            os.environ["PATH"] = str(cuda) + os.pathsep + os.environ["PATH"]
            try:
                os.add_dll_directory(str(cuda))
            except (AttributeError, OSError):
                pass
