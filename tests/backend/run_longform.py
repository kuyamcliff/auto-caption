"""Long-form test: 10 s .. 60 min through the real API.

Builds long inputs by concatenating the synthetic `long.wav` fixture (with
exact ground truth), then measures wall time, peak worker RAM (Linux /proc),
temp-file cleanup and timing accuracy for each length.

  python run_longform.py --cmd "python -m autocaption" --minutes 0.17,1,5,15,30,60
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from run_backend_tests import FIXTURES, Backend, stage_input, timing_errors  # noqa: E402


def make_input(minutes: float, out: Path) -> list[dict]:
    with wave.open(str(FIXTURES / "long.wav")) as w:
        params = w.getparams()
        frames = w.readframes(w.getnframes())
    exp = json.loads((FIXTURES / "long.expected.json").read_text())
    unit = len(frames) / (params.sampwidth * params.nchannels) / params.framerate
    target = minutes * 60
    words: list[dict] = []
    with wave.open(str(out), "wb") as o:
        o.setparams(params)
        t = 0.0
        while t < target - 1e-6:
            take = min(unit, target - t)
            n = int(take * params.framerate) * params.sampwidth * params.nchannels
            o.writeframes(frames[:n])
            words += [{"text": w["text"], "start": w["start"] + t, "end": w["end"] + t}
                      for w in exp["words"] if w["end"] <= take]
            t += take
    return words


def descendants(pid: int) -> list[int]:
    out = []
    for p in Path("/proc").iterdir():
        if p.name.isdigit():
            try:
                ppid = int((p / "stat").read_text().split(")")[1].split()[1])
            except (OSError, IndexError, ValueError):
                continue
            if ppid == pid:
                out.append(int(p.name))
                out += descendants(int(p.name))
    return out


def rss_mb(pid: int) -> float:
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024
    except OSError:
        pass
    return 0.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cmd", required=True)
    ap.add_argument("--minutes", default="0.17,1,5,15,30,60")
    ap.add_argument("--model", default="fast")
    ap.add_argument("--report", default="longform-report.json")
    args = ap.parse_args()
    temp_root = Path(tempfile.gettempdir()) / "AutoCaptionAE"
    be = Backend(shlex.split(args.cmd), dict(os.environ))
    rows = []
    try:
        for m in [float(x) for x in args.minutes.split(",")]:
            src = Path(tempfile.gettempdir()) / f"longform_{m}.wav"
            truth = make_input(m, src)
            staged = stage_input(src, temp_root)
            src.unlink()
            peak = {"mb": 0.0}
            stop = threading.Event()

            def sample():
                while not stop.is_set():
                    total = sum(rss_mb(p) for p in [be.proc.pid] + descendants(be.proc.pid))
                    peak["mb"] = max(peak["mb"], total)
                    time.sleep(0.5)

            th = threading.Thread(target=sample, daemon=True)
            th.start()
            t0 = time.monotonic()
            st, body = be.request("POST", "/transcribe", {"audioPath": str(staged), "options": {"model": args.model, "language": "en"}})
            final = be.events(body["jobId"])
            wall = time.monotonic() - t0
            stop.set()
            th.join()
            _, full = be.request("GET", f"/job/{body['jobId']}")
            res = full["job"].get("result") or {}
            errs = timing_errors(truth, res.get("words", []))
            row = {"minutes": m, "state": final["state"], "wallSec": round(wall, 1), "realtimeFactor": round(wall / (m * 60), 3),
                   "peakRamMB": round(peak["mb"]), "tempCleaned": not staged.exists(), "timings": res.get("timings"), **errs}
            rows.append(row)
            print(json.dumps(row), flush=True)
    finally:
        be.stop()
    Path(args.report).write_text(json.dumps(rows, indent=1))
    ok = all(r["state"] == "completed" and r["tempCleaned"] and r.get("startMedianMs", 1e9) <= 80 for r in rows)
    print("LONGFORM", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
