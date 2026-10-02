"""End-to-end backend tests over the real HTTP API.

Starts the backend exactly like the panel does (spawn, read the ready line,
use the session token), then exercises security checks, transcription of
every fixture with timing-accuracy measurement, alignment, cancellation and
temp-file cleanup. Works against the dev tree or a packaged backend:

  python run_backend_tests.py --cmd "python -m autocaption"
  python run_backend_tests.py --cmd "wine backend/AutoCaptionBackend.exe"

Writes a JSON report (--report) with every measured number.
"""
from __future__ import annotations

import argparse
import difflib
import http.client
import json
import os
import shlex
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent / "fixtures" / "audio"

# Accuracy budget (seconds) for word onsets on the controlled synthetic fixtures.
# Chosen after measurement: wav2vec2 frames are 20 ms; observed medians are
# ~20-40 ms. A word "passes" when |error| <= WORD_TOL; a fixture passes when its
# median error <= MEDIAN_TOL and >= 90% of words are within WORD_TOL.
WORD_TOL = 0.15
MEDIAN_TOL = 0.08
# Stress fixtures (white noise at ~-24 dB SNR) mostly fail on *recognition*
# (Whisper Base mishears some words), not alignment. The requirement is that
# the job stays stable and the words it does recognise are aligned; recognition
# accuracy is reported, not gated.
STRESS = {"background_noise": {"accuracy": 0.5, "median": 0.08, "within": 60}}


class Backend:
    def __init__(self, cmd: list[str], env: dict):
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     env=env)
        line = self.proc.stdout.readline().decode("utf-8", "replace")
        while line and not line.startswith("{"):
            line = self.proc.stdout.readline().decode("utf-8", "replace")
        if not line:
            err = self.proc.stderr.read().decode("utf-8", "replace")[-3000:]
            raise RuntimeError(f"backend did not start:\n{err}")
        ready = json.loads(line)
        self.port, self.token = ready["port"], ready["token"]

    def request(self, method: str, path: str, body: dict | None = None, token: str | None = "default",
                host: str | None = None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=600)
        headers = {"Content-Type": "application/json"}
        if token == "default":
            headers["X-AutoCaption-Token"] = self.token
        elif token:
            headers["X-AutoCaption-Token"] = token
        if host:
            headers["Host"] = host
        conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
        r = conn.getresponse()
        data = r.read()
        conn.close()
        try:
            return r.status, json.loads(data)
        except ValueError:
            return r.status, {"raw": data[:200].decode("utf-8", "replace")}

    def events(self, job_id: str, on_event=None) -> dict:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3600)
        conn.request("GET", f"/job/{job_id}/events", headers={"X-AutoCaption-Token": self.token})
        r = conn.getresponse()
        last = None
        buf = b""
        while True:
            chunk = r.readline()
            if not chunk:
                break
            buf = chunk.strip()
            if buf.startswith(b"data: "):
                last = json.loads(buf[6:])
                if on_event:
                    on_event(last)
                if last["state"] in ("completed", "failed", "cancelled"):
                    break
        conn.close()
        return last

    def stop(self):
        try:
            self.request("POST", "/shutdown", {})
        except OSError:
            pass
        try:
            self.proc.wait(30)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def norm(w: str) -> str:
    return "".join(ch for ch in w.lower() if ch.isalnum() or ch in "$'")


def timing_errors(expected: list[dict], got: list[dict]) -> dict:
    a = [norm(w["text"]) for w in expected]
    b = [norm(w["text"]) for w in got]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    starts, ends = [], []
    for block in sm.get_matching_blocks():
        for k in range(block.size):
            e, g = expected[block.a + k], got[block.b + k]
            starts.append(abs(g["start"] - e["start"]))
            ends.append(abs(g["end"] - e["end"]))
    matched = len(starts)
    res = {"expectedWords": len(a), "gotWords": len(b), "matchedWords": matched,
           "wordAccuracy": round(matched / len(a), 3) if a else 1.0}
    if starts:
        s_sorted = sorted(starts)
        res |= {"startMedianMs": round(statistics.median(starts) * 1000, 1),
                "startMeanMs": round(statistics.mean(starts) * 1000, 1),
                "startP95Ms": round(s_sorted[min(len(s_sorted) - 1, int(0.95 * len(s_sorted)))] * 1000, 1),
                "startMaxMs": round(max(starts) * 1000, 1),
                "endMedianMs": round(statistics.median(ends) * 1000, 1),
                "withinTolPct": round(100 * sum(1 for s in starts if s <= WORD_TOL) / len(starts), 1)}
    return res


def stage_input(src: Path, temp_root: Path) -> Path:
    """Emulate the panel: AE renders into %TEMP%/AutoCaptionAE/renders/<id>/."""
    d = temp_root / "renders" / uuid.uuid4().hex[:12]
    d.mkdir(parents=True)
    dest = d / ("input" + src.suffix)
    shutil.copy2(src, dest)
    return dest


def to_backend_path(p: Path, wine: bool) -> str:
    if not wine:
        return str(p)
    # Paths inside the Wine prefix are on C:, like %TEMP% on real Windows.
    prefix = os.environ.get("WINEPREFIX", "")
    drive_c = str(Path(prefix) / "drive_c") if prefix else ""
    s = str(p)
    if drive_c and s.startswith(drive_c + "/"):
        return "C:" + s[len(drive_c):].replace("/", "\\")
    return "Z:" + s.replace("/", "\\")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cmd", required=True)
    ap.add_argument("--report", default="backend-test-report.json")
    ap.add_argument("--temp-root", help="AutoCaptionAE temp folder as seen from this host")
    ap.add_argument("--wine", action="store_true", help="translate paths to Z:\\ for a Wine-hosted backend")
    ap.add_argument("--fixtures", default="all")
    ap.add_argument("--model", default="base")
    ap.add_argument("--skip-long", action="store_true")
    args = ap.parse_args()

    env = dict(os.environ)
    temp_root = Path(args.temp_root) if args.temp_root else Path(tempfile.gettempdir()) / "AutoCaptionAE"
    results: dict = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "cmd": args.cmd, "checks": [], "fixtures": {}}
    failures = 0

    def check(name: str, ok: bool, detail: str = ""):
        nonlocal failures
        results["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""), flush=True)
        if not ok:
            failures += 1

    t0 = time.monotonic()
    be = Backend(shlex.split(args.cmd), env)
    check("backend starts and prints ready line", True, f"port {be.port}, {time.monotonic() - t0:.1f}s")
    try:
        st, body = be.request("GET", "/health", token=None)
        check("rejects missing token", st == 401, str(st))
        st, body = be.request("GET", "/health", token="wrong")
        check("rejects wrong token", st == 401, str(st))
        st, body = be.request("GET", "/health", host="evil.example.com")
        check("rejects foreign Host header (DNS rebinding)", st == 403, str(st))
        st, body = be.request("GET", "/health")
        check("health", st == 200 and body.get("ok"), json.dumps({k: body.get(k) for k in ("version", "apiVersion")}))
        st, body = be.request("GET", "/models")
        names = [m["id"] for m in body.get("whisper", [])]
        check("models lists base and small", st == 200 and {"base", "small"} <= set(names), ",".join(names))
        langs = [m["language"] for m in body.get("alignment", [])]
        check("alignment registry includes en", "en" in langs, ",".join(langs))
        st, body = be.request("GET", "/manifest")
        check("manifest endpoint", st == 200 and body["manifest"].get("product") == "AutoCaption AE")
        st, body = be.request("POST", "/verify", {"extensionVersion": "1.0.0"})
        v = body.get("verify", {})
        check("verify (sizes + model SHA-256)", st == 200 and v.get("ok"), f"{v.get('checked')} files")
        check("compatibility 1.0.0 accepted", v.get("compatibility", {}).get("compatible") is True)
        st, body = be.request("POST", "/verify", {"extensionVersion": "2.0.0"})
        check("compatibility 2.0.0 rejected", body.get("verify", {}).get("compatibility", {}).get("compatible") is False)
        st, body = be.request("POST", "/transcribe", {"audioPath": "relative/file.wav"})
        check("rejects relative path", st == 400, body.get("error", {}).get("code", ""))
        st, body = be.request("POST", "/transcribe", {"audioPath": to_backend_path(Path("/etc/../etc/passwd"), args.wine)})
        check("rejects traversal / non-media path", st in (400, 404), body.get("error", {}).get("code", ""))
        st, body = be.request("POST", "/transcribe", {"audioPath": "\\\\.\\PhysicalDrive0"})
        check("rejects device path", st == 400, body.get("error", {}).get("code", ""))
        st, body = be.request("POST", "/transcribe", {"audioPath": "/x.wav", "evil": 1})
        check("rejects unexpected fields", st == 400)
        st, body = be.request("GET", "/job/../../etc")
        check("rejects malformed job id", st == 404)
        st, body = be.request("POST", "/cancel", {"jobId": "not-a-job"})
        check("cancel validates job id", st == 400)

        fixtures = sorted(p.stem.replace(".expected", "") for p in FIXTURES.glob("*.expected.json"))
        if args.fixtures != "all":
            fixtures = [f for f in fixtures if f in args.fixtures.split(",")]
        if args.skip_long:
            fixtures = [f for f in fixtures if f != "long"]
        for name in fixtures:
            exp = json.loads((FIXTURES / f"{name}.expected.json").read_text())
            staged = stage_input(FIXTURES / f"{name}.wav", temp_root)
            t1 = time.monotonic()
            st, body = be.request("POST", "/transcribe", {"audioPath": to_backend_path(staged, args.wine),
                                                          "options": {"model": args.model, "language": "en"}})
            if st != 202:
                check(f"{name}: submit", False, json.dumps(body))
                continue
            stages = []
            final = be.events(body["jobId"], lambda e: stages.append(e["state"]) if not stages or stages[-1] != e["state"] else None)
            wall = time.monotonic() - t1
            st, full = be.request("GET", f"/job/{body['jobId']}")
            job = full.get("job", {})
            res = job.get("result") or {}
            cleaned = not staged.exists() and not staged.parent.exists()
            entry = {"state": final["state"] if final else None, "wallSec": round(wall, 2), "stages": stages,
                     "tempCleaned": cleaned, "warnings": [w["code"] for w in res.get("warnings", [])],
                     "timings": res.get("timings")}
            if name == "silence":
                ok = job.get("state") == "completed" and not res.get("words") or (job.get("state") == "failed")
                entry["words"] = len(res.get("words", []))
                check("silence: completes without inventing words", ok and len(res.get("words", [])) == 0,
                      f"state={job.get('state')} words={len(res.get('words', []))} "
                      f"err={(job.get('error') or {}).get('code')}")
            else:
                errs = timing_errors(exp["words"], res.get("words", []))
                entry |= errs
                med = errs.get("startMedianMs", 1e9) / 1000
                lim = STRESS.get(name, {"accuracy": 0.8, "median": MEDIAN_TOL, "within": 90})
                ok = (job.get("state") == "completed" and errs["wordAccuracy"] >= lim["accuracy"]
                      and med <= lim["median"] and errs.get("withinTolPct", 0) >= lim["within"])
                check(f"{name}: timing" + (" (stress)" if name in STRESS else ""), ok,
                      f"words {errs['matchedWords']}/{errs['expectedWords']}, start median {errs.get('startMedianMs')} ms,"
                      f" p95 {errs.get('startP95Ms')} ms, max {errs.get('startMaxMs')} ms, "
                      f"{errs.get('withinTolPct')}% within {int(WORD_TOL * 1000)} ms, {wall:.1f}s")
            check(f"{name}: temp input removed", cleaned)
            ts = [w["timingSource"] for w in res.get("words", [])]
            entry["timingSources"] = {k: ts.count(k) for k in set(ts)}
            results["fixtures"][name] = entry

        # numbers: ensure tokens are kept verbatim and get spoken-length timing
        num = results["fixtures"].get("numbers")
        if num:
            check("numbers: '$25'/'1999'/'42' timing covers spoken duration", num.get("startMedianMs", 1e9) <= 80,
                  f"median {num.get('startMedianMs')} ms")

        # alignment-only endpoint (imported text)
        exp = json.loads((FIXTURES / "clean_english.expected.json").read_text())
        staged = stage_input(FIXTURES / "clean_english.wav", temp_root)
        text = " ".join(w["text"] for w in exp["words"])
        st, body = be.request("POST", "/align", {"audioPath": to_backend_path(staged, args.wine), "language": "en",
                                                 "segments": [{"start": 0.0, "end": exp["durationSec"], "text": text}]})
        final = be.events(body["jobId"]) if st == 202 else None
        st, full = be.request("GET", f"/job/{body.get('jobId')}") if st == 202 else (st, {})
        errs = timing_errors(exp["words"], (full.get("job", {}).get("result") or {}).get("words", []))
        check("align endpoint (known text)", errs.get("matchedWords") == len(exp["words"]) and
              errs.get("startMedianMs", 1e9) <= 80, f"median {errs.get('startMedianMs')} ms")
        results["fixtures"]["align_known_text"] = errs

        # one job at a time
        long_src = FIXTURES / "long.wav"
        if long_src.exists():
            staged = stage_input(long_src, temp_root)
            st, body = be.request("POST", "/transcribe", {"audioPath": to_backend_path(staged, args.wine),
                                                          "options": {"model": args.model, "language": "en"}})
            job_id = body.get("jobId")
            st2, body2 = be.request("POST", "/transcribe", {"audioPath": to_backend_path(staged, args.wine)})
            check("second concurrent job is refused (409)", st2 == 409, str(st2))
            # wait until real transcription work is happening, then cancel
            deadline = time.time() + 120
            while time.time() < deadline:
                _, j = be.request("GET", f"/job/{job_id}")
                if j["job"]["state"] in ("transcribing", "aligning"):
                    break
                time.sleep(0.2)
            t_c = time.monotonic()
            be.request("POST", "/cancel", {"jobId": job_id})
            final = be.events(job_id)
            dt = time.monotonic() - t_c
            check("cancellation stops the job", final and final["state"] == "cancelled", f"{dt:.2f}s")
            time.sleep(0.3)
            check("cancelled job's temp input removed", not staged.exists())
            # engine still usable after cancel
            staged = stage_input(FIXTURES / "short.wav", temp_root)
            st, body = be.request("POST", "/transcribe", {"audioPath": to_backend_path(staged, args.wine),
                                                          "options": {"model": args.model, "language": "en"}})
            final = be.events(body["jobId"]) if st == 202 else None
            check("engine works after cancellation", final and final["state"] == "completed")

            if not args.skip_long:
                staged = stage_input(long_src, temp_root)
                t1 = time.monotonic()
                st, body = be.request("POST", "/transcribe", {"audioPath": to_backend_path(staged, args.wine),
                                                              "options": {"model": args.model, "language": "auto"}})
                final = be.events(body["jobId"])
                wall = time.monotonic() - t1
                _, full = be.request("GET", f"/job/{body['jobId']}")
                res = full["job"].get("result") or {}
                exp = json.loads((FIXTURES / "long.expected.json").read_text())
                errs = timing_errors(exp["words"], res.get("words", []))
                results["fixtures"]["long"] = errs | {"wallSec": round(wall, 1), "timings": res.get("timings"),
                                                      "language": res.get("language")}
                check("long (5 min, auto language): timing", errs.get("startMedianMs", 1e9) <= 80 and
                      errs["wordAccuracy"] >= 0.9,
                      f"{errs['matchedWords']}/{errs['expectedWords']} words, median {errs.get('startMedianMs')} ms, "
                      f"p95 {errs.get('startP95Ms')} ms, {wall:.1f}s wall, lang={res.get('language')}")

        st, body = be.request("GET", "/diagnostics")
        d = body.get("diagnostics", {})
        check("diagnostics endpoint", st == 200 and "backendVersion" in d,
              f"cpu={d.get('cpu')}, ram={d.get('ramGB')}GB, ffmpeg={d.get('ffmpeg')}")
        check("diagnostics contain no session token", be.token not in json.dumps(body))
    finally:
        be.stop()
    results["failures"] = failures
    results["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
    Path(args.report).write_text(json.dumps(results, indent=1))
    print(f"\n{len(results['checks']) - failures}/{len(results['checks'])} checks passed")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
