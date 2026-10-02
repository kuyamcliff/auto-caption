"""Audio decoding through the bundled FFmpeg."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np

from . import paths

SAMPLE_RATE = 16000
ALLOWED_EXTENSIONS = {
    ".wav", ".wave", ".aif", ".aiff", ".aifc", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus",
    ".mp4", ".mov", ".m4v", ".mxf", ".avi", ".mkv", ".webm", ".wmv", ".mts", ".m2ts", ".mpg", ".mpeg",
}

_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


class AudioError(Exception):
    def __init__(self, code: str, message: str, detail: str = ""):
        super().__init__(message)
        self.code = code
        self.detail = detail


def _ffmpeg() -> str:
    exe = paths.ffmpeg_exe()
    if exe is None:
        raise AudioError("FFMPEG_MISSING", "The audio decoder (FFmpeg) is missing from the backend folder.")
    return str(exe)


def ffmpeg_version() -> str:
    out = subprocess.run([_ffmpeg(), "-hide_banner", "-version"], capture_output=True, text=True,
                         timeout=30, creationflags=_NO_WINDOW)
    first = (out.stdout or "").splitlines()[0] if out.stdout else ""
    parts = first.split()
    return parts[2] if len(parts) > 2 else first


def decode(path: Path, start: float | None = None, duration: float | None = None,
           proc_holder: list | None = None) -> np.ndarray:
    """Decode any media file to mono float32 at 16 kHz.

    Streaming the decoder output keeps peak memory at ~4 bytes/sample
    (one hour of audio ~= 230 MB) instead of buffering raw PCM twice.
    """
    cmd = [_ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "0"]
    if start is not None and start > 0:
        cmd += ["-ss", f"{start:.6f}"]
    cmd += ["-i", str(path)]
    if duration is not None and duration > 0:
        cmd += ["-t", f"{duration:.6f}"]
    cmd += ["-vn", "-sn", "-dn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-acodec", "pcm_f32le", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=_NO_WINDOW)
    if proc_holder is not None:
        proc_holder.append(proc)
    chunks = []
    assert proc.stdout is not None
    while True:
        block = proc.stdout.read(1 << 20)
        if not block:
            break
        chunks.append(block)
    err = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
    code = proc.wait()
    if code != 0:
        raise AudioError("DECODE_FAILED", "The audio could not be read.", err.strip()[-2000:])
    raw = b"".join(chunks)
    chunks.clear()
    usable = len(raw) - (len(raw) % 4)
    audio = np.frombuffer(raw[:usable], dtype=np.float32).copy()
    del raw
    return audio


def probe_has_audio(path: Path) -> bool:
    """Cheap check used before decoding: does the file contain an audio stream?"""
    cmd = [_ffmpeg(), "-hide_banner", "-nostdin", "-i", str(path)]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=60, creationflags=_NO_WINDOW)
    return "Audio:" in (out.stderr or "")


def prepare(audio: np.ndarray) -> tuple[np.ndarray, dict]:
    """Light, timing-neutral preprocessing: remove DC offset and peak-normalise
    quiet recordings. Never shifts or stretches samples."""
    stats = {"durationSec": round(len(audio) / SAMPLE_RATE, 3)}
    if len(audio) == 0:
        stats["peak"] = 0.0
        stats["rms"] = 0.0
        return audio, stats
    audio = audio - np.float32(audio.mean())
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
    stats["peak"] = round(peak, 5)
    stats["rms"] = round(rms, 6)
    if 1e-4 < peak < 0.5:
        audio = audio * np.float32(0.89 / peak)
        stats["normalizedGain"] = round(0.89 / peak, 3)
    return audio.astype(np.float32, copy=False), stats


def write_wav_16k(audio: np.ndarray, dest: Path) -> None:
    import wave

    pcm = np.clip(audio, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    with wave.open(str(dest), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
