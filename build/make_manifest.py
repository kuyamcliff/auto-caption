"""Write backend/manifest.json: versions, model registry and SHA-256 of every file."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
from autocaption import __version__  # noqa: E402


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("backend_dir")
    ap.add_argument("--versions", required=True, help="JSON file with runtime/library versions")
    ap.add_argument("--platform", default="win-x64")
    args = ap.parse_args()
    root = Path(args.backend_dir).resolve()
    versions = json.loads(Path(args.versions).read_text(encoding="utf-8"))

    models, align, vad = {}, {}, None
    for info_path in sorted((root / "models").glob("**/model_info.json")):
        info = json.loads(info_path.read_text(encoding="utf-8"))
        rel = info_path.parent.relative_to(root).as_posix()
        entry = {"path": rel, "label": info["label"], "revision": info.get("revision"),
                 "source": info.get("source"), "license": info.get("license"),
                 "sizeBytes": sum(f["size"] for f in info.get("files", {}).values())}
        if info["kind"] == "whisper":
            models[info["id"]] = entry
        elif info["kind"] == "align":
            align[info["id"]] = entry | {"bundle": info.get("bundle")}
        elif info["kind"] == "vad":
            vad = entry

    files = {}
    for p in sorted(root.rglob("*")):
        if p.is_file() and p.name != "manifest.json" and "__pycache__" not in p.parts:
            files[p.relative_to(root).as_posix()] = {"sha256": sha256_of(p), "size": p.stat().st_size}

    manifest = {
        "product": "AutoCaption AE",
        "backendVersion": __version__,
        "minExtensionVersion": "1.0.0",
        "maxExtensionVersion": "1.x",
        "platform": args.platform,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        **versions,
        "models": models,
        "alignmentModels": align,
        "vad": vad,
        "files": files,
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"manifest: {len(files)} files, {sum(f['size'] for f in files.values()) / 1e9:.2f} GB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
