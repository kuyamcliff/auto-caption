"""`AutoCaptionBackend.exe --self-test`: real end-to-end checks of this backend.

Emits one JSON object per line so the panel can tick rows off live, then a
final {"summary": ...} line. Exit code 0 only when every required check passed.
"""
from __future__ import annotations

import json
import os
import platform
import sys
import time
import traceback

from . import __version__, integrity, paths

EXPECTED = "the quick brown fox jumps over the lazy dog".split()


class Runner:
    def __init__(self, out):
        self.out = out
        self.results: list[dict] = []

    def emit(self, obj: dict) -> None:
        self.out.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self.out.flush()

    def run(self, cid: str, label: str, fn, required: bool = True) -> object:
        self.emit({"check": cid, "label": label, "status": "running"})
        t = time.monotonic()
        try:
            status, detail, value = fn()
        except Exception as exc:  # noqa: BLE001
            status, detail, value = "fail", f"{type(exc).__name__}: {exc}", None
            tb = traceback.format_exc()
            detail_full = tb[-2500:]
        else:
            detail_full = None
        row = {"check": cid, "label": label, "status": status, "detail": detail, "required": required,
               "seconds": round(time.monotonic() - t, 2)}
        if detail_full:
            row["trace"] = detail_full
        self.results.append(row)
        self.emit(row)
        return value


def main(argv: list[str]) -> int:
    quick = "--quick" in argv
    full_hash = "--full" in argv
    paths.configure_offline_environment()
    proto_fd = os.dup(1)
    os.dup2(2, 1)
    out = os.fdopen(proto_fd, "w", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr
    from . import logs

    logs.setup("backend")
    r = Runner(out)
    ctx: dict = {}

    def backend():
        m = integrity.load_manifest()
        if m is None:
            return "fail", "manifest.json is missing", None
        ctx["manifest"] = m
        return "pass", f"AutoCaption backend {__version__} ({m.get('platform')})", None

    def runtime():
        import numpy  # noqa: F401
        import torch
        import ctranslate2
        import faster_whisper  # noqa: F401
        import whisperx  # noqa: F401
        import pyannote.audio  # noqa: F401
        from nltk.data import load as nltk_load

        nltk_load("tokenizers/punkt_tab/english.pickle")
        return "pass", f"Python {platform.python_version()}, torch {torch.__version__}, " \
                       f"CTranslate2 {ctranslate2.__version__}", None

    def files():
        res = integrity.verify(full=full_hash)
        if not res["ok"]:
            bad = (res["missing"] + res["corrupt"])[:5]
            return "fail", f"{res['missingCount']} missing, {res['corruptCount']} damaged: {', '.join(bad)}", None
        return "pass", f"{res['checked']} files verified" + (" (SHA-256)" if full_hash else ""), None

    def permissions():
        for d in (paths.temp_root(), paths.logs_dir()):
            probe = d / f".write-test-{os.getpid()}"
            probe.write_text("ok")
            probe.unlink()
        return "pass", "Temporary and log folders are writable", None

    def ffmpeg():
        from .audio import decode, ffmpeg_version

        v = ffmpeg_version()
        audio = decode(paths.backend_root() / "selftest" / "selftest.wav")
        ctx["audio"] = audio
        return "pass", f"FFmpeg {v}; decoded {len(audio) / 16000:.1f}s test clip", None

    def vad():
        from .registry import Registry

        reg = Registry()
        ctx["registry"] = reg
        if reg.vad is None:
            return "fail", "VAD model missing", None
        from whisperx.vads import Pyannote

        Pyannote("cpu", token=None, model_fp=str(reg.vad.path / "pytorch_model.bin"), vad_onset=0.5,
                 vad_offset=0.363, chunk_size=30)
        return "pass", "Voice activity detection loaded", None

    def make_engine():
        from .pipeline import Engine

        if "engine" not in ctx:
            ctx["engine"] = Engine(ctx.get("registry"))
        return ctx["engine"]

    def transcribe_check(model: str, device: str, language: str = "auto"):
        def fn():
            from .pipeline import Options
            from .schema import validate_result

            eng = make_engine()
            if model not in eng.registry.whisper:
                return "fail", f"{model} model is not installed", None
            res = eng.transcribe(ctx["audio"], Options(model=model, language=language, device=device),
                                 lambda *a: None, lambda: False)
            validate_result(res)
            got = [w["text"].lower().strip(".,!?") for w in res["words"]]
            hits = sum(1 for w in EXPECTED if w in got)
            ctx[f"result_{model}_{device}"] = res
            if hits < 6:
                return "fail", f"Recognised only {hits}/9 test words: {' '.join(got)[:120]}", res
            aligned = sum(1 for w in res["words"] if w["timingSource"] == "aligned")
            return "pass", f"{hits}/9 words recognised, {aligned} aligned, language {res['language']}, " \
                           f"{res['timings'].get('totalSec')}s on {res['device'].upper()}", res
        return fn

    def small_load():
        from faster_whisper import WhisperModel

        eng = make_engine()
        if "small" not in eng.registry.whisper:
            return "fail", "Small model is not installed", None
        WhisperModel(str(eng.registry.whisper["small"].path), device="cpu", compute_type="int8",
                     local_files_only=True)
        return "pass", "Model loads", None

    def alignment():
        res = ctx.get("result_base_cpu")
        if res is None:
            return "fail", "No transcription to align", None
        if not res["aligned"]:
            return "fail", "Word alignment did not run", None
        ws = res["words"]
        ok = all(b["start"] >= a["start"] for a, b in zip(ws, ws[1:]))
        first = next((w for w in ws if w["text"].lower().strip(".,") == "quick"), None)
        if not ok:
            return "fail", "Word timings are out of order", None
        detail = f"{len(ws)} words aligned"
        if first:
            detail += f"; 'quick' at {first['start']:.2f}s"
        return "pass", detail, None

    def other_alignment():
        rows = [m for m in integrity.model_status(ctx.get("manifest")) if m["kind"] == "align"]
        bad = [m["id"] for m in rows if not m["ok"]]
        if bad:
            return "fail", f"Damaged alignment models: {', '.join(bad)}", None
        if not quick:
            eng = make_engine()
            for m in rows:
                if m["id"] != "en":
                    eng._load_align(m["id"])
        return "pass", ", ".join(sorted(m["id"] for m in rows)) + (" verified" if quick else " loaded"), None

    def gpu():
        from .sysinfo import gpu_info

        info = gpu_info()
        if not info.get("cudaDevices"):
            return "info", "No compatible NVIDIA GPU found. The CPU will be used.", None
        try:
            res = transcribe_check("base", "cuda", "en")()
            if res[0] == "pass" and ctx.get("result_base_cuda", {}).get("device") == "cuda":
                return "pass", f"{info.get('name') or 'NVIDIA GPU'} ready", None
            return "warn", "GPU detected but could not be initialised. The CPU will be used.", None
        except Exception as exc:  # noqa: BLE001
            return "warn", f"GPU detected but unusable ({type(exc).__name__}). The CPU will be used.", None

    r.run("backend", "Backend", backend)
    r.run("runtime", "Runtime", runtime)
    r.run("files", "Backend files", files)
    r.run("permissions", "Permissions", permissions)
    r.run("ffmpeg", "FFmpeg", ffmpeg)
    r.run("vad", "VAD", vad)
    if "audio" in ctx:
        r.run("whisper-base", "Whisper Base", transcribe_check("base", "cpu"))
        r.run("whisper-small", "Whisper Small",
              small_load if quick else transcribe_check("small", "cpu", "en"))
        r.run("align-en", "English Alignment", alignment)
    r.run("align-other", "Other languages", other_alignment, required=False)
    r.run("gpu", "GPU", gpu, required=False)
    cpu_ok = any(x["check"] == "whisper-base" and x["status"] == "pass" for x in r.results)
    r.run("cpu", "CPU fallback", lambda: ("pass", "CPU transcription works", None) if cpu_ok
          else ("fail", "CPU transcription failed", None))
    failed = [x for x in r.results if x["required"] and x["status"] == "fail"]
    r.emit({"summary": {"ok": not failed, "failed": [x["check"] for x in failed], "version": __version__,
                        "checks": len(r.results)}})
    return 0 if not failed else 1
