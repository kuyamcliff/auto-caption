"""Worker process: owns the ML models, runs one job at a time.

Protocol: JSON lines. Commands arrive over an authenticated 127.0.0.1 socket
opened by the server (never stdin: on Windows a thread blocked on a pipe read
stalls other I/O in the process); events leave on the original stdout. Library prints are redirected to stderr so they cannot corrupt the
protocol. Cancellation is cooperative (checked between batches/segments); the
server kills this process if it does not acknowledge quickly.
"""
from __future__ import annotations

import json
import os
import queue
import socket
import sys
import threading
import traceback
from pathlib import Path

from . import paths


def main() -> int:
    paths.configure_offline_environment()
    proto_fd = os.dup(1)
    os.dup2(2, 1)  # anything printed by libraries lands in stderr
    proto = os.fdopen(proto_fd, "w", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr
    lock = threading.Lock()

    def emit(obj: dict) -> None:
        with lock:
            proto.write(json.dumps(obj, ensure_ascii=False) + "\n")
            proto.flush()

    from . import logs

    log = logs.setup("backend", debug=os.environ.get("AUTOCAPTION_DEBUG") == "1")
    commands: "queue.Queue[dict | None]" = queue.Queue()
    cancel_ids: set[str] = set()
    decoders: list = []

    # Command channel: authenticated localhost socket opened by the server.
    sock = socket.create_connection(("127.0.0.1", int(os.environ["AUTOCAPTION_WORKER_PORT"])), timeout=60)
    sock.settimeout(None)
    sock.sendall((os.environ["AUTOCAPTION_WORKER_KEY"] + "\n").encode("ascii"))
    inbox = sock.makefile("r", encoding="utf-8")

    def reader() -> None:
        for line in inbox:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("cmd") == "cancel":
                cancel_ids.add(str(msg.get("jobId")))
                for p in list(decoders):
                    try:
                        p.kill()
                    except OSError:
                        pass
            else:
                commands.put(msg)
        commands.put(None)  # server went away: socket closed

    threading.Thread(target=reader, daemon=True).start()

    from .audio import AudioError, decode
    from .pipeline import Cancelled, Engine, EngineError, Options

    engine = Engine()
    emit({"event": "ready", "pid": os.getpid()})

    while True:
        msg = commands.get()
        if msg is None:
            break
        cmd = msg.get("cmd")
        job_id = str(msg.get("jobId", ""))
        if cmd == "unload":
            engine.unload_asr()
            engine._align.clear()
            continue
        if cmd not in ("transcribe", "align"):
            continue

        def progress(stage: str, value, message: str, _job=job_id) -> None:
            emit({"event": "progress", "jobId": _job, "stage": stage, "progress": value, "message": message})

        def cancelled(_job=job_id) -> bool:
            return _job in cancel_ids

        try:
            progress("preparing", None, "Preparing audio")
            src = msg.get("source") or {}
            decoders.clear()
            audio = decode(Path(msg["audioPath"]), src.get("start"), src.get("duration"), proc_holder=decoders)
            decoders.clear()
            if cancelled():
                raise Cancelled()
            if cmd == "transcribe":
                o = msg.get("options") or {}
                opts = Options(model=str(o.get("model", "base")), language=str(o.get("language", "auto")),
                               device=str(o.get("device", "auto")), batch_size=int(o.get("batchSize", 0) or 0),
                               vad=str(o.get("vad", "pyannote")), threads=int(o.get("threads", 0) or 0))
                result = engine.transcribe(audio, opts, progress, cancelled)
            else:
                result = engine.align_only(audio, msg.get("segments") or [], str(msg.get("language", "en")),
                                           progress, cancelled)
            del audio
            emit({"event": "result", "jobId": job_id, "result": result})
        except Cancelled:
            emit({"event": "cancelled", "jobId": job_id})
        except (EngineError, AudioError) as exc:
            log.warning("job %s failed: %s %s", job_id, exc.code, getattr(exc, "detail", ""))
            if cancelled():
                emit({"event": "cancelled", "jobId": job_id})
            else:
                emit({"event": "error", "jobId": job_id, "code": exc.code, "message": str(exc),
                      "detail": getattr(exc, "detail", ""), "hint": getattr(exc, "hint", [])})
        except MemoryError:
            emit({"event": "error", "jobId": job_id, "code": "OUT_OF_MEMORY",
                  "message": "The computer ran out of memory while transcribing.",
                  "hint": ["Close other applications", "Use the Base model", "Transcribe a shorter section"]})
        except Exception as exc:  # noqa: BLE001
            tb = traceback.format_exc()
            log.error("job %s crashed:\n%s", job_id, tb)
            emit({"event": "error", "jobId": job_id, "code": "ENGINE_ERROR",
                  "message": "The transcription engine stopped unexpectedly.",
                  "detail": f"{type(exc).__name__}: {exc}\n{tb[-3000:]}",
                  "hint": ["Verify the backend", "Try again with the CPU device"]})
        finally:
            cancel_ids.discard(job_id)
    return 0
