"""Local HTTP API (127.0.0.1 only, per-session token).

The server process stays light: no torch import. Heavy work happens in the
worker process managed by JobManager.
"""
from __future__ import annotations

import json
import logging
import os
import platform
import re
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from . import API_VERSION, __version__, integrity, paths, sysinfo
from .audio import ALLOWED_EXTENSIONS
from .jobs import BusyError, JobManager
from .registry import Registry

log = logging.getLogger("autocaption.server")

MAX_BODY = 4 * 1024 * 1024
JOB_ID_RE = re.compile(r"^[0-9a-f]{16}$")
MODEL_RE = re.compile(r"^[a-z0-9_.-]{1,40}$")
LANG_RE = re.compile(r"^(auto|[a-z]{2,3})$")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


def validate_media_path(raw: object) -> Path:
    """Accept only an existing, absolute, regular media file. Rejects device
    paths, UNC/extended prefixes, traversal and non-media extensions."""
    if not isinstance(raw, str) or not raw or len(raw) > 1024 or "\x00" in raw:
        raise ApiError(400, "BAD_PATH", "Invalid audio path.")
    if raw.startswith(("\\\\.\\", "\\\\?\\", "//./", "//?/")):
        raise ApiError(400, "BAD_PATH", "Device paths are not allowed.")
    p = Path(raw)
    if not p.is_absolute():
        raise ApiError(400, "BAD_PATH", "Audio path must be absolute.")
    if any(part == ".." for part in p.parts):
        raise ApiError(400, "BAD_PATH", "Path traversal is not allowed.")
    try:
        resolved = p.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ApiError(404, "AUDIO_NOT_FOUND", "The audio file could not be found.")
    if not resolved.is_file():
        raise ApiError(400, "BAD_PATH", "Audio path is not a file.")
    if resolved.suffix.lower() not in ALLOWED_EXTENSIONS:
        raise ApiError(400, "UNSUPPORTED_MEDIA", f"Unsupported media type: {resolved.suffix}")
    return resolved


def _num(v, lo: float, hi: float, name: str) -> float:
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not (lo <= float(v) <= hi):
        raise ApiError(400, "BAD_REQUEST", f"Invalid {name}.")
    return float(v)


def parse_transcribe(body: dict, registry: Registry) -> tuple[dict, Path]:
    allowed = {"audioPath", "source", "options"}
    if set(body) - allowed:
        raise ApiError(400, "BAD_REQUEST", f"Unexpected fields: {sorted(set(body) - allowed)}")
    path = validate_media_path(body.get("audioPath"))
    payload: dict = {"audioPath": str(path)}
    src = body.get("source")
    if src is not None:
        if not isinstance(src, dict) or set(src) - {"start", "duration"}:
            raise ApiError(400, "BAD_REQUEST", "Invalid source range.")
        payload["source"] = {k: _num(src[k], 0, 86400, k) for k in ("start", "duration") if k in src}
    o = body.get("options") or {}
    if not isinstance(o, dict) or set(o) - {"model", "language", "device", "batchSize", "vad", "threads"}:
        raise ApiError(400, "BAD_REQUEST", "Invalid options.")
    model = str(o.get("model", "fast"))
    if not MODEL_RE.match(model) or model not in registry.whisper:
        raise ApiError(400, "MODEL_MISSING", "That quality level is not available in this engine.")
    lang = str(o.get("language", "auto")).lower()
    if not LANG_RE.match(lang):
        raise ApiError(400, "BAD_REQUEST", "Invalid language.")
    device = str(o.get("device", "auto")).lower()
    if device not in ("auto", "cpu", "cuda", "gpu"):
        raise ApiError(400, "BAD_REQUEST", "Invalid device.")
    vad = str(o.get("vad", "on"))
    if vad not in ("on", "pyannote", "off"):
        raise ApiError(400, "BAD_REQUEST", "Invalid skip-silence setting.")
    vad = "off" if vad == "off" else "pyannote"
    payload["options"] = {"model": model, "language": lang, "device": device, "vad": vad,
                          "batchSize": int(_num(o.get("batchSize", 0), 0, 64, "batchSize")),
                          "threads": int(_num(o.get("threads", 0), 0, 64, "threads"))}
    return payload, path


def parse_align(body: dict, registry: Registry) -> tuple[dict, Path]:
    if set(body) - {"audioPath", "source", "language", "segments"}:
        raise ApiError(400, "BAD_REQUEST", "Unexpected fields.")
    path = validate_media_path(body.get("audioPath"))
    lang = str(body.get("language", "")).lower()
    if not LANG_RE.match(lang) or lang == "auto":
        raise ApiError(400, "BAD_REQUEST", "A language is required for alignment.")
    if lang not in registry.align:
        raise ApiError(400, "NO_ALIGNMENT_MODEL", "Word alignment is not available for this language.")
    segs = body.get("segments")
    if not isinstance(segs, list) or not segs or len(segs) > 20000:
        raise ApiError(400, "BAD_REQUEST", "segments must be a non-empty list.")
    clean = []
    for s in segs:
        if not isinstance(s, dict) or not isinstance(s.get("text"), str) or len(s["text"]) > 2000:
            raise ApiError(400, "BAD_REQUEST", "Invalid segment.")
        clean.append({"text": s["text"], "start": _num(s.get("start"), 0, 86400, "start"),
                      "end": _num(s.get("end"), 0, 86400, "end")})
    payload = {"audioPath": str(path), "language": lang, "segments": clean}
    src = body.get("source")
    if isinstance(src, dict):
        payload["source"] = {k: _num(src[k], 0, 86400, k) for k in ("start", "duration") if k in src}
    return payload, path


class App:
    def __init__(self, token: str):
        self.token = token
        self.registry = Registry()
        self.jobs = JobManager()
        self.started = time.time()
        self.last_request = time.time()
        self.httpd: ThreadingHTTPServer | None = None

    def stop(self) -> None:
        self.jobs.shutdown()
        if self.httpd is not None:
            threading.Thread(target=self.httpd.shutdown, daemon=True).start()


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = "AutoCaptionBackend"
        sys_version = ""
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # route to our log, without query strings
            log.debug("%s %s", self.command, urlsplit(self.path).path)

        # -------------------------------------------------------------- utils
        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-AutoCaption-Token")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Cache-Control", "no-store")

        def _json(self, status: int, obj: dict) -> None:
            data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        def _error(self, status: int, code: str, message: str) -> None:
            self._json(status, {"ok": False, "error": {"code": code, "message": message}})

        def _guard(self) -> bool:
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                self._error(403, "FORBIDDEN", "Remote connections are not allowed.")
                return False
            host = (self.headers.get("Host") or "").split(":")[0]
            if host not in ("127.0.0.1", "localhost", "[::1]"):
                self._error(403, "FORBIDDEN", "Invalid host.")
                return False
            supplied = self.headers.get("X-AutoCaption-Token", "")
            if not secrets.compare_digest(supplied.encode(), app.token.encode()):
                self._error(401, "UNAUTHORIZED", "Missing or invalid session token.")
                return False
            app.last_request = time.time()
            return True

        def _body(self) -> dict:
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                raise ApiError(400, "BAD_REQUEST", "Invalid Content-Length.")
            if n > MAX_BODY:
                raise ApiError(413, "TOO_LARGE", "Request body too large.")
            raw = self.rfile.read(n) if n else b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise ApiError(400, "BAD_JSON", "Request body must be JSON.")
            if not isinstance(body, dict):
                raise ApiError(400, "BAD_JSON", "Request body must be a JSON object.")
            return body

        # ------------------------------------------------------------ methods
        def do_OPTIONS(self):  # CORS preflight; carries no data
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if not self._guard():
                return
            path = urlsplit(self.path).path.rstrip("/")
            try:
                if path == "/health":
                    active = app.jobs.active
                    self._json(200, {"ok": True, "product": "AutoCaption AE", "version": __version__,
                                     "apiVersion": API_VERSION, "pid": os.getpid(),
                                     "uptimeSec": round(time.time() - app.started),
                                     "workerRunning": app.jobs.worker.alive(),
                                     "activeJob": active.id if active and not active.done else None,
                                     "orphansCleaned": app.jobs.orphans_cleaned})
                elif path == "/manifest":
                    m = integrity.load_manifest() or {}
                    m = {k: m.get(k) for k in ("product", "backendVersion", "platform", "minExtensionVersion", "maxExtensionVersion")}
                    self._json(200, {"ok": True, "manifest": m})
                elif path == "/models":
                    self._json(200, {"ok": True, **app.registry.describe()})
                elif path == "/diagnostics":
                    self._json(200, {"ok": True, "diagnostics": sysinfo.diagnostics(app)})
                elif path.startswith("/job/"):
                    parts = path.split("/")
                    job_id = parts[2] if len(parts) > 2 else ""
                    if not JOB_ID_RE.match(job_id) or job_id not in app.jobs.jobs:
                        raise ApiError(404, "JOB_NOT_FOUND", "Unknown job.")
                    job = app.jobs.jobs[job_id]
                    if len(parts) == 4 and parts[3] == "events":
                        self._sse(job)
                    elif len(parts) == 3:
                        self._json(200, {"ok": True, "job": job.snapshot()})
                    else:
                        raise ApiError(404, "NOT_FOUND", "Unknown endpoint.")
                else:
                    raise ApiError(404, "NOT_FOUND", "Unknown endpoint.")
            except ApiError as e:
                self._error(e.status, e.code, str(e))
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as e:  # noqa: BLE001
                log.exception("GET %s failed", path)
                self._error(500, "INTERNAL", str(e))

        def do_POST(self):
            if not self._guard():
                return
            path = urlsplit(self.path).path.rstrip("/")
            try:
                body = self._body()
                if path == "/transcribe":
                    payload, p = parse_transcribe(body, app.registry)
                    job = app.jobs.submit("transcribe", payload, p)
                    self._json(202, {"ok": True, "jobId": job.id, "job": job.snapshot()})
                elif path == "/align":
                    payload, p = parse_align(body, app.registry)
                    job = app.jobs.submit("align", payload, p)
                    self._json(202, {"ok": True, "jobId": job.id, "job": job.snapshot()})
                elif path == "/cancel":
                    job_id = str(body.get("jobId", ""))
                    if not JOB_ID_RE.match(job_id):
                        raise ApiError(400, "BAD_REQUEST", "Invalid job id.")
                    job = app.jobs.cancel(job_id)
                    if job is None:
                        raise ApiError(404, "JOB_NOT_FOUND", "Unknown job.")
                    self._json(200, {"ok": True, "job": job.snapshot(include_result=False)})
                elif path == "/verify":
                    full = bool(body.get("full", False))
                    res = integrity.verify(full=full)
                    res["models"] = integrity.model_status()
                    res["compatibility"] = integrity.compatibility(body.get("extensionVersion"))
                    self._json(200, {"ok": True, "verify": res})
                elif path == "/stop-engine":
                    app.jobs.worker.kill()
                    self._json(200, {"ok": True})
                elif path == "/shutdown":
                    self._json(200, {"ok": True})
                    app.stop()
                else:
                    raise ApiError(404, "NOT_FOUND", "Unknown endpoint.")
            except ApiError as e:
                self._error(e.status, e.code, str(e))
            except BusyError as e:
                self._json(409, {"ok": False, "error": {"code": "BUSY", "message": str(e)}, "jobId": e.job_id})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as e:  # noqa: BLE001
                log.exception("POST %s failed", path)
                self._error(500, "INTERNAL", str(e))

        def _sse(self, job) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self._cors()
            self.end_headers()
            self.close_connection = True
            sent = 0
            while True:
                with job.cond:
                    pending = [e for e in job.events if e["seq"] > sent]
                    if not pending and not job.done:
                        job.cond.wait(15)
                        pending = [e for e in job.events if e["seq"] > sent]
                if pending:
                    for e in pending:
                        self.wfile.write(f"id: {e['seq']}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n".encode())
                    sent = pending[-1]["seq"]
                else:
                    self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()
                if job.done and not [e for e in job.events if e["seq"] > sent]:
                    return

    return Handler


def serve(port: int = 0, idle_exit_sec: int = 600) -> int:
    """Serve until shutdown. The panel pings /health every minute while open;
    with no requests and no job for idle_exit_sec the backend exits, so a
    reloaded or closed panel never leaves an orphaned engine behind."""
    from . import logs

    paths.configure_offline_environment()
    logger = logs.setup("backend", debug=os.environ.get("AUTOCAPTION_DEBUG") == "1")
    token = secrets.token_urlsafe(24)
    app = App(token)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app))
    httpd.daemon_threads = True
    app.httpd = httpd
    actual = httpd.server_address[1]
    logger.info("components: %s", sysinfo.component_versions())
    logger.info("backend %s listening on 127.0.0.1:%d (pid %d, python %s)", __version__, actual, os.getpid(),
                platform.python_version())
    sys.stdout.write(json.dumps({"event": "ready", "port": actual, "token": token, "pid": os.getpid(),
                                 "version": __version__, "apiVersion": API_VERSION}) + "\n")
    sys.stdout.flush()

    def parent_watch():
        # The panel holds our stdin. When it closes (panel reload, AE quit)
        # we shut down and release models instead of lingering.
        try:
            while sys.stdin.readline():
                pass
        except (OSError, ValueError):
            pass
        logger.info("parent closed stdin; shutting down")
        app.stop()

    # On Windows the launcher watches the parent process and its job object
    # ends us; reading stdin there would stall other I/O in this process.
    if os.environ.get("AUTOCAPTION_DETACHED") != "1" and sys.platform != "win32":
        threading.Thread(target=parent_watch, daemon=True).start()

    def idle_watch():
        while True:
            time.sleep(60)
            busy = app.jobs.active is not None and not app.jobs.active.done
            if not busy and time.time() - app.last_request > idle_exit_sec:
                logger.info("idle for too long; shutting down")
                app.stop()
                return

    threading.Thread(target=idle_watch, daemon=True).start()
    try:
        httpd.serve_forever(poll_interval=0.5)
    finally:
        app.jobs.shutdown()
        httpd.server_close()
    return 0
