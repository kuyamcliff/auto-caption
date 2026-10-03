"""Backend integrity verification against manifest.json (SHA-256)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from . import __version__, paths


def load_manifest() -> dict | None:
    p = paths.manifest_path()
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _cache_path() -> Path:
    return paths.user_data_dir() / "verify-cache.json"


def verify(full: bool = False, only_prefix: str | None = None) -> dict:
    """Check every manifest file. Size is always checked; SHA-256 is checked for
    model files always and for everything when full=True. Hash results are
    cached per (size, mtime) so repeated verification is fast."""
    manifest = load_manifest()
    if manifest is None:
        return {"ok": False, "code": "MANIFEST_MISSING", "missing": [], "corrupt": [], "checked": 0}
    root = paths.backend_root()
    try:
        cache = json.loads(_cache_path().read_text(encoding="utf-8"))
        if cache.get("backendVersion") != manifest.get("backendVersion"):
            cache = {}
    except (OSError, ValueError):
        cache = {}
    entries = cache.setdefault("files", {})
    missing, corrupt = [], []
    checked = 0
    for rel, meta in manifest.get("files", {}).items():
        if only_prefix and not rel.startswith(only_prefix):
            continue
        p = root / rel
        checked += 1
        try:
            st = p.stat()
        except OSError:
            missing.append(rel)
            continue
        if st.st_size != meta.get("size"):
            corrupt.append(rel)
            continue
        if full or rel.startswith("models/"):
            stamp = f"{st.st_size}:{st.st_mtime_ns}"
            cached = entries.get(rel)
            if cached and cached.get("stamp") == stamp:
                digest = cached["sha256"]
            else:
                digest = sha256_file(p)
                entries[rel] = {"stamp": stamp, "sha256": digest}
            if digest != meta.get("sha256"):
                corrupt.append(rel)
    cache["backendVersion"] = manifest.get("backendVersion")
    try:
        _cache_path().write_text(json.dumps(cache), encoding="utf-8")
    except OSError:
        pass
    return {"ok": not missing and not corrupt, "missing": missing[:50], "corrupt": corrupt[:50],
            "missingCount": len(missing), "corruptCount": len(corrupt), "checked": checked}


def model_status(manifest: dict | None = None) -> list[dict]:
    """Per-model integrity rows for the verification screen."""
    manifest = manifest or load_manifest() or {}
    rows = []
    groups = [("whisper", m) for m in manifest.get("models", {})] + \
             [("align", lang) for lang in manifest.get("alignmentModels", {})]
    if manifest.get("vad"):
        groups.append(("vad", None))
    for kind, key in groups:
        prefix = f"models/{kind}/{key}/" if key else "models/vad/"
        res = verify(False, prefix)
        rows.append({"kind": kind, "id": key or "vad", "ok": res["ok"] and res["checked"] > 0,
                     "missing": res["missingCount"], "corrupt": res["corruptCount"]})
    return rows


def compatibility(extension_version: str | None) -> dict:
    manifest = load_manifest() or {}
    lo = manifest.get("minExtensionVersion", "1.0.0")
    hi = manifest.get("maxExtensionVersion", "1.x")
    if not extension_version:
        return {"compatible": True, "min": lo, "max": hi}
    return {"compatible": version_in_range(extension_version, lo, hi), "min": lo, "max": hi,
            "backendVersion": manifest.get("backendVersion", __version__)}


def _parse(v: str) -> tuple[int, int, int]:
    parts = (v.split("-")[0].split(".") + ["0", "0", "0"])[:3]
    out = []
    for p in parts:
        out.append(10**9 if p in ("x", "*") else int(p) if p.isdigit() else 0)
    return out[0], out[1], out[2]


def version_in_range(v: str, lo: str, hi: str) -> bool:
    return _parse(lo) <= _parse(v) <= _parse(hi)
