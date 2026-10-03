"""Engine self-test: real end-to-end checks, run from the panel's Verify step.

Emits one JSON object per line so the panel can tick rows off live, then a
final {"summary": ...} line. Exit code 0 only when every required check
passed. Row labels and details are written for the panel, so they describe
what each check means to the user, never which components implement it.
Full technical detail goes to the engine log.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
import traceback

from . import __version__, integrity, paths

EXPECTED = "the quick brown fox jumps over the lazy dog".split()
log = logging.getLogger("autocaption.selftest")


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
        except Exception:  # noqa: BLE001
            log.error("self-test check %s failed:\n%s", cid, traceback.format_exc())
            status, detail, value = "fail", "This check failed. See the engine log for details.", None
        row = {"check": cid, "label": label, "status": status, "detail": detail, "required": required,
               "seconds": round(time.monotonic() - t, 2)}
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

    def engine():
        if integrity.load_manifest() is None:
            return "fail", "The engine folder is incomplete.", None
        from .pak import engine_pak

        ctx["pak"] = engine_pak()
        return "pass", f"Version {__version__}", None

    def runtime():
        import numpy  # noqa: F401
        import torch  # noqa: F401
        import ctranslate2  # noqa: F401
        import faster_whisper  # noqa: F401
        import whisperx  # noqa: F401
        import pyannote.audio  # noqa: F401
        from .pak import prepare_runtime_data

        prepare_runtime_data()
        from nltk.data import load as nltk_load

        nltk_load("tokenizers/punkt_tab/english.pickle")
        return "pass", "Ready", None

    def files():
        res = integrity.verify(full=full_hash)
        pak_res = ctx["pak"].verify("")  # every model and data entry, SHA-256 (cached after first run)
        if not pak_res["ok"]:
            log.error("damaged pak entries: %s", pak_res["damaged"][:20])
            res["ok"] = False
            res["corruptCount"] += len(pak_res["damaged"])
        if not res["ok"]:
            return "fail", f"{res['missingCount'] + res['corruptCount']} files are missing or damaged. " \
                           "Copy a fresh engine folder from the download.", None
        return "pass", f"{res['checked']:,} files verified", None

    def permissions():
        for d in (paths.temp_root(), paths.logs_dir(), paths.cache_dir()):
            probe = d / f".write-test-{os.getpid()}"
            probe.write_text("ok")
            probe.unlink()
        return "pass", "Temporary files can be written", None

    def decoder():
        import io
        import wave

        import numpy as np

        from .audio import decode

        data = ctx["pak"].read(ctx["pak"].registry["selftest"])
        tmp = paths.temp_root() / f"selftest-{os.getpid()}.wav"
        tmp.write_bytes(data)
        try:
            audio = decode(tmp)
        finally:
            tmp.unlink(missing_ok=True)
        with wave.open(io.BytesIO(data)) as w:
            expected = w.getnframes() / w.getframerate()
        if abs(len(audio) / 16000 - expected) > 0.1 or not np.isfinite(audio).all():
            return "fail", "Audio could not be decoded correctly.", None
        ctx["audio"] = audio
        return "pass", "Ready", None

    def silence():
        from .registry import Registry

        reg = Registry(ctx["pak"])
        ctx["registry"] = reg
        from whisperx.vads import Pyannote

        vad_dir = ctx["pak"].extract(reg.vad["prefix"])
        Pyannote("cpu", token=None, model_fp=str(vad_dir / "pytorch_model.bin"), vad_onset=0.5,
                 vad_offset=0.363, chunk_size=30)
        return "pass", "Ready", None

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
                return "fail", "Not installed. Copy a fresh engine folder from the download.", None
            res = eng.transcribe(ctx["audio"], Options(model=model, language=language, device=device),
                                 lambda *a: None, lambda: False)
            validate_result(res)
            got = [w["text"].lower().strip(".,") for w in res["words"]]
            hits = sum(1 for w in EXPECTED if w in got)
            ctx[f"result_{model}_{device}"] = res
            log.info("self-test %s/%s: %s", model, device, " ".join(got))
            if hits < 6:
                return "fail", "The test recording was not transcribed correctly.", res
            return "pass", f"Test recording transcribed in {res['timings'].get('totalSec')} s", res
        return fn

    def accurate_load():
        from whisperx.asr import WhisperModel

        eng = make_engine()
        if "accurate" not in eng.registry.whisper:
            return "fail", "Not installed. Copy a fresh engine folder from the download.", None
        pak = eng.registry.pak
        prefix = eng.registry.whisper["accurate"].info["prefix"]
        WhisperModel("accurate", device="cpu", compute_type="int8", local_files_only=True,
                     files={n[len(prefix):]: pak.read(n) for n in pak.names(prefix)})
        return "pass", "Ready", None

    def timing_en():
        res = ctx.get("result_fast_cpu")
        if res is None or not res["aligned"]:
            return "fail", "Word timing did not run.", None
        ws = res["words"]
        if not all(b["start"] >= a["start"] for a, b in zip(ws, ws[1:])):
            return "fail", "Word timing came out in the wrong order.", None
        return "pass", f"{len(ws)} words timed", None

    def timing_other():
        eng = make_engine()
        langs = sorted(k for k in eng.registry.align if k != "en")
        res = eng.registry.pak.verify("models/timing/")
        if not res["ok"]:
            return "fail", "Some language files are damaged. Copy a fresh engine folder from the download.", None
        if not quick:
            for lang in langs:
                eng._load_align(lang)
        names = [eng.registry.align[k].label for k in langs]
        return "pass", ", ".join(names), None

    def gpu():
        from .sysinfo import gpu_info

        info = gpu_info()
        if not info.get("cudaDevices"):
            return "info", "Not available. Your processor will be used.", None
        try:
            status = transcribe_check("fast", "cuda", "en")()[0]
            if status == "pass" and ctx.get("result_fast_cuda", {}).get("device") == "gpu":
                return "pass", f"{info.get('name') or 'Graphics card'} ready", None
        except Exception:  # noqa: BLE001
            log.warning("graphics acceleration check failed:\n%s", traceback.format_exc())
        return "warn", "Your graphics card could not be used. Your processor will be used instead.", None

    r.run("engine", "Engine", engine)
    if "pak" in ctx:
        r.run("runtime", "Engine runtime", runtime)
        r.run("files", "File integrity", files)
        r.run("permissions", "Permissions", permissions)
        r.run("decoder", "Audio decoding", decoder)
        r.run("silence", "Speech detection", silence)
        if "audio" in ctx:
            r.run("speech-fast", "Fast transcription", transcribe_check("fast", "cpu"))
            r.run("speech-accurate", "Accurate transcription",
                  accurate_load if quick else transcribe_check("accurate", "cpu", "en"))
            r.run("timing-en", "Word timing (English)", timing_en)
        r.run("timing-other", "Word timing (other languages)", timing_other, required=False)
        r.run("gpu", "Graphics acceleration", gpu, required=False)
    cpu_ok = any(x["check"] == "speech-fast" and x["status"] == "pass" for x in r.results)
    r.run("cpu", "Processor fallback", lambda: ("pass", "Ready", None) if cpu_ok
          else ("fail", "Transcription on the processor failed.", None))
    failed = [x for x in r.results if x["required"] and x["status"] == "fail"]
    r.emit({"summary": {"ok": not failed, "failed": [x["check"] for x in failed], "version": __version__,
                        "checks": len(r.results)}})
    return 0 if not failed else 1
