"""Mix voice-over, sound effects and music bed onto the real-time timeline."""
import json, subprocess
import numpy as np

SR = 48000
tl = json.load(open("timeline.json"))
N = int(round(tl["total"] * SR))

def load(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).copy()

def db(x):
    return 10 ** (x / 20)

def trim_onset(x, thresh_db=-36):
    env = np.abs(x).max(axis=1)
    hit = np.nonzero(env > env.max() * db(thresh_db))[0]
    return x[max(0, hit[0] - int(0.004 * SR)):] if len(hit) else x

def place(bus, x, at, gain=1.0):
    i = int(round(at * SR))
    if i < 0:
        x, i = x[-i:], 0
    n = min(len(x), len(bus) - i)
    if n > 0:
        bus[i:i + n] += x[:n] * gain

voice = np.zeros((N, 2), np.float32)
for v in tl["voice"]:
    x = load(f"{v['sid']}.mp3")
    place(voice, x / max(1e-6, np.abs(x).max()) * db(-3), v["at"])

sfx = np.zeros((N, 2), np.float32)
cache = {}
for c in tl["cues"]:
    if c["sfx"] not in cache:
        x = trim_onset(load(f"sfx_{c['sfx']}.mp3"))
        cache[c["sfx"]] = x / max(1e-6, np.abs(x).max()) * db(-1)
    x = cache[c["sfx"]]
    # risers lead into their hit, everything else starts on the cue
    place(sfx, x, c["at"] - (len(x) / SR if c["sfx"] == "riser" else 0), db(c["gain"]))

# music bed: loop with a 1.5 s crossfade, ducked under the voice
bed = load("sfx_bed.mp3")
bed = bed / np.abs(bed).max()
xf = int(1.5 * SR)
music = np.zeros((N + len(bed), 2), np.float32)
pos = 0
ramp = np.linspace(0, 1, xf, dtype=np.float32)[:, None]
while pos < N:
    seg = bed.copy()
    if pos:
        seg[:xf] *= ramp
    seg[-xf:] *= ramp[::-1]
    music[pos:pos + len(seg)] += seg
    pos += len(bed) - xf
music = music[:N]
venv = np.abs(voice).max(axis=1)
win = int(0.12 * SR)
venv = np.convolve(venv, np.ones(win) / win, mode="same")
duck = 1 - 0.55 * np.clip(venv / (venv.max() * 0.25), 0, 1)       # about -7 dB under speech
k = int(0.08 * SR)
duck = np.convolve(duck, np.ones(k) / k, mode="same")[:, None]
fade_in = np.clip(np.arange(N) / (0.4 * SR), 0, 1)[:, None]
fade_out = np.clip((N - np.arange(N)) / (2.5 * SR), 0, 1)[:, None]
music *= db(-17) * duck * fade_in * fade_out

mixd = voice + sfx * db(-4) + music
mixd *= db(-1) / max(1e-6, np.abs(mixd).max())
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ac", "2", "-ar", str(SR), "-i", "-",
                "-af", "loudnorm=I=-14:TP=-1.5:LRA=9", "-ar", str(SR), "mix.wav"], input=mixd.astype(np.float32).tobytes(), check=True)
print("mix.wav", round(N / SR, 2), "s")
