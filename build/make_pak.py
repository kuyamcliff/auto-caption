"""Build engine.pak: engine code, models and data in one file.

  python build/make_pak.py <models_stage_dir> <out/engine.pak>

<models_stage_dir> is the output of fetch_models.py (contains models/).
Large entries are stored uncompressed so the engine reads them in place.
Word-timing weights are stored at half precision (converted back to full
precision when loaded); the engine's timing tests are re-run on the result.
Must run with CPython 3.11 (the bytecode is precompiled for the runtime).
"""
from __future__ import annotations

import hashlib
import io
import json
import py_compile
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "backend"))
from autocaption import __version__  # noqa: E402

SPEECH = {
    "fast": {"src": "whisper/base", "label": "Fast", "description": "Quickest results"},
    "accurate": {"src": "whisper/small", "label": "Accurate", "description": "Best for difficult audio"},
}
TIMING_LABELS = {"en": "English", "fr": "French", "de": "German", "es": "Spanish", "it": "Italian"}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def timing_weights_fp16(model_dir: Path, info: dict) -> bytes:
    import torch
    import torchaudio
    from torchaudio.pipelines._wav2vec2 import utils as w2v_utils

    bundle = getattr(torchaudio.pipelines, info["bundle"])
    remove = getattr(bundle, "_remove_aux_axis", None)
    state = w2v_utils._get_state_dict(bundle._path, {"model_dir": str(model_dir)}, remove)
    state = {k: (v.half() if v.is_floating_point() else v) for k, v in state.items()}
    buf = io.BytesIO()
    torch.save(state, buf)
    return buf.getvalue()


def main() -> int:
    if sys.version_info[:2] != (3, 11):
        raise SystemExit("make_pak.py must run on CPython 3.11 (bytecode is precompiled for the runtime)")
    stage = Path(sys.argv[1]) / "models"
    out = Path(sys.argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)
    entries: dict[str, dict] = {}
    registry: dict = {"engineVersion": __version__, "speech": {}, "timing": {}, "notices": {}}
    tmp = out.with_suffix(".tmp")

    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
        def put(name: str, data: bytes, track: bool = True) -> None:
            z.writestr(zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0)), data, compress_type=zipfile.ZIP_STORED)
            if track:
                entries[name] = {"sha256": sha256(data), "size": len(data)}

        # engine code: sources + legacy-location bytecode that zipimport can use
        with tempfile.TemporaryDirectory() as td:
            for src in sorted((REPO / "backend" / "autocaption").glob("*.py")):
                data = src.read_bytes()
                put(f"app/autocaption/{src.name}", data, track=False)
                pyc = Path(td) / (src.stem + ".pyc")
                py_compile.compile(str(src), cfile=str(pyc), dfile=f"autocaption/{src.name}", doraise=True,
                                   invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
                put(f"app/autocaption/{src.stem}.pyc", pyc.read_bytes(), track=False)

        for key, spec in SPEECH.items():
            src = stage / spec["src"]
            info = json.loads((src / "model_info.json").read_text())
            prefix = f"models/speech/{key}/"
            for f in ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt"):
                put(prefix + f, (src / f).read_bytes())
            registry["speech"][key] = {"label": spec["label"], "description": spec["description"], "prefix": prefix}
            registry["notices"][f"speech/{key}"] = {"source": info.get("source"), "revision": info.get("revision"),
                                                    "license": info.get("license")}
            print(f"speech/{key}: {sum(entries[n]['size'] for n in entries if n.startswith(prefix)) / 1e6:.0f} MB")

        for lang_dir in sorted((stage / "align").iterdir()):
            info = json.loads((lang_dir / "model_info.json").read_text())
            entry = f"models/timing/{lang_dir.name}/weights.pt"
            data = timing_weights_fp16(lang_dir, info)
            put(entry, data)
            registry["timing"][lang_dir.name] = {"label": TIMING_LABELS.get(lang_dir.name, lang_dir.name),
                                                 "bundle": info["bundle"], "entry": entry}
            registry["notices"][f"timing/{lang_dir.name}"] = {"source": info.get("source"), "license": info.get("license")}
            print(f"timing/{lang_dir.name}: {len(data) / 1e6:.0f} MB (half precision)")

        vad = stage / "vad"
        put("models/vad/pytorch_model.bin", (vad / "pytorch_model.bin").read_bytes())
        registry["vad"] = {"prefix": "models/vad/"}
        registry["notices"]["vad"] = json.loads((vad / "model_info.json").read_text()).get("license")

        for f in sorted((stage / "nltk").rglob("*")):
            if f.is_file():
                put("data/nltk/" + f.relative_to(stage / "nltk").as_posix(), f.read_bytes())
        registry["nltk"] = {"prefix": "data/nltk/"}

        put("data/selftest.wav", (REPO / "backend" / "selftest" / "selftest.wav").read_bytes())
        registry["selftest"] = "data/selftest.wav"
        registry["entries"] = entries
        put("registry.json", json.dumps(registry, indent=1).encode(), track=False)
    tmp.replace(out)
    print(f"engine.pak: {out.stat().st_size / 1e9:.2f} GB, {len(entries)} verified entries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
