"""Write bin/manifest.json for an engine folder: versions and SHA-256 of every file
(launcher, engine.pak, bin/). Model entries inside engine.pak are listed in the
pak's own registry."""
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

    files = {}
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root).as_posix() if p.is_file() else ""
        if p.is_file() and rel != "bin/manifest.json" and "__pycache__" not in p.parts:
            files[p.relative_to(root).as_posix()] = {"sha256": sha256_of(p), "size": p.stat().st_size}

    manifest = {
        "product": "AutoCaption AE",
        "backendVersion": __version__,
        "minExtensionVersion": "1.0.0",
        "maxExtensionVersion": "1.x",
        "platform": args.platform,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        **versions,
        "files": files,
    }
    (root / "bin").mkdir(exist_ok=True)
    (root / "bin" / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"manifest: {len(files)} files, {sum(f['size'] for f in files.values()) / 1e9:.2f} GB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
