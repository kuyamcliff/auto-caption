"""Job manager (server side). Lightweight: never imports torch."""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from . import paths

log = logging.getLogger("autocaption.jobs")

TERMINAL = {"completed", "cancelled", "failed"}
STAGE_TO_STATE = {"preparing": "preparing", "loading": "preparing", "detecting": "transcribing",
                  "transcribing": "transcribing", "aligning": "aligning", "building": "building"}
WORKER_IDLE_UNLOAD_SEC = 10 * 60
CANCEL_GRACE_SEC = 4.0
_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


class Job:
    def __init__(self, kind: str, payload: dict, input_path: Path):
        self.id = uuid.uuid4().hex[:16]
        self.kind = kind
        self.payload = payload
        self.input_path = input_path
        self.state = "queued"
        self.stage = "queued"
        self.message = "Waiting"
        self.progress: float | None = None
        self.result: dict | None = None
        self.error: dict | None = None
        self.created = time.time()
        self.updated = self.created
        self.events: list[dict] = []
        self.cond = threading.Condition()
        self._push()

    def _push(self) -> None:
        with self.cond:
            self.updated = time.time()
            self.events.append({"seq": len(self.events) + 1, **self.snapshot(include_result=False)})
            if len(self.events) > 500:  # keep memory bounded; SSE clients only need the tail
                self.events = self.events[-200:]
            self.cond.notify_all()

    def update(self, **kw) -> None:
        for k, v in kw.items():
            setattr(self, k, v)
        self._push()

    def snapshot(self, include_result: bool = True) -> dict:
        snap = {"jobId": self.id, "kind": self.kind, "state": self.state, "stage": self.stage,
                "message": self.message, "progress": self.progress, "error": self.error,
                "elapsedSec": round(time.time() - self.created, 1)}
        if include_result and self.result is not None:
            snap["result"] = self.result
        return snap

    @property
    def done(self) -> bool:
        return self.state in TERMINAL


class Worker:
    """Child process that hosts the models."""

    def __init__(self, on_event):
        self.on_event = on_event
        self.proc: subprocess.Popen | None = None
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.last_used = time.time()

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def ensure(self) -> None:
        with self.lock:
            if self.alive():
                return
            self.ready.clear()
            env = dict(os.environ)
            app_dir = str(Path(__file__).resolve().parent.parent)
            env["PYTHONPATH"] = app_dir
            env["PYTHONIOENCODING"] = "utf-8"
            self.proc = subprocess.Popen(
                [sys.executable, "-X", "utf8", "-m", "autocaption", "worker"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=app_dir, env=env,
                creationflags=_NO_WINDOW,
            )
            threading.Thread(target=self._drain_stderr, args=(self.proc,), daemon=True).start()
            threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()
        # First start after install can be slow (antivirus scanning the runtime).
        if not self.ready.wait(300):
            raise RuntimeError("worker did not start")

    @staticmethod
    def _drain_stderr(proc: subprocess.Popen) -> None:
        """Library warnings from the worker go to a size-capped log file."""
        path = paths.logs_dir() / "worker-stderr.log"
        try:
            if path.exists() and path.stat().st_size > 2_000_000:
                path.unlink()
        except OSError:
            pass
        assert proc.stderr is not None
        for raw in proc.stderr:
            try:
                with open(path, "ab") as f:
                    if f.tell() < 4_000_000:
                        f.write(raw)
            except OSError:
                pass

    def _read(self, proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            try:
                msg = json.loads(raw.decode("utf-8"))
            except ValueError:
                continue
            if msg.get("event") == "ready":
                self.ready.set()
                continue
            self.on_event(msg)
        code = proc.wait()
        self.on_event({"event": "worker-exit", "code": code})

    def send(self, msg: dict) -> None:
        self.last_used = time.time()
        if not self.alive() or self.proc.stdin is None:
            raise RuntimeError("worker not running")
        self.proc.stdin.write((json.dumps(msg) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def kill(self) -> None:
        with self.lock:
            if self.proc is not None and self.proc.poll() is None:
                try:
                    self.proc.kill()
                    self.proc.wait(10)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            self.proc = None
            self.ready.clear()


class JobManager:
    def __init__(self):
        self.jobs: dict[str, Job] = {}
        self.active: Job | None = None
        self.lock = threading.Lock()
        self.worker = Worker(self._on_event)
        self.orphans_cleaned = cleanup_orphans()
        threading.Thread(target=self._housekeeping, daemon=True).start()

    # ------------------------------------------------------------------ submit
    def submit(self, kind: str, payload: dict, input_path: Path) -> Job:
        with self.lock:
            if self.active is not None and not self.active.done:
                raise BusyError(self.active.id)
            job = Job(kind, payload, input_path)
            self.jobs[job.id] = job
            self.active = job
            # Bound history: drop old finished jobs (results can be large).
            for jid in [j.id for j in self.jobs.values() if j.done and time.time() - j.updated > 3600]:
                self.jobs.pop(jid, None)
        threading.Thread(target=self._start, args=(job,), daemon=True).start()
        return job

    def _start(self, job: Job) -> None:
        try:
            job.update(state="preparing", stage="starting", message="Starting caption engine")
            self.worker.ensure()
            if job.done:
                return
            self.worker.send({"cmd": job.kind, "jobId": job.id, **job.payload})
        except Exception as exc:  # noqa: BLE001
            log.exception("could not start job")
            self._finish(job, "failed", error={"code": "ENGINE_START_FAILED",
                                                "message": "The transcription engine could not start.",
                                                "detail": str(exc),
                                                "hint": ["The backend is incomplete.", "A model file is missing.",
                                                         "The GPU runtime is unavailable."]})

    def _on_event(self, msg: dict) -> None:
        ev = msg.get("event")
        if ev == "worker-exit":
            job = self.active
            if job is not None and not job.done:
                if job.state == "cancelling":
                    self._finish(job, "cancelled")
                else:
                    self._finish(job, "failed", error={
                        "code": "WORKER_CRASHED", "message": "The transcription engine stopped unexpectedly.",
                        "detail": f"worker exit code {msg.get('code')}",
                        "hint": ["The computer may have run out of memory.", "Try the Base model or the CPU device."]})
            return
        job = self.jobs.get(str(msg.get("jobId")))
        if job is None or job.done:
            return
        if ev == "progress":
            if job.state == "cancelling":
                return
            stage = msg.get("stage", "")
            job.update(state=STAGE_TO_STATE.get(stage, job.state), stage=stage,
                       message=msg.get("message", ""), progress=msg.get("progress"))
        elif ev == "result":
            self._finish(job, "completed", result=msg.get("result"))
        elif ev == "cancelled":
            self._finish(job, "cancelled")
        elif ev == "error":
            self._finish(job, "failed", error={k: msg.get(k) for k in ("code", "message", "detail", "hint")})

    def _finish(self, job: Job, state: str, result: dict | None = None, error: dict | None = None) -> None:
        with job.cond:
            if job.done:
                return
            job.result = result
            job.error = error
            msg = {"completed": "Done", "cancelled": "Cancelled", "failed": (error or {}).get("message", "Failed")}[state]
            job.update(state=state, stage=state, message=msg, progress=1.0 if state == "completed" else job.progress)
        cleanup_job_files(job.input_path)
        self.worker.last_used = time.time()
        log.info("job %s %s", job.id, state)

    # ------------------------------------------------------------------ cancel
    def cancel(self, job_id: str) -> Job | None:
        job = self.jobs.get(job_id)
        if job is None or job.done:
            return job
        job.update(state="cancelling", stage="cancelling", message="Cancelling")
        try:
            self.worker.send({"cmd": "cancel", "jobId": job_id})
        except RuntimeError:
            pass

        def enforce():
            deadline = time.time() + CANCEL_GRACE_SEC
            while time.time() < deadline:
                if job.done:
                    return
                time.sleep(0.1)
            log.info("job %s did not stop cooperatively; terminating worker", job_id)
            self.worker.kill()
            self._finish(job, "cancelled")

        threading.Thread(target=enforce, daemon=True).start()
        return job

    def shutdown(self) -> None:
        if self.active is not None and not self.active.done:
            self._finish(self.active, "cancelled")
        self.worker.kill()

    def _housekeeping(self) -> None:
        while True:
            time.sleep(30)
            busy = self.active is not None and not self.active.done
            if not busy and self.worker.alive() and time.time() - self.worker.last_used > WORKER_IDLE_UNLOAD_SEC:
                log.info("worker idle; releasing models")
                self.worker.kill()


class BusyError(Exception):
    def __init__(self, job_id: str):
        super().__init__("A transcription is already running.")
        self.job_id = job_id


# ---------------------------------------------------------------- temp files
def is_inside(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except (ValueError, OSError):
        return False


def cleanup_job_files(input_path: Path | None) -> None:
    """Delete the job's audio if (and only if) it lives in our temp area."""
    if input_path is None:
        return
    root = paths.temp_root()
    if not is_inside(input_path, root):
        return
    try:
        rel = input_path.resolve().relative_to(root.resolve())
        target = root / rel.parts[0] / rel.parts[1] if len(rel.parts) >= 3 else input_path
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
        elif target.exists():
            target.unlink()
    except OSError:
        log.warning("could not remove temp file")


def cleanup_orphans(max_age_sec: float = 600) -> int:
    """Remove temp job/render folders left by a crashed or closed session.

    A job decodes its input into memory as its first step, so anything older
    than a few minutes is never in use."""
    removed = 0
    root = paths.temp_root()
    now = time.time()
    for sub in ("jobs", "renders"):
        d = root / sub
        if not d.is_dir():
            continue
        for item in d.iterdir():
            try:
                age = now - item.stat().st_mtime
            except OSError:
                continue
            if age > max_age_sec:
                if item.is_dir():
                    shutil.rmtree(item, ignore_errors=True)
                else:
                    try:
                        item.unlink()
                    except OSError:
                        continue
                removed += 1
    if removed:
        log.info("removed %d orphaned temp item(s)", removed)
    return removed
