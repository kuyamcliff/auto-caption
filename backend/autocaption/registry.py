"""Model registry, read from engine.pak's registry.json.

Speech models are identified by quality level ("fast", "accurate"); word
timing models by language code. Adding a language later means adding an
entry to the pak registry, with no engine changes.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .pak import Pak, engine_pak

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
    info: dict = field(default_factory=dict)

    def public(self) -> dict:
        # Only what the panel shows; no technology or model names.
        return {"id": self.id, "label": self.label, "description": self.info.get("description", "")}


class Registry:
    def __init__(self, pak: Pak | None = None):
        self.pak = pak or engine_pak()
        reg = self.pak.registry
        self.whisper: dict[str, ModelEntry] = {
            k: ModelEntry("speech", k, v.get("label", k.title()), v) for k, v in reg.get("speech", {}).items()
        }
        self.align: dict[str, ModelEntry] = {
            k: ModelEntry("timing", k, v.get("label", k), v) for k, v in reg.get("timing", {}).items()
        }
        self.vad = reg.get("vad")

    def whisper_model(self, model_id: str) -> ModelEntry:
        if model_id not in self.whisper:
            raise KeyError(model_id)
        return self.whisper[model_id]

    def align_model(self, language: str) -> ModelEntry | None:
        return self.align.get(language)

    def describe(self) -> dict:
        order = {"fast": 0, "accurate": 1}
        return {
            "quality": [m.public() for m in sorted(self.whisper.values(), key=lambda m: order.get(m.id, 9))],
            "timing": [{"language": m.id, "label": m.label} for m in sorted(self.align.values(), key=lambda m: m.id)],
            "languages": [{"code": c, "name": n, "aligned": c in self.align}
                          for c, n in sorted(LANGUAGE_NAMES.items(), key=lambda kv: kv[1])],
        }
