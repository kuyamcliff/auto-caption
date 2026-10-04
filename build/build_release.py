"""Assemble the AutoCaption AE release.

  python build/build_release.py --engine "<built AutoCaption Engine dir>" --out <release dir>

Steps (each one logged): run unit tests, build the extension, copy the engine
folder, write its manifest (SHA-256 of every file), run the network,
placeholder and wording audits, create AutoCaptionAE_v1.0.0_Windows.zip,
generate checksums, verify the archive by re-reading it, and report sizes.

Release layout:
  AutoCaptionAE/
    Install AutoCaption.bat, Read Me.txt, Changelog.txt, License.txt, checksums.txt
    extension/
    AutoCaption Engine/   (AutoCaption Engine.exe, engine.pak, bin/, Third-party notices.txt)
    tools/install.ps1

The engine folder is produced by build/build_backend.py.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
VERSION = "1.0.0"


def log(m: str) -> None:
    print(f"[release] {m}", flush=True)


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def dir_size(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def gb(n: int) -> str:
    return f"{n / 1e9:.2f} GB" if n >= 1e9 else f"{n / 1e6:.1f} MB"


# ---------------------------------------------------------------- audits
NET_PATTERNS = re.compile(r"https?://|fetch\(|axios|\brequests\.|urllib|curl|wget|hf_hub_download|snapshot_download|"
                          r"telemetry|analytics|sentry", re.I)


def network_audit(report: Path) -> bool:
    """Search our runtime code for network access. Our runtime code must only
    talk to 127.0.0.1; build-time downloaders live in build/."""
    runtime_files = list((REPO / "backend" / "autocaption").glob("*.py")) + \
        [p for p in (REPO / "extension" / "src").rglob("*") if p.suffix in (".ts", ".tsx")] + \
        [REPO / "extension" / "host" / "host.jsx"]
    # Reviewed, non-network matches: urllib.parse only parses request paths;
    # the paths.py docstring describes disabling downloads/telemetry.
    allowed = re.compile(r"urllib\.parse|download/telemetry path|127\.0\.0\.1|json-schema\.org|HF_HUB|TRANSFORMERS_OFFLINE|DO_NOT_TRACK|PYANNOTE_METRICS|"
                         r"no telemetry|telemetry or analytics|No telemetry|has no telemetry|localhost", re.I)
    hits, unexpected = [], []
    for f in runtime_files:
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if NET_PATTERNS.search(line):
                rel = f.relative_to(REPO).as_posix()
                hits.append(f"{rel}:{n}: {line.strip()[:140]}")
                if not allowed.search(line) and "fetch(this.url" not in line and "fetch(\"/rpc\"" not in line:
                    unexpected.append(hits[-1])
    build_hits = []
    for f in sorted(HERE.glob("*.py")):
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"https?://", line):
                build_hits.append(f"{f.relative_to(REPO).as_posix()}:{n}: {line.strip()[:140]}")
    text = ["NETWORK AUDIT", "=============", "",
            "Runtime code (backend/autocaption, extension/src, extension/host):"] + \
           [f"  {h}" for h in hits] + ["", "Unexpected runtime network references: " + (str(len(unexpected)) if unexpected else "none")] + \
           [f"  {u}" for u in unexpected] + ["", "Build-time downloads (build/, not shipped):"] + [f"  {h}" for h in build_hits] + [
           "", "Runtime environment hard-disables library downloads/telemetry: HF_HUB_OFFLINE=1, TRANSFORMERS_OFFLINE=1,",
           "HF_HUB_DISABLE_TELEMETRY=1, PYANNOTE_METRICS_ENABLED=0, DO_NOT_TRACK=1 (backend/autocaption/paths.py).",
           "The only socket the backend opens is its 127.0.0.1 API; the panel only connects to that address (CSP connect-src)."]
    report.write_text("\n".join(text) + "\n", encoding="utf-8")
    return not unexpected


PLACEHOLDERS = re.compile(r"\b(TODO|FIXME|IMPLEMENT ME|PLACEHOLDER|MOCK|STUB|COMING SOON|NOT IMPLEMENTED)\b")


def placeholder_scan(report: Path) -> bool:
    files = list((REPO / "backend" / "autocaption").glob("*.py")) + \
        [p for p in (REPO / "extension" / "src").rglob("*") if p.suffix in (".ts", ".tsx", ".css")] + \
        [REPO / "extension" / "host" / "host.jsx"] + list(HERE.glob("*.py")) + list((HERE / "dist-files").rglob("*.*"))
    hits = []
    for f in files:
        for n, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if PLACEHOLDERS.search(line) and "PLACEHOLDERS" not in line and "PLACEHOLDER SCAN" not in line:
                hits.append(f"{f.relative_to(REPO).as_posix()}:{n}: {line.strip()[:140]}")
    report.write_text("PLACEHOLDER SCAN (TODO FIXME IMPLEMENT PLACEHOLDER MOCK STUB COMING SOON NOT IMPLEMENTED)\n" +
                      ("\n".join(hits) if hits else "No matches in shipped source.") + "\n", encoding="utf-8")
    return not hits


# Words the panel and the user-facing files must never show (the engine's
# components are not named anywhere a user looks), and dashes the copy avoids.
TECH_WORDS = re.compile(r"whisper|pytorch|torch|ctranslate|pyannote|wav2vec|ffmpeg|cuda|cudnn|cublas|nltk|python|"
                        r"hugging ?face|silero|onnx|\bvad\b|\bmodels? folder\b|backend|\u2014|\u2013", re.I)


def wording_audit(report: Path) -> bool:
    files = [p for p in (REPO / "extension" / "src" / "ui").rglob("*") if p.suffix in (".ts", ".tsx")] + \
        [p for d in ("dist-files", "dist-lite") for p in (HERE / d).rglob("*") if p.is_file()] + \
        [HERE / "lite" / "Set Up Engine.bat"]
    hits = []
    for f in files:
        for n, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            code = line.strip()
            if code.startswith(("//", "*", "/*", "#")) or code.startswith("import "):
                continue
            # in source files only string literals and JSX text are user facing
            text = code if f.suffix not in (".ts", ".tsx") else " ".join(
                "".join(m) for m in re.findall(r'"([^"]*)"|\'([^\']*)\'|`([^`]*)`|>([^<>{}]+)<', code))
            # "// stored value, not shown" marks internal values compared in code
            if "dist-lite" in f.parts or f.name == "Set Up Engine.bat":
                text = re.sub(r"python(\.org)?", "", text, flags=re.I)  # the lite download runs on the user's own Python
            if TECH_WORDS.search(text) and not re.search(r"backendDir|PlayerDebugMode|// stored value, not shown", code):
                hits.append(f"{f.relative_to(REPO).as_posix()}:{n}: {code[:140]}")
    report.write_text("WORDING AUDIT (component names and long dashes in user-facing text)\n" +
                      ("\n".join(hits) if hits else "No matches.") + "\n", encoding="utf-8")
    return not hits


# ---------------------------------------------------------------- archives
def zip_dir(src: Path, dest: Path, arc_root: str, store_ext=(".bin", ".pt", ".pth", ".dll", ".pyd", ".exe", ".zip", ".pak")) -> None:
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as z:
        for p in sorted(src.rglob("*")):
            if p.is_file():
                arc = f"{arc_root}/{p.relative_to(src).as_posix()}"
                # already-compressed or high-entropy payloads are stored to keep builds fast
                ctype = zipfile.ZIP_STORED if p.suffix.lower() in store_ext and p.stat().st_size > 20_000_000 else zipfile.ZIP_DEFLATED
                z.write(p, arc, compress_type=ctype)


def verify_zip(path: Path) -> int:
    with zipfile.ZipFile(path) as z:
        bad = z.testzip()
        if bad:
            raise SystemExit(f"archive corrupt: {path.name}: {bad}")
        return len(z.infolist())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True, help="the built 'AutoCaption Engine' folder")
    ap.add_argument("--out", required=True)
    ap.add_argument("--versions", help="build-versions.json from build_backend.py")
    ap.add_argument("--skip-tests", action="store_true")
    ap.add_argument("--lite", action="store_true", help="the lite engine folder from build_lite.py (user's own Python)")
    args = ap.parse_args()
    engine_src = Path(args.engine).resolve()
    out = Path(args.out).resolve()
    pkg = out / "AutoCaptionAE"
    if out.exists():
        shutil.rmtree(out)
    pkg.mkdir(parents=True)
    reports = out / "reports"
    reports.mkdir()

    log("audits")
    net_ok = network_audit(reports / "network_audit.txt")
    ph_ok = placeholder_scan(reports / "placeholder_scan.txt")
    word_ok = wording_audit(reports / "wording_audit.txt")
    log(f"network audit: {'clean' if net_ok else 'UNEXPECTED REFERENCES'}; placeholder scan: {'clean' if ph_ok else 'MATCHES'}; "
        f"wording audit: {'clean' if word_ok else 'MATCHES'}")
    if not (net_ok and ph_ok and word_ok):
        raise SystemExit("audit failed; see reports/")

    ext_dir = REPO / "extension"
    if not args.skip_tests:
        log("extension unit + host tests")
        subprocess.run(["npx", "vitest", "run"], cwd=ext_dir, check=True)
    log("build extension")
    subprocess.run(["node", "build.mjs", str(pkg / "extension")], cwd=ext_dir, check=True)

    log("copy engine")
    link_ok = _same_fs(engine_src, out)

    def copy_fn(src: str, dst: str) -> None:
        if link_ok:
            os.link(src, dst)
        else:
            shutil.copy2(src, dst)

    engine = pkg / "AutoCaption Engine"
    shutil.copytree(engine_src, engine, copy_function=copy_fn, ignore=shutil.ignore_patterns("manifest.json"))
    for f in (HERE / ("dist-lite" if args.lite else "dist-files")).iterdir():
        if f.is_dir():
            shutil.copytree(f, pkg / f.name)
        elif f.name != "VERSION.txt":
            shutil.copy2(f, pkg / f.name)
    shutil.copy2(REPO / "LICENSE", pkg / "License.txt")

    log("manifest (SHA-256 of every engine file)")
    versions = args.versions or str(engine_src.parent / "build-versions.json")
    v = json.loads(Path(versions).read_text()) if Path(versions).is_file() else {"edition": "lite"}
    v.pop("packages", None)
    tmpv = out / "versions.json"
    tmpv.write_text(json.dumps(v))
    subprocess.run([sys.executable, str(HERE / "make_manifest.py"), str(engine), "--versions", str(tmpv), "--platform", "win-x64"], check=True)
    tmpv.unlink()

    log("checksums")
    sums = {}
    for p in sorted(pkg.rglob("*")):
        rel = p.relative_to(pkg).as_posix()
        if p.is_file() and p.name != "checksums.txt" and (not rel.startswith("AutoCaption Engine/") or p.parent == engine
                                                          or rel == "AutoCaption Engine/bin/manifest.json"):
            sums[rel] = sha256(p)
    (pkg / "checksums.txt").write_text(
        "SHA-256 checksums. Every file inside AutoCaption Engine/bin is listed with its SHA-256 in\n"
        "AutoCaption Engine/bin/manifest.json; the panel checks them with Settings > Engine > Verify.\n\n" +
        "\n".join(f"{h}  {n}" for n, h in sums.items()) + "\n", encoding="utf-8")

    log("archive")
    complete = out / f"AutoCaptionAE_v{VERSION}_Windows{'_Lite' if args.lite else ''}.zip"
    zip_dir(pkg, complete, "AutoCaptionAE")
    log("verifying archive (CRC of every member)")
    entries = verify_zip(complete)
    final = {
        "version": VERSION,
        "extensionSize": gb(dir_size(pkg / "extension")),
        "engineSize": gb(dir_size(engine)),
        "enginePakSize": gb((engine / "engine.pak").stat().st_size),
        "engineBinSize": gb(dir_size(engine / "bin")),
        "edition": "lite" if args.lite else "full",
        "gpuRuntimeSize": gb(dir_size(engine / "bin" / "cuda")) if (engine / "bin" / "cuda").exists() else None,
        "zip": {"path": str(complete), "size": gb(complete.stat().st_size), "bytes": complete.stat().st_size,
                "sha256": sha256(complete), "entries": entries},
    }
    (reports / "release.json").write_text(json.dumps(final, indent=1))
    print(json.dumps(final, indent=1))
    return 0


def _same_fs(a: Path, b: Path) -> bool:
    try:
        b.mkdir(parents=True, exist_ok=True)
        return os.stat(a).st_dev == os.stat(b).st_dev
    except OSError:
        return False


if __name__ == "__main__":
    sys.exit(main())
