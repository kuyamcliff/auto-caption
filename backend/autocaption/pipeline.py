"""Transcription + forced alignment engine (runs inside the worker process).

Flow: decoded audio -> pyannote VAD -> batched faster-whisper (WhisperX pipeline)
-> WhisperX forced alignment per segment -> validated word timings.

Every output word carries a timingSource:
  aligned   forced alignment found the word in the audio
  inferred  word could not be aligned; timing interpolated from aligned neighbours
  fallback  no alignment model for this language; Whisper's own word timestamps
"""
from __future__ import annotations

import gc
import logging
import math
import os
import re
import time
from dataclasses import dataclass
from typing import Callable

import numpy as np

from . import SCHEMA_VERSION, audio as audio_mod
from .registry import NO_SPACE_LANGUAGES, Registry
from .spoken import expand_token

log = logging.getLogger("autocaption.pipeline")

SAMPLE_RATE = audio_mod.SAMPLE_RATE
LANG_CONFIDENCE_FAIL = 0.30
LANG_CONFIDENCE_WARN = 0.60


class Cancelled(Exception):
    pass


class EngineError(Exception):
    def __init__(self, code: str, message: str, detail: str = "", hint: list[str] | None = None):
        super().__init__(message)
        self.code = code
        self.detail = detail
        self.hint = hint or []


@dataclass
class Options:
    model: str = "fast"
    language: str = "auto"
    device: str = "auto"  # auto | cpu | cuda
    batch_size: int = 0  # 0 = automatic
    vad: str = "pyannote"  # pyannote | off
    threads: int = 0


Progress = Callable[[str, float | None, str], None]


def _cpu_threads(requested: int) -> int:
    if requested > 0:
        return requested
    return max(1, min(8, (os.cpu_count() or 4)))


class Engine:
    """Keeps loaded models between jobs; one whisper model + up to two aligners."""

    def __init__(self, registry: Registry | None = None):
        from .pak import prepare_runtime_data

        self.registry = registry or Registry()
        prepare_runtime_data()
        self._asr = None
        self._asr_key: tuple | None = None
        self._align: dict[tuple, tuple] = {}
        self._cuda_failed = False

    # ------------------------------------------------------------------ devices
    def cuda_available(self) -> bool:
        if self._cuda_failed:
            return False
        try:
            import ctranslate2

            return ctranslate2.get_cuda_device_count() > 0
        except Exception:  # noqa: BLE001 - any failure means "no GPU"
            return False

    def resolve_device(self, requested: str) -> str:
        if requested == "cpu":
            return "cpu"
        if requested in ("cuda", "gpu", "auto") and self.cuda_available():
            return "cuda"
        return "cpu"

    # ------------------------------------------------------------------ loading
    def _load_asr(self, model_id: str, device: str, vad: str, threads: int):
        import whisperx
        from whisperx.asr import WhisperModel  # batched subclass of faster-whisper's model

        key = (model_id, device, vad)
        if self._asr is not None and self._asr_key == key:
            return self._asr
        self.unload_asr()
        entry = self.registry.whisper_model(model_id)
        compute_type = "float16" if device == "cuda" else "int8"
        # Model files are read straight out of engine.pak (no unpacking).
        pak = self.registry.pak
        prefix = entry.info["prefix"]
        files = {name[len(prefix):]: pak.read(name) for name in pak.names(prefix)}
        fw = WhisperModel(model_id, device=device, compute_type=compute_type,
                          cpu_threads=_cpu_threads(threads), local_files_only=True, files=files)
        del files
        vad_model = None
        if vad != "off":
            from whisperx.vads import Pyannote

            vad_dir = pak.extract(self.registry.vad["prefix"])
            vad_model = Pyannote("cuda" if device == "cuda" and _torch_cuda() else "cpu", token=None,
                                 model_fp=str(vad_dir / "pytorch_model.bin"),
                                 vad_onset=0.500, vad_offset=0.363, chunk_size=30)
        pipe = whisperx.load_model(model_id, device=device, compute_type=compute_type,
                                   model=fw, vad_model=vad_model if vad_model is not None else _no_vad(),
                                   local_files_only=True, threads=_cpu_threads(threads))
        self._asr, self._asr_key = pipe, key
        return pipe

    def unload_asr(self) -> None:
        self._asr = None
        self._asr_key = None
        gc.collect()

    def _load_align(self, language: str):
        entry = self.registry.align_model(language)
        if entry is None:
            return None
        key = (language,)
        if key in self._align:
            return self._align[key]
        if len(self._align) >= 2:
            self._align.pop(next(iter(self._align)))
            gc.collect()
        model, meta = load_timing_model(self.registry.pak, language, entry.info)
        self._align[key] = (model, meta)
        return model, meta

    # ---------------------------------------------------------------- language
    def detect_language(self, pipe, audio: np.ndarray) -> tuple[str, float]:
        fw = pipe.model
        lang, prob, _ = fw.detect_language(audio=audio, vad_filter=True, language_detection_segments=3)
        return lang, float(prob)

    # --------------------------------------------------------------- transcribe
    def transcribe(self, audio: np.ndarray, opts: Options, progress: Progress,
                   cancelled: Callable[[], bool]) -> dict:
        t0 = time.monotonic()
        timings: dict[str, float] = {}
        warnings: list[dict] = []

        def check():
            if cancelled():
                raise Cancelled()

        duration = len(audio) / SAMPLE_RATE
        if duration < 0.2:
            raise EngineError("AUDIO_TOO_SHORT", "The selected audio is too short to transcribe.")
        audio, stats = audio_mod.prepare(audio)
        if stats.get("peak", 0) < 1e-4:
            raise EngineError("SILENT_AUDIO", "The selected audio is silent.",
                              hint=["Check that the layer's audio is not muted or empty."])

        device = self.resolve_device(opts.device)
        if opts.device in ("cuda", "gpu") and device != "cuda":
            warnings.append({"code": "GPU_UNAVAILABLE", "message": "Graphics acceleration is not available. Your processor is being used."})
        progress("loading", None, "Loading speech model")
        check()
        try:
            pipe = self._load_asr(opts.model, device, opts.vad, opts.threads)
        except KeyError:
            raise EngineError("MODEL_MISSING", "This quality level is not installed in the engine.")
        except Exception as exc:  # noqa: BLE001
            if device == "cuda":
                log.warning("CUDA init failed, falling back to CPU: %s", exc)
                self._cuda_failed = True
                warnings.append({"code": "GPU_FALLBACK",
                                 "message": "Graphics acceleration could not start. Your processor is being used instead."})
                device = "cpu"
                pipe = self._load_asr(opts.model, device, opts.vad, opts.threads)
            else:
                raise
        timings["loadSec"] = round(time.monotonic() - t0, 2)
        check()

        language = (opts.language or "auto").lower()
        lang_prob = None
        if language == "auto":
            progress("detecting", None, "Detecting language")
            language, lang_prob = self.detect_language(pipe, audio)
            log.info("detected language=%s p=%.2f", language, lang_prob)
            if lang_prob < LANG_CONFIDENCE_FAIL:
                raise EngineError("LANGUAGE_UNCERTAIN", "Could not confidently detect the language.",
                                  hint=["Choose a language manually, then try again."],
                                  detail=f"best guess {language} ({lang_prob:.2f})")
            if lang_prob < LANG_CONFIDENCE_WARN:
                warnings.append({"code": "LANGUAGE_LOW_CONFIDENCE",
                                 "message": f"Language detected as {language} with low confidence. "
                                            "If the words look wrong, choose the language manually."})
        check()

        aligner = None
        try:
            aligner = self._load_align(language)
        except Exception as exc:  # noqa: BLE001
            log.exception("alignment model failed to load")
            warnings.append({"code": "ALIGN_LOAD_FAILED",
                             "message": "Precise word timing could not start, so word timing is estimated.",
                             "detail": str(exc)[:500]})
        aligned = aligner is not None

        batch = opts.batch_size or (16 if device == "cuda" else 8)
        t1 = time.monotonic()
        if aligned:
            segments = self._asr_pass(pipe, audio, language, batch, progress, check)
        else:
            warnings.append({"code": "NO_ALIGNMENT_MODEL",
                             "message": "Precise word timing is not available for this language. "
                                        "Word timing is estimated and may be less exact."})
            segments = self._fallback_pass(pipe, audio, language, opts.vad, progress, check)
        timings["transcribeSec"] = round(time.monotonic() - t1, 2)
        check()

        t2 = time.monotonic()
        if aligned:
            words = self._align_pass(segments, aligner, audio, language, progress, check)
        else:
            words = [w for seg in segments for w in seg["words"]]
        timings["alignSec"] = round(time.monotonic() - t2, 2)

        progress("building", None, "Building captions")
        if aligned:
            refine_onsets(words, audio)
        words = validate_words(words, duration)
        out_segments = _segments_from_words(segments, words)
        warnings += _quality_warnings(words, aligned)
        failed = getattr(self, "align_failures", 0)
        if aligned and segments and failed == len(segments):
            log.error("forced alignment failed for every segment (%d)", failed)
            warnings.insert(0, {"code": "ALIGNMENT_FAILED",
                                "message": "Precise word timing failed, so word timing is estimated. "
                                           "Run Verify Engine in Settings."})
        timings["totalSec"] = round(time.monotonic() - t0, 2)
        return {
            "schemaVersion": SCHEMA_VERSION,
            "language": language,
            "languageProbability": None if lang_prob is None else round(lang_prob, 3),
            "noSpaces": language in NO_SPACE_LANGUAGES,
            "model": opts.model,
            "device": "gpu" if device == "cuda" else "cpu",
            "aligned": aligned,
            "durationSec": round(duration, 3),
            "audio": stats,
            "words": words,
            "segments": out_segments,
            "warnings": warnings,
            "timings": timings,
        }

    # ------------------------------------------------------------- align only
    def align_only(self, audio: np.ndarray, segments: list[dict], language: str, progress: Progress,
                   cancelled: Callable[[], bool]) -> dict:
        """Align known text (e.g. an imported SRT) to audio without transcribing."""
        def check():
            if cancelled():
                raise Cancelled()

        duration = len(audio) / SAMPLE_RATE
        audio, _stats = audio_mod.prepare(audio)
        progress("loading", None, "Loading alignment model")
        aligner = self._load_align(language)
        if aligner is None:
            raise EngineError("NO_ALIGNMENT_MODEL", "Precise word timing is not available for this language.")
        segs = []
        for s in segments:
            text = re.sub(r"\s+", " ", str(s.get("text", ""))).strip()
            start, end = float(s["start"]), float(s["end"])
            if text and math.isfinite(start) and math.isfinite(end) and end > start:
                segs.append({"start": max(0.0, start), "end": min(duration, end), "text": text})
        words = self._align_pass(segs, aligner, audio, language, progress, check)
        refine_onsets(words, audio)
        words = validate_words(words, duration)
        return {"schemaVersion": SCHEMA_VERSION, "language": language, "aligned": True,
                "noSpaces": language in NO_SPACE_LANGUAGES,
                "durationSec": round(duration, 3), "words": words,
                "segments": _segments_from_words(segs, words), "warnings": _quality_warnings(words, True)}

    # ------------------------------------------------------------------ passes
    def _asr_pass(self, pipe, audio, language, batch, progress, check) -> list[dict]:
        progress("transcribing", 0.0, "Transcribing")

        def cb(pct: float):
            check()
            progress("transcribing", max(0.0, min(1.0, pct / 100.0)), "Transcribing")

        try:
            result = pipe.transcribe(audio, batch_size=batch, language=language, progress_callback=cb)
        except Cancelled:
            raise
        segs = []
        for s in result.get("segments", []):
            text = re.sub(r"\s+", " ", s.get("text", "")).strip()
            if text:
                segs.append({"start": float(s["start"]), "end": float(s["end"]), "text": text,
                             "avg_logprob": s.get("avg_logprob")})
        return segs

    def _fallback_pass(self, pipe, audio, language, vad, progress, check) -> list[dict]:
        """No aligner for this language: faster-whisper word timestamps (DTW)."""
        progress("transcribing", 0.0, "Transcribing")
        fw = pipe.model
        duration = len(audio) / SAMPLE_RATE
        seg_iter, _info = fw.transcribe(audio, language=language, word_timestamps=True, vad_filter=vad != "off",
                                        beam_size=5, condition_on_previous_text=False)
        segs = []
        for s in seg_iter:
            check()
            progress("transcribing", min(1.0, s.end / duration) if duration else None, "Transcribing")
            words = []
            for w in s.words or []:
                text = w.word.strip()
                if text:
                    words.append({"text": text, "start": float(w.start), "end": float(w.end),
                                  "score": round(float(w.probability), 3), "timingSource": "fallback"})
            if words:
                segs.append({"start": float(s.start), "end": float(s.end), "text": s.text.strip(), "words": words})
        return segs

    def _align_pass(self, segments, aligner, audio, language, progress, check) -> list[dict]:
        import whisperx

        model, meta = aligner
        progress("aligning", 0.0, "Aligning words")
        words: list[dict] = []
        n = len(segments)
        no_spaces = language in NO_SPACE_LANGUAGES
        self.align_failures = 0
        for i, seg in enumerate(segments):
            check()
            seg_words = None
            tokens = seg["text"].split(" ")
            if not no_spaces:
                spoken = [expand_token(t, language) for t in tokens]
                expanded = any(len(sp) != 1 or sp[0] != t for sp, t in zip(spoken, tokens))
                if expanded:
                    seg_words = self._align_one(whisperx, model, meta, audio, seg, " ".join(" ".join(sp) for sp in spoken))
                    seg_words = _collapse(seg_words, tokens, spoken)
                if seg_words is None:
                    raw = self._align_one(whisperx, model, meta, audio, seg, seg["text"])
                    if raw is not None and len(raw) == len(tokens):
                        seg_words = [_word(t, w) for t, w in zip(tokens, raw)]
            else:
                raw = self._align_one(whisperx, model, meta, audio, seg, seg["text"])
                if raw:
                    seg_words = [_word(w.get("word", ""), w) for w in raw]
            if not seg_words:
                self.align_failures += 1
                seg_words = _unaligned_segment_words(seg, tokens if not no_spaces else list(seg["text"]))
            seg["wordCount"] = len(seg_words)
            words.extend(seg_words)
            progress("aligning", (i + 1) / n if n else 1.0, "Aligning words")
        return words

    @staticmethod
    def _align_one(whisperx, model, meta, audio, seg, text) -> list[dict] | None:
        try:
            out = whisperx.align([{"start": seg["start"], "end": seg["end"], "text": text}], model, meta, audio,
                                 "cpu", interpolate_method="nearest", return_char_alignments=False)
        except Exception:  # noqa: BLE001 - a bad segment must not kill the job
            log.exception("alignment failed for one segment")
            return None
        return out.get("word_segments") or None


def load_timing_model(pak, language: str, info: dict):
    """Build a word-timing model from half-precision weights stored in engine.pak."""
    import io

    import torch
    import torchaudio
    from torchaudio.pipelines._wav2vec2 import utils as w2v_utils

    bundle = getattr(torchaudio.pipelines, info["bundle"])
    state = torch.load(io.BytesIO(pak.read(info["entry"])), map_location="cpu", weights_only=True)
    state = {k: (v.float() if v.is_floating_point() else v) for k, v in state.items()}
    model = w2v_utils._get_model(bundle._model_type, bundle._params)
    model.load_state_dict(state)
    if getattr(bundle, "_normalize_waveform", False):
        model = w2v_utils._extend_model(model, normalize_waveform=True)
    model.eval()
    labels = bundle.get_labels()
    meta = {"language": language, "dictionary": {c.lower(): i for i, c in enumerate(labels)}, "type": "torchaudio"}
    return model, meta


def _no_vad():
    """VAD switched off: one chunk per 30 s window."""
    from whisperx.vads import Vad

    class NoVad(Vad):
        def __init__(self):
            super().__init__(0.5)

        def __call__(self, inputs, **kwargs):
            from whisperx.diarize import Segment

            n = inputs["waveform"].shape[-1] / inputs["sample_rate"]
            out, t = [], 0.0
            while t < n:
                out.append(Segment(t, min(n, t + 30.0), "UNKNOWN"))
                t += 30.0
            return out

        @staticmethod
        def preprocess_audio(audio):
            return audio

        @staticmethod
        def merge_chunks(segments, chunk_size, onset=0.5, offset=None):
            return [{"start": s.start, "end": s.end, "segments": [(s.start, s.end)]} for s in segments]

    return NoVad()


# ---------------------------------------------------------------------- helpers
def _word(text: str, w: dict) -> dict:
    has_time = "start" in w and "end" in w
    src = "aligned" if has_time and "score" in w else "inferred"
    out = {"text": text, "start": w.get("start"), "end": w.get("end"), "timingSource": src}
    if "score" in w:
        out["score"] = round(float(w["score"]), 3)
    return out


def _collapse(raw: list[dict] | None, tokens: list[str], spoken: list[list[str]]) -> list[dict] | None:
    """Map aligned spoken words back onto the original written tokens."""
    if raw is None or len(raw) != sum(len(s) for s in spoken):
        return None
    out, k = [], 0
    for tok, parts in zip(tokens, spoken):
        chunk = raw[k:k + len(parts)]
        k += len(parts)
        starts = [c["start"] for c in chunk if "start" in c]
        ends = [c["end"] for c in chunk if "end" in c]
        scores = [c["score"] for c in chunk if "score" in c]
        merged = {}
        if starts and ends:
            merged = {"start": min(starts), "end": max(ends)}
            if len(scores) == len(chunk):
                merged["score"] = float(np.mean(scores))
        out.append(_word(tok, merged))
    return out


def _unaligned_segment_words(seg: dict, tokens: list[str]) -> list[dict]:
    """Alignment found nothing usable in this segment. Keep the words (never
    drop text) and mark them as fallback, placed proportionally to their
    character length inside the VAD segment."""
    tokens = [t for t in tokens if t.strip()]
    if not tokens:
        return []
    lengths = np.array([max(1, len(t)) for t in tokens], dtype=float)
    edges = np.concatenate([[0.0], np.cumsum(lengths)]) / lengths.sum()
    span = seg["end"] - seg["start"]
    return [{"text": t, "start": seg["start"] + span * edges[i], "end": seg["start"] + span * edges[i + 1],
             "timingSource": "fallback"} for i, t in enumerate(tokens)]


def frame_db(audio: np.ndarray, hop: int = 160, win: int = 400) -> np.ndarray:
    """Speech-band (250-4000 Hz) energy per 10 ms frame, in dB.

    Band-limiting keeps broadband noise and low music beds from masking
    word onsets. Processed in blocks so long files stay memory-bounded.
    """
    n = (len(audio) - win) // hop + 1
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    freqs = np.fft.rfftfreq(win, 1 / SAMPLE_RATE)
    band = (freqs >= 250) & (freqs <= 4000)
    window = np.hanning(win).astype(np.float32)
    out = np.empty(n, dtype=np.float32)
    block = 4096
    for b0 in range(0, n, block):
        b1 = min(n, b0 + block)
        idx = np.arange(b0, b1)[:, None] * hop + np.arange(win)[None, :]
        spec = np.abs(np.fft.rfft(audio[idx] * window, axis=1)) ** 2
        out[b0:b1] = 10 * np.log10(np.maximum(spec[:, band].sum(axis=1), 1e-10))
    # Frame i covers samples [i*hop, i*hop+win); shift by half a window so the
    # value is attributed to the frame centre, matching aligner timestamps.
    shift = (win // 2) // hop
    return np.concatenate([np.full(shift, out[0], dtype=np.float32), out])[:n]


def refine_onsets(words: list[dict], audio: np.ndarray, max_shift: float = 0.25) -> None:
    """Move aligned word starts back to the acoustic onset.

    CTC aligners place a word where its first character's emission spikes,
    which is often 50-200 ms after the sound actually begins (most visible on
    vowel-initial words). Captions that appear late look wrong, so we walk
    backwards from the aligned start through frames that are still clearly
    above the noise floor -- never past the previous word's end and never
    more than max_shift. Words in low-contrast audio (noise, music) are left
    untouched because the energy evidence is unreliable there.
    """
    db = frame_db(audio)
    if len(db) < 10:
        return
    floor = float(np.percentile(db, 10))
    hop_s = 0.01
    prev_end = 0.0
    for w in words:
        s, e = w.get("start"), w.get("end")
        if w.get("timingSource") != "aligned" or not _finite(s) or not _finite(e) or e <= s:
            if _finite(e):
                prev_end = max(prev_end, e)
            continue
        i0, i1 = int(s / hop_s), max(int(s / hop_s) + 1, int(e / hop_s))
        body = db[i0:i1]
        if len(body) == 0:
            prev_end = e
            continue
        level = float(np.percentile(body, 90))
        if level - floor < 10.0:
            prev_end = e
            continue
        thr = floor + 0.4 * (level - floor)
        limit = max(prev_end + 0.02, s - max_shift)
        i = i0
        while i - 1 >= 0 and (i - 1) * hop_s >= limit and db[i - 1] > thr:
            i -= 1
        if i < i0:
            w["start"] = round(i * hop_s, 3)
        prev_end = e


def _torch_cuda() -> bool:
    try:
        import torch

        return torch.cuda.is_available()
    except Exception:  # noqa: BLE001
        return False


def _finite(x) -> bool:
    return x is not None and isinstance(x, (int, float)) and math.isfinite(x)


def validate_words(words: list[dict], duration: float) -> list[dict]:
    """Guarantee finite, ordered, in-range timings. Words lacking a time get one
    interpolated between aligned neighbours (marked inferred)."""
    n = len(words)
    starts = [w["start"] if _finite(w.get("start")) else None for w in words]
    ends = [w["end"] if _finite(w.get("end")) else None for w in words]
    known = [i for i in range(n) if starts[i] is not None and ends[i] is not None]
    for i in range(n):
        if starts[i] is not None and ends[i] is not None:
            continue
        prev = max((k for k in known if k < i), default=None)
        nxt = min((k for k in known if k > i), default=None)
        lo = ends[prev] if prev is not None else 0.0
        hi = starts[nxt] if nxt is not None else (lo + 0.3 if prev is not None else duration)
        # Spread consecutive unknown words over the gap between known neighbours.
        run_start = (prev + 1) if prev is not None else 0
        run_end = nxt if nxt is not None else n
        run = run_end - run_start
        pos = i - run_start
        if hi <= lo:
            hi = lo + 0.1 * run
        starts[i] = lo + (hi - lo) * pos / run
        ends[i] = lo + (hi - lo) * (pos + 1) / run
        words[i]["timingSource"] = "inferred"
    out = []
    last_start = 0.0
    for i, w in enumerate(words):
        s = max(0.0, min(float(starts[i]), duration))
        e = max(0.0, min(float(ends[i]), duration))
        s = max(s, last_start)  # monotonic starts
        if e < s:
            e = s
        if e - s < 0.02:
            e = min(duration, s + 0.02) if duration - s >= 0.02 else e
        last_start = s
        item = {"id": f"w{i + 1}", "text": w["text"], "start": round(s, 3), "end": round(e, 3),
                "timingSource": w.get("timingSource", "aligned")}
        if _finite(w.get("score")):
            item["score"] = round(float(w["score"]), 3)
        out.append(item)
    # Resolve overlaps: a word may not end after the next word starts.
    for a, b in zip(out, out[1:]):
        if a["end"] > b["start"]:
            a["end"] = max(a["start"], b["start"])
    return out


def _segments_from_words(segments: list[dict], words: list[dict]) -> list[dict]:
    """Re-attach validated word ids to the ASR segments (used for sentence hints)."""
    out, k = [], 0
    for seg in segments:
        count = seg.get("wordCount", len(seg.get("words", [])))
        ids = [w["id"] for w in words[k:k + count]]
        k += count
        if ids:
            first, last = words[k - len(ids)], words[k - 1]
            out.append({"start": first["start"], "end": last["end"], "text": seg["text"], "wordIds": ids})
    return out


def _quality_warnings(words: list[dict], aligned: bool) -> list[dict]:
    if not words:
        return [{"code": "NO_SPEECH", "message": "No speech was found in the selected audio."}]
    warnings = []
    inferred = sum(1 for w in words if w["timingSource"] in ("inferred", "fallback"))
    if aligned and inferred / len(words) > 0.15:
        warnings.append({"code": "PARTIAL_ALIGNMENT",
                         "message": f"{inferred} of {len(words)} words could not be timed exactly. "
                                    "Their timing was estimated from nearby words."})
    scored = [w["score"] for w in words if "score" in w]
    if aligned and len(scored) >= 10 and float(np.median(scored)) < 0.45:
        warnings.append({"code": "LOW_CONFIDENCE",
                         "message": "Timing confidence is low. Music, noise or overlapping voices can "
                                    "reduce timing accuracy. Check the captions before using them."})
    return warnings
