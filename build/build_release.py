"""Assemble the AutoCaption AE release.

  python build/build_release.py --backend <built backend dir> --out <release dir>

Steps (each one logged): build the extension, run unit tests, collect
licenses, write the backend manifest (SHA-256 of every file), run the network
and placeholder audits, create extension.zip / backend.zip /
AutoCaptionAE_COMPLETE_v1.0.0.zip, generate checksums, verify the archives by
re-reading them, and report sizes.

The backend itself is produced by build/build_backend.py (see build_release.bat
for the full pipeline on Windows).
"""
from __future__ import annotations

import argparse
import email.parser
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


# ------------------------------------------------------------- licenses
def collect_licenses(backend: Path, out_licenses: Path) -> None:
    site = backend / "runtime" / "Lib" / "site-packages"
    lines = ["AutoCaption AE - third-party software", "=" * 38, "",
             "The backend bundles the following software. Each component remains under its own license;",
             "full license texts are in backend/licenses/third_party/<package>/.", ""]
    tp = backend / "licenses" / "third_party"
    tp.mkdir(parents=True, exist_ok=True)
    for dist in sorted(site.glob("*.dist-info"), key=lambda p: p.name.lower()):
        meta_path = dist / "METADATA"
        if not meta_path.exists():
            continue
        meta = email.parser.Parser().parsestr(meta_path.read_text(encoding="utf-8", errors="replace"))
        name, ver = meta.get("Name", dist.name), meta.get("Version", "")
        lic = meta.get("License-Expression") or (meta.get("License") or "").splitlines()[0:1]
        lic = lic if isinstance(lic, str) else (lic[0] if lic else "")
        if not lic or len(lic) > 80:
            classifiers = [c.split("::")[-1].strip() for c in meta.get_all("Classifier") or [] if c.startswith("License ::")]
            lic = ", ".join(classifiers) or (lic[:80] if lic else "see license file")
        lines.append(f"{name} {ver} -- {lic} -- {meta.get('Home-page') or meta.get('Project-URL', '')}".rstrip(" -"))
        files = [p for p in dist.rglob("*") if p.is_file() and re.search(r"(LICEN[CS]E|COPYING|NOTICE|AUTHORS)", p.name, re.I)]
        if files:
            d = tp / name
            d.mkdir(parents=True, exist_ok=True)
            for f in files:
                shutil.copy2(f, d / f.name)
    lines += ["", "Python runtime: CPython 3.11.9 embeddable distribution -- PSF License (runtime/LICENSE.txt)",
              "FFmpeg 9.0.2 (gyan.dev essentials build) -- GPL v3. Source: https://ffmpeg.org/download.html ;",
              "  build configuration and license: backend/licenses/ffmpeg/. FFmpeg is run as a separate program.",
              "NVIDIA cuBLAS / cuDNN redistributable DLLs -- NVIDIA software license (backend/licenses/nvidia/).",
              "Panel (extension): Preact (MIT). Panel code bundled with esbuild.", ""]
    (out_licenses / "third_party_licenses.txt").write_text("\n".join(lines), encoding="utf-8")
    shutil.copy2(out_licenses / "third_party_licenses.txt", backend / "licenses" / "third_party_licenses.txt")
    py_lic = backend / "runtime" / "LICENSE.txt"
    if py_lic.exists():
        shutil.copy2(py_lic, backend / "licenses" / "python-LICENSE.txt")

    mlines = ["AutoCaption AE - bundled models", "=" * 31, ""]
    for info in sorted((backend / "models").glob("**/model_info.json")):
        i = json.loads(info.read_text())
        size = sum(f["size"] for f in i.get("files", {}).values())
        mlines.append(f"{i['kind']:<8} {i['id']:<24} {gb(size):>9}  {i.get('license')}")
        mlines.append(f"         source: {i.get('source')}  revision: {i.get('revision')}")
        for fn, f in i.get("files", {}).items():
            mlines.append(f"         {fn}  sha256={f['sha256']}")
        mlines.append("")
    mlines += ["NLTK punkt_tab sentence tokenizer data -- Apache 2.0 (models/nltk).",
               "Note: the French/German/Spanish/Italian VoxPopuli alignment models are licensed CC BY-NC 4.0",
               "(non-commercial). English alignment (wav2vec2 base 960h) is MIT.", ""]
    (out_licenses / "models_licenses.txt").write_text("\n".join(mlines), encoding="utf-8")
    shutil.copy2(out_licenses / "models_licenses.txt", backend / "licenses" / "models_licenses.txt")
    (backend / "licenses" / "AutoCaptionAE-LICENSE.txt").write_text((REPO / "LICENSE").read_text(), encoding="utf-8")
    shutil.copy2(REPO / "LICENSE", out_licenses / "AutoCaptionAE-LICENSE.txt")


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


# ---------------------------------------------------------------- archives
def zip_dir(src: Path, dest: Path, arc_root: str, store_ext=(".bin", ".pt", ".pth", ".dll", ".pyd", ".exe", ".zip")) -> None:
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
    ap.add_argument("--backend", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--versions", help="build-versions.json from build_backend.py")
    ap.add_argument("--skip-tests", action="store_true")
    ap.add_argument("--backend-zip", action="store_true",
                    help="also write a separate backend.zip (duplicates ~5 GB; the COMPLETE zip already contains backend/)")
    args = ap.parse_args()
    backend_src = Path(args.backend).resolve()
    out = Path(args.out).resolve()
    pkg = out / "AutoCaptionAE"
    if out.exists():
        shutil.rmtree(out)
    pkg.mkdir(parents=True)
    reports = out / "reports"
    reports.mkdir()

    ext_dir = REPO / "extension"
    if not args.skip_tests:
        log("extension unit + host tests")
        subprocess.run(["npx", "vitest", "run"], cwd=ext_dir, check=True)
    log("build extension")
    subprocess.run(["node", "build.mjs", str(pkg / "extension")], cwd=ext_dir, check=True)
    (pkg / "extension" / "LICENSE.txt").write_text((REPO / "LICENSE").read_text())

    log("copy backend")
    # Hard links save disk on the build machine, but NLTK refuses multiply-linked
    # data files (CWE-59 hardening), so NLTK data is always copied.
    link_ok = _same_fs(backend_src, out)

    def copy_fn(src: str, dst: str) -> None:
        if link_ok and "nltk" not in Path(src).parts:
            os.link(src, dst)
        else:
            shutil.copy2(src, dst)

    shutil.copytree(backend_src, pkg / "backend", copy_function=copy_fn)
    for f in (HERE / "dist-files").iterdir():
        if f.is_dir():
            shutil.copytree(f, pkg / f.name)
        else:
            shutil.copy2(f, pkg / f.name)
    (pkg / "LICENSES").mkdir()
    collect_licenses(pkg / "backend", pkg / "LICENSES")

    log("manifest (SHA-256 of every backend file)")
    versions = args.versions or str(backend_src.parent / "build-versions.json")
    v = json.loads(Path(versions).read_text())
    v.pop("packages", None)
    tmpv = out / "versions.json"
    tmpv.write_text(json.dumps(v))
    # manifest.json is regenerated here, so remove any hard-linked copy first
    (pkg / "backend" / "manifest.json").unlink(missing_ok=True)
    subprocess.run([sys.executable, str(HERE / "make_manifest.py"), str(pkg / "backend"), "--versions", str(tmpv), "--platform", "win-x64"], check=True)
    tmpv.unlink()

    log("audits")
    net_ok = network_audit(reports / "network_audit.txt")
    ph_ok = placeholder_scan(reports / "placeholder_scan.txt")
    log(f"network audit: {'clean' if net_ok else 'UNEXPECTED REFERENCES'}; placeholder scan: {'clean' if ph_ok else 'MATCHES'}")
    if not (net_ok and ph_ok):
        raise SystemExit("audit failed; see reports/")

    log("archives")
    zip_dir(pkg / "extension", pkg / "extension.zip", "extension")
    if args.backend_zip:
        zip_dir(pkg / "backend", out / "backend.zip", "backend")
    sums = {}
    for p in sorted(pkg.rglob("*")):
        if p.is_file() and p.name != "checksums.txt" and not p.relative_to(pkg).as_posix().startswith("backend/"):
            sums[p.relative_to(pkg).as_posix()] = sha256(p)
    sums["backend/manifest.json"] = sha256(pkg / "backend" / "manifest.json")
    if args.backend_zip:
        sums["backend.zip (separate download)"] = sha256(out / "backend.zip")
    (pkg / "checksums.txt").write_text(
        "SHA-256 checksums. Every file inside backend/ is listed with its SHA-256 in backend/manifest.json.\n\n" +
        "\n".join(f"{h}  {n}" for n, h in sums.items()) + "\n", encoding="utf-8")
    complete = out / f"AutoCaptionAE_COMPLETE_v{VERSION}.zip"
    zip_dir(pkg, complete, "AutoCaptionAE")
    log("verifying archives (CRC of every member)")
    counts = {p.name: verify_zip(p) for p in (pkg / "extension.zip", out / "backend.zip", complete) if p.exists()}
    final = {
        "version": VERSION,
        "extensionSize": gb(dir_size(pkg / "extension")),
        "backendSize": gb(dir_size(pkg / "backend")),
        "modelSizes": {i.parent.relative_to(pkg / "backend" / "models").as_posix(): gb(dir_size(i.parent))
                       for i in sorted((pkg / "backend" / "models").glob("**/model_info.json"))},
        "cudaRuntimeSize": gb(dir_size(pkg / "backend" / "runtime" / "cuda")) if (pkg / "backend" / "runtime" / "cuda").exists() else None,
        "completeZip": {"path": str(complete), "size": gb(complete.stat().st_size), "bytes": complete.stat().st_size, "sha256": sha256(complete), "entries": counts[complete.name]},
        "backendZip": {"size": gb((out / "backend.zip").stat().st_size), "sha256": sums["backend.zip (separate download)"]} if args.backend_zip else None,
        "extensionZip": {"size": gb((pkg / "extension.zip").stat().st_size), "sha256": sums["extension.zip"]},
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
