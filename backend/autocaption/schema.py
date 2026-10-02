"""Structural validation of transcription results (mirrors schemas/result.schema.json)."""
from __future__ import annotations

import math

TIMING_SOURCES = {"aligned", "inferred", "fallback", "manual"}


class SchemaError(ValueError):
    pass


def _f(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate_result(r: dict) -> None:
    if not isinstance(r, dict):
        raise SchemaError("result must be an object")
    if r.get("schemaVersion") != 1:
        raise SchemaError("schemaVersion must be 1")
    if not isinstance(r.get("language"), str):
        raise SchemaError("language missing")
    if not isinstance(r.get("aligned"), bool):
        raise SchemaError("aligned must be boolean")
    words = r.get("words")
    if not isinstance(words, list):
        raise SchemaError("words must be a list")
    ids = set()
    prev_start = -1.0
    dur = r.get("durationSec")
    for w in words:
        if not isinstance(w, dict) or not isinstance(w.get("id"), str) or not isinstance(w.get("text"), str):
            raise SchemaError("word needs id and text")
        if w["id"] in ids:
            raise SchemaError(f"duplicate word id {w['id']}")
        ids.add(w["id"])
        if not (_f(w.get("start")) and _f(w.get("end"))):
            raise SchemaError(f"word {w['id']} has non-finite timing")
        if w["start"] < 0 or w["end"] < w["start"]:
            raise SchemaError(f"word {w['id']} has invalid range")
        if w["start"] < prev_start:
            raise SchemaError(f"word {w['id']} out of order")
        if _f(dur) and w["end"] > dur + 1e-3:
            raise SchemaError(f"word {w['id']} ends after audio")
        if w.get("timingSource") not in TIMING_SOURCES:
            raise SchemaError(f"word {w['id']} has invalid timingSource")
        prev_start = w["start"]
    for s in r.get("segments", []):
        if not isinstance(s.get("wordIds"), list) or any(i not in ids for i in s["wordIds"]):
            raise SchemaError("segment references unknown words")
