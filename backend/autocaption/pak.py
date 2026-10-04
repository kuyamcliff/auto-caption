"""engine.pak: the engine's code, models and data in one file.

The pak is a ZIP archive with every large entry stored uncompressed, so
models are read straight out of it with no unpacking step. A registry
(registry.json inside the pak) lists every entry with its SHA-256.

Optional add-on packs ("Accurate quality.pak", "More languages.pak") use the
same format without engine code; any *.pak next to engine.pak is merged in.

A few small items have to exist as real files for the libraries that use
them (the speech-detection checkpoint and sentence data, about 30 MB). They
are extracted once into a per-user cache, verified against the registry,
and reused on every later start.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import threading
import zipfile
from pathlib import Path

from . import paths


class PakError(Exception):
    pass


class Pak:
    def __init__(self, path: Path):
        if not path.is_file():
            raise PakError(f"{path.name} is missing")
        self.path = path
        try:
            self.zf = zipfile.ZipFile(path)
            self.registry = json.loads(self.zf.read("registry.json"))
        except (zipfile.BadZipFile, KeyError, ValueError, OSError) as exc:
            raise PakError(f"{path.name} is damaged") from exc
        self._lock = threading.Lock()

    @property
    def entries(self) -> dict:
        return self.registry.get("entries", {})

    def read(self, name: str) -> bytes:
        with self._lock:
            return self.zf.read(name)

    def has(self, name: str) -> bool:
        return name in self.entries

    def names(self, prefix: str) -> list[str]:
        return sorted(n for n in self.entries if n.startswith(prefix))

    def _stamp(self) -> str:
        st = self.path.stat()
        return f"{st.st_size}-{st.st_mtime_ns}"

    def extract(self, prefix: str) -> Path:
        """Extract the entries under prefix into the cache (once) and return the folder."""
        key = hashlib.sha1(f"{self._stamp()}:{prefix}".encode()).hexdigest()[:16]
        dest = paths.cache_dir() / key
        marker = dest / ".complete"
        if marker.is_file():
            return dest
        tmp = dest.with_name(dest.name + ".tmp")
        shutil.rmtree(tmp, ignore_errors=True)
        for name in self.names(prefix):
            data = self.read(name)
            if hashlib.sha256(data).hexdigest() != self.entries[name]["sha256"]:
                raise PakError(f"{name} is damaged")
            target = tmp / name[len(prefix):]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        tmp.mkdir(parents=True, exist_ok=True)
        (tmp / ".complete").write_text(prefix)
        shutil.rmtree(dest, ignore_errors=True)
        tmp.replace(dest)
        return dest

    def verify(self, prefix: str = "") -> dict:
        """Hash entries against the registry. Results are cached per pak stamp."""
        cache_file = paths.cache_dir() / f"verify-{hashlib.sha1(str(self.path).lower().encode()).hexdigest()[:10]}.json"
        try:
            cache = json.loads(cache_file.read_text())
        except (OSError, ValueError):
            cache = {}
        if cache.get("stamp") != self._stamp():
            cache = {"stamp": self._stamp(), "ok": {}}
        bad, checked = [], 0
        for name in self.names(prefix):
            checked += 1
            if cache["ok"].get(name):
                continue
            h = hashlib.sha256()
            with self._lock, self.zf.open(name) as f:
                for block in iter(lambda: f.read(1 << 20), b""):
                    h.update(block)
            if h.hexdigest() == self.entries[name]["sha256"]:
                cache["ok"][name] = True
            else:
                bad.append(name)
        try:
            cache_file.write_text(json.dumps(cache))
        except OSError:
            pass
        return {"ok": not bad, "checked": checked, "damaged": bad}


class PakSet:
    """engine.pak plus any add-on packs in the engine folder, read as one.

    Same interface as Pak: a merged registry, and every entry is read from
    the file that contains it.
    """

    def __init__(self, main: Pak, packs: list[Pak]):
        self.main = main
        self.packs = packs
        self.path = main.path
        reg = json.loads(json.dumps(main.registry))
        self._owner: dict[str, Pak] = {n: main for n in main.entries}
        for pk in packs:
            for section in ("speech", "timing", "notices"):
                reg.setdefault(section, {}).update(pk.registry.get(section, {}))
            reg.setdefault("entries", {}).update(pk.entries)
            for n in pk.entries:
                self._owner[n] = pk
        reg["packs"] = [pk.registry.get("pack", pk.path.stem) for pk in packs]
        self.registry = reg

    @property
    def entries(self) -> dict:
        return self.registry.get("entries", {})

    def _pak_for(self, prefix: str) -> Pak:
        for n, pk in self._owner.items():
            if n.startswith(prefix):
                return pk
        return self.main

    def read(self, name: str) -> bytes:
        return self._owner.get(name, self.main).read(name)

    def has(self, name: str) -> bool:
        return name in self.entries

    def names(self, prefix: str) -> list[str]:
        return sorted(n for n in self.entries if n.startswith(prefix))

    def extract(self, prefix: str) -> Path:
        return self._pak_for(prefix).extract(prefix)

    def verify(self, prefix: str = "") -> dict:
        out = {"ok": True, "checked": 0, "damaged": []}
        for pk in [self.main, *self.packs]:
            res = pk.verify(prefix)
            out["ok"] &= res["ok"]
            out["checked"] += res["checked"]
            out["damaged"] += res["damaged"]
        return out


def find_packs(folder: Path) -> list[Pak]:
    """Add-on packs next to engine.pak. A damaged or foreign file is skipped, never fatal."""
    import logging

    packs = []
    for f in sorted(folder.glob("*.pak")):
        if f.name.lower() == paths.PAK_NAME:
            continue
        try:
            pk = Pak(f)
        except PakError as exc:
            logging.getLogger("autocaption.pak").warning("ignoring %s: %s", f.name, exc)
            continue
        if pk.registry.get("pack"):
            packs.append(pk)
    return packs


_pak: PakSet | None = None
_pak_lock = threading.Lock()


def engine_pak() -> PakSet:
    global _pak
    with _pak_lock:
        if _pak is None:
            main = Pak(paths.pak_path())
            _pak = PakSet(main, find_packs(paths.pak_path().parent))
        return _pak


def prepare_runtime_data() -> None:
    """Point libraries that need on-disk data at the verified cache copy."""
    import os

    pak = engine_pak()
    nltk = pak.registry.get("nltk", {}).get("prefix")
    if nltk:
        os.environ["NLTK_DATA"] = str(pak.extract(nltk))
