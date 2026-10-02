"""Build-time model fetcher.

Downloads every model the backend ships with into <out>/models and writes a
model_info.json next to each one (source, revision, license, sha256, size).
This is the ONLY place in the project that downloads models; the runtime never
does. Re-running is cheap: files that already match their recorded size are kept.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

# Pinned model sources -------------------------------------------------------

WHISPER_MODELS = {
    "base": {
        "repo": "Systran/faster-whisper-base",
        "revision": "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
        "files": ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"],
        "license": "MIT (OpenAI Whisper weights, converted to CTranslate2 by SYSTRAN)",
        "label": "Base",
    },
    "small": {
        "repo": "Systran/faster-whisper-small",
        "revision": "536b0662742c02347bc0e980a01041f333bce120",
        "files": ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"],
        "license": "MIT (OpenAI Whisper weights, converted to CTranslate2 by SYSTRAN)",
        "label": "Small",
    },
}

TORCHAUDIO_BASE = "https://download.pytorch.org/torchaudio/models/"
ALIGN_MODELS = {
    "en": ("WAV2VEC2_ASR_BASE_960H", "wav2vec2_fairseq_base_ls960_asr_ls960.pth",
           "MIT (fairseq wav2vec 2.0, distributed by torchaudio)", "English"),
    "fr": ("VOXPOPULI_ASR_BASE_10K_FR", "wav2vec2_voxpopuli_base_10k_asr_fr.pt",
           "CC BY-NC 4.0 (VoxPopuli, distributed by torchaudio)", "French"),
    "de": ("VOXPOPULI_ASR_BASE_10K_DE", "wav2vec2_voxpopuli_base_10k_asr_de.pt",
           "CC BY-NC 4.0 (VoxPopuli, distributed by torchaudio)", "German"),
    "es": ("VOXPOPULI_ASR_BASE_10K_ES", "wav2vec2_voxpopuli_base_10k_asr_es.pt",
           "CC BY-NC 4.0 (VoxPopuli, distributed by torchaudio)", "Spanish"),
    "it": ("VOXPOPULI_ASR_BASE_10K_IT", "wav2vec2_voxpopuli_base_10k_asr_it.pt",
           "CC BY-NC 4.0 (VoxPopuli, distributed by torchaudio)", "Italian"),
}

NLTK_PUNKT_URL = "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/tokenizers/punkt_tab.zip"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def remote_size(url: str) -> int | None:
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=60) as r:
        n = r.headers.get("Content-Length")
    return int(n) if n else None


def download(url: str, dest: Path, expected_size: int | None = None) -> None:
    if expected_size is None:
        expected_size = remote_size(url)
    if dest.exists() and (expected_size is None or dest.stat().st_size == expected_size):
        print(f"  cached  {dest.name}")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"  fetch   {url}")
    # Large transfers can be cut mid-stream; resume with Range requests.
    for attempt in range(8):
        have = tmp.stat().st_size if tmp.exists() else 0
        if expected_size is not None and have == expected_size:
            break
        req = urllib.request.Request(url, headers={"Range": f"bytes={have}-"} if have else {})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                mode = "ab" if have and r.status == 206 else "wb"
                with open(tmp, mode) as f:
                    shutil.copyfileobj(r, f, 1 << 20)
            if expected_size is None:
                break
        except OSError as exc:
            print(f"  retry   ({attempt + 1}) {exc}")
    if expected_size is not None and tmp.stat().st_size != expected_size:
        raise RuntimeError(f"size mismatch for {url}: {tmp.stat().st_size} != {expected_size}")
    tmp.replace(dest)


def fetch_whisper(models_dir: Path) -> None:
    from huggingface_hub import HfApi

    api = HfApi()
    for key, spec in WHISPER_MODELS.items():
        print(f"Whisper {key}")
        info = api.model_info(spec["repo"], revision=spec["revision"], files_metadata=True)
        sizes = {s.rfilename: s.size for s in info.siblings}
        out = models_dir / "whisper" / key
        files = {}
        for name in spec["files"]:
            url = f"https://huggingface.co/{spec['repo']}/resolve/{spec['revision']}/{name}"
            download(url, out / name, sizes.get(name))
            files[name] = {"sha256": sha256_of(out / name), "size": (out / name).stat().st_size}
        write_info(out, {
            "kind": "whisper", "id": key, "label": spec["label"], "format": "ctranslate2",
            "source": f"https://huggingface.co/{spec['repo']}", "revision": spec["revision"],
            "license": spec["license"], "files": files,
        })


def fetch_align(models_dir: Path) -> None:
    for lang, (bundle, filename, lic, label) in ALIGN_MODELS.items():
        print(f"Alignment {lang}")
        out = models_dir / "align" / lang
        download(TORCHAUDIO_BASE + filename, out / filename)
        write_info(out, {
            "kind": "align", "id": lang, "label": label, "format": "torchaudio",
            "bundle": bundle, "source": TORCHAUDIO_BASE + filename, "revision": filename,
            "license": lic,
            "files": {filename: {"sha256": sha256_of(out / filename), "size": (out / filename).stat().st_size}},
        })


def fetch_vad(models_dir: Path) -> None:
    """The pyannote segmentation weights ship inside the whisperx wheel; copy them
    out so they are versioned/checksummed like every other model."""
    import whisperx

    src = Path(whisperx.__file__).parent / "assets" / "pytorch_model.bin"
    out = models_dir / "vad"
    out.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, out / "pytorch_model.bin")
    write_info(out, {
        "kind": "vad", "id": "pyannote-segmentation", "label": "Voice activity detection",
        "format": "pyannote", "source": "whisperx package assets (pyannote/segmentation)",
        "revision": f"whisperx-{whisperx.__version__ if hasattr(whisperx, '__version__') else '3.8.6'}",
        "license": "MIT (pyannote.audio segmentation model)",
        "files": {"pytorch_model.bin": {"sha256": sha256_of(out / "pytorch_model.bin"),
                                         "size": (out / "pytorch_model.bin").stat().st_size}},
    })


def fetch_nltk(models_dir: Path) -> None:
    print("NLTK punkt_tab")
    out = models_dir / "nltk"
    zpath = models_dir.parent / "_punkt_tab.zip"
    if not (out / "tokenizers" / "punkt_tab").exists():
        download(NLTK_PUNKT_URL, zpath)
        (out / "tokenizers").mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zpath) as z:
            z.extractall(out / "tokenizers")
        zpath.unlink()


def write_info(folder: Path, info: dict) -> None:
    (folder / "model_info.json").write_text(json.dumps(info, indent=2), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", help="backend staging directory (models/ is created inside)")
    args = ap.parse_args()
    models_dir = Path(args.out) / "models"
    models_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    fetch_whisper(models_dir)
    fetch_align(models_dir)
    fetch_vad(models_dir)
    fetch_nltk(models_dir)
    print("models ready:", models_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
