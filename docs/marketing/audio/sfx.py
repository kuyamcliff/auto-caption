"""Generate sound effects with ElevenLabs sound generation (key from XI env var)."""
import json, os, sys, urllib.request

SFX = {
    "pop": ("Soft clean UI pop, short bubbly click, modern app interface sound, no reverb", 0.5),
    "whoosh": ("Fast airy swoosh transition, smooth whoosh passing left to right, clean modern motion graphics", 1.0),
    "click": ("Single crisp computer mouse click, close and dry", 0.5),
    "tick": ("Soft high digital tick, subtle UI confirmation blip", 0.5),
    "impact": ("Deep cinematic logo reveal impact, soft sub boom with bright airy shimmer tail, clean modern tech", 3.0),
    "chime": ("Bright pleasant two note success chime, modern tech brand outro, clean and airy", 2.0),
    "riser": ("Short smooth airy riser build up into a reveal, modern tech", 1.5),
    "bed": ("Minimal modern tech product ad background music, soft pulsing synth bass, light plucks, steady 100 bpm groove, optimistic, no vocals, loopable", 22.0),
}
for name, (text, dur) in SFX.items():
    if sys.argv[1:] and name not in sys.argv[1:]:
        continue
    body = {"text": text, "duration_seconds": dur, "prompt_influence": 0.5}
    req = urllib.request.Request("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", data=json.dumps(body).encode(),
                                 headers={"xi-api-key": os.environ["XI"], "Content-Type": "application/json"})
    try:
        data = urllib.request.urlopen(req, timeout=180).read()
    except urllib.error.HTTPError as e:
        print(name, "FAILED", e.code, e.read()[:300])
        continue
    open(f"sfx_{name}.mp3", "wb").write(data)
    print(name, len(data))
