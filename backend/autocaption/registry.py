"""Model registry.

Built from the model_info.json files that the build writes next to every bundled
model. Adding a language later means dropping a folder into models/align/<lang>
with its model_info.json -- no engine changes.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from . import paths

# Human readable names for the language picker / warnings.
LANGUAGE_NAMES = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German", "it": "Italian",
    "pt": "Portuguese", "nl": "Dutch", "ja": "Japanese", "ko": "Korean", "zh": "Chinese",
    "ru": "Russian", "ar": "Arabic", "hi": "Hindi", "tr": "Turkish", "pl": "Polish",
    "uk": "Ukrainian", "vi": "Vietnamese", "id": "Indonesian", "th": "Thai", "sv": "Swedish",
    "da": "Danish", "fi": "Finnish", "no": "Norwegian", "cs": "Czech", "el": "Greek",
    "he": "Hebrew", "hu": "Hungarian", "ro": "Romanian", "ms": "Malay", "tl": "Tagalog",
    "fa": "Persian", "ur": "Urdu", "bn": "Bengali", "ta": "Tamil", "ca": "Catalan",
}

NO_SPACE_LANGUAGES = {"ja", "zh", "th", "lo", "km", "my", "yue"}


@dataclass
class ModelEntry:
    kind: str
    id: str
    label: str
    path: Path
    info: dict = field(default_factory=dict)

    def public(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "revision": self.info.get("revision"),
            "license": self.info.get("license"),
            "source": self.info.get("source"),
            "sizeBytes": sum(f.get("size", 0) for f in self.info.get("files", {}).values()),
        }


class Registry:
    def __init__(self, root: Path | None = None):
        self.root = root or paths.models_dir()
        self.whisper: dict[str, ModelEntry] = {}
        self.align: dict[str, ModelEntry] = {}
        self.vad: ModelEntry | None = None
        self._scan()

    def _scan(self) -> None:
        for info_path in sorted(self.root.glob("*/*/model_info.json")) + sorted(self.root.glob("vad/model_info.json")):
            try:
                info = json.loads(info_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            entry = ModelEntry(info.get("kind", ""), info.get("id", ""), info.get("label", ""), info_path.parent, info)
            if entry.kind == "whisper":
                self.whisper[entry.id] = entry
            elif entry.kind == "align":
                self.align[entry.id] = entry
            elif entry.kind == "vad":
                self.vad = entry

    def whisper_model(self, model_id: str) -> ModelEntry:
        if model_id not in self.whisper:
            raise KeyError(model_id)
        return self.whisper[model_id]

    def align_model(self, language: str) -> ModelEntry | None:
        return self.align.get(language)

    def describe(self) -> dict:
        order = {"base": 0, "small": 1}
        return {
            "whisper": [
                m.public() | {"description": WHISPER_DESCRIPTIONS.get(m.id, "")}
                for m in sorted(self.whisper.values(), key=lambda m: order.get(m.id, 9))
            ],
            "alignment": [m.public() | {"language": m.id} for m in sorted(self.align.values(), key=lambda m: m.id)],
            "vad": self.vad.public() if self.vad else None,
            "languages": [{"code": c, "name": n, "aligned": c in self.align} for c, n in sorted(LANGUAGE_NAMES.items(), key=lambda kv: kv[1])],
        }


WHISPER_DESCRIPTIONS = {
    "base": "Fastest default",
    "small": "Higher transcription quality",
}
