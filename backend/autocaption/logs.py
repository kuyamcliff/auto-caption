"""Rotating local log files. Never logs audio or transcript text."""
from __future__ import annotations

import logging
import logging.handlers

from . import paths

_configured = False


def setup(name: str = "backend", debug: bool = False) -> logging.Logger:
    global _configured
    logger = logging.getLogger("autocaption")
    if not _configured:
        handler = logging.handlers.RotatingFileHandler(
            paths.logs_dir() / f"{name}.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8"
        )
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [%(process)d] %(name)s: %(message)s"))
        logger.addHandler(handler)
        logger.propagate = False
        _configured = True
    logger.setLevel(logging.DEBUG if debug else logging.INFO)
    # Third-party loggers write to our file too, at warning level.
    for lib in ("whisperx", "faster_whisper", "pyannote", "lightning", "pytorch_lightning"):
        lg = logging.getLogger(lib)
        lg.handlers = []
        lg.setLevel(logging.WARNING)
        for h in logger.handlers:
            lg.addHandler(h)
        lg.propagate = False
    return logger
