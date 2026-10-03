"""Generate synthetic speech fixtures with exact ground-truth word timings.

Each word is synthesised separately with espeak-ng (GPL tool used only at
build time; the generated audio is synthetic and contains no third-party
media) and placed at a known sample offset, so the true onset of every word is
known to the sample. Output: <name>.wav + <name>.expected.json
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

SR = 16000
OUT = Path(__file__).resolve().parent / "audio"


def tts_word(word: str, speed: int, voice: str = "en-us") -> np.ndarray:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp = f.name
    subprocess.run(["espeak-ng", "-v", voice, "-s", str(speed), "-w", tmp, word], check=True)
    out = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", tmp, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         check=True, capture_output=True)
    Path(tmp).unlink()
    a = np.frombuffer(out.stdout, dtype=np.float32)
    # trim to the voiced part so the onset is exactly where we place it
    thr = 10 ** (-40 / 20) * max(1e-6, float(np.abs(a).max()))
    idx = np.where(np.abs(a) > thr)[0]
    return a[idx[0]: idx[-1] + 1] if len(idx) else a


def build(words: list[str], speed: int, gap: float, lead: float = 0.5, tail: float = 0.5,
          pauses: dict[int, float] | None = None, spoken: dict[str, str] | None = None):
    pauses = pauses or {}
    spoken = spoken or {}
    pieces, truth, t = [np.zeros(int(lead * SR), np.float32)], [], lead
    for i, w in enumerate(words):
        clip = tts_word(spoken.get(w, w), speed)
        truth.append({"text": w, "start": round(t, 3), "end": round(t + len(clip) / SR, 3)})
        pieces.append(clip)
        t += len(clip) / SR
        g = pauses.get(i, gap)
        pieces.append(np.zeros(int(g * SR), np.float32))
        t += int(g * SR) / SR
    pieces.append(np.zeros(int(tail * SR), np.float32))
    audio = np.concatenate(pieces)
    return audio / max(1e-6, float(np.abs(audio).max())) * 0.8, truth


def save(name: str, audio: np.ndarray, truth: list[dict], sr: int = SR, channels: int = 1, note: str = ""):
    OUT.mkdir(parents=True, exist_ok=True)
    data = audio
    if sr != SR:
        idx = np.arange(0, len(audio) * sr / SR) * SR / sr
        data = np.interp(idx, np.arange(len(audio)), audio).astype(np.float32)
    if channels == 2:
        data = np.stack([data, data * 0.9], axis=1).reshape(-1)
    pcm = (np.clip(data, -1, 1) * 32767).astype("<i2")
    with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    (OUT / f"{name}.expected.json").write_text(json.dumps(
        {"name": name, "sampleRate": sr, "channels": channels, "durationSec": round(len(audio) / SR, 3),
         "note": note, "words": truth}, indent=1), encoding="utf-8")
    print(f"{name}: {len(truth)} words, {len(audio) / SR:.1f}s")


SENT = "this is a simple test of the automatic caption engine and it should line up with every word".split()


def main() -> int:
    rng = np.random.default_rng(7)
    a, t = build(SENT, 160, 0.08)
    save("clean_english", a, t, note="clean speech, 80 ms gaps")
    a, t = build(SENT, 260, 0.02)
    save("fast_english", a, t, note="fast speech, 20 ms gaps")
    a, t = build("please speak slowly so that every single word is clear".split(), 90, 0.45)
    save("slow_english", a, t, note="very slow speech")
    a, t = build("we start after a long silence".split(), 160, 0.1, lead=3.0)
    save("leading_silence", a, t, note="3 s of silence before speech (Test I)")
    a, t = build("and then the speaker stops talking".split(), 160, 0.1, tail=4.0)
    save("trailing_silence", a, t, note="4 s of silence after speech (Test J)")
    a, t = build("first part here then a pause and another pause before the end".split(), 160, 0.1,
                 pauses={2: 1.5, 6: 2.0})
    save("multiple_pauses", a, t, note="pauses of 1.5 s and 2 s (Test K)")
    nums = ["it", "costs", "$25", "and", "arrived", "in", "1999", "with", "42", "items"]
    a, t = build(nums, 160, 0.1, spoken={"$25": "twenty five dollars", "1999": "nineteen ninety nine",
                                          "42": "forty two"})
    save("numbers", a, t, note="numbers and currency (Test N)")
    punct = ["wait,", "don't", "go!", "it's", "a", "well-known", "trick,", "isn't", "it?"]
    a, t = build(punct, 160, 0.12)
    save("punctuation", a, t, note="apostrophes, hyphens, punctuation")
    a, t = build(["hello", "world"], 160, 0.1, lead=0.3, tail=0.3)
    save("short", a, t, note="very short clip")
    save("silence", np.zeros(5 * SR, np.float32), [], note="pure digital silence")
    # quiet speech, -30 dB
    a, t = build(SENT, 160, 0.08)
    save("quiet_speech", a * 0.03, t, note="speech at about -30 dBFS")
    # background noise
    a, t = build(SENT, 160, 0.08)
    save("background_noise", a + rng.normal(0, 0.05, len(a)).astype(np.float32), t, note="white noise at -26 dB")
    # music bed: chord of sines with slow tremolo
    a, t = build(SENT, 160, 0.08)
    tt = np.arange(len(a)) / SR
    music = sum(np.sin(2 * np.pi * f * tt) for f in (220, 277.18, 329.63)) * 0.06 * (0.6 + 0.4 * np.sin(2 * np.pi * 0.5 * tt))
    save("music_speech", (a + music).astype(np.float32), t, note="speech over a sustained chord")
    # format variants
    a, t = build(SENT, 160, 0.08)
    save("stereo_44k", a, t, sr=44100, channels=2, note="stereo 44.1 kHz")
    save("stereo_48k", a, t, sr=48000, channels=2, note="stereo 48 kHz")
    # long: about 5 minutes of varied sentences
    corpus = ("the morning light came through the window as the city slowly woke up and people began their day "
              "some went to work while others stayed home to read a book or watch a movie with friends "
              "later in the afternoon the rain started and everyone rushed inside to stay warm and dry").split()
    words = (corpus * 12)[: 12 * len(corpus)]
    a, t = build(words, 175, 0.07, pauses={i: 0.8 for i in range(19, len(words), 20)})
    save("long", a, t, note="long-form speech (~5 min)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
