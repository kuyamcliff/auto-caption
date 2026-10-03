"""Generate the voice-over, one line per scene, with character timestamps.
The API key is read from the XI environment variable only."""
import base64, json, os, re, sys, urllib.request

VOICE = "EXAVITQu4vr4xnSDxMaL"  # Sarah
LINES = [
    ("s1", "Still typing captions by hand?"),
    ("s2", "Every word. Every keyframe. By hand."),
    ("s3", "Meet AutoCaption AE. Word-accurate captions, right inside After Effects."),
    ("s4", "Select a layer. Click Transcribe. Your captions are timed in seconds."),
    ("s5", "Timed to the word, not the sentence."),
    ("s6", "Ten animations. Real text layers. Every export format. And your audio never leaves your computer."),
    ("s7", "AutoCaption AE. Select. Transcribe. Create."),
]
only = set(sys.argv[1:])
out = {}
if os.path.exists("vo.json"):
    out = json.load(open("vo.json"))
for i, (sid, text) in enumerate(LINES):
    if only and sid not in only:
        continue
    body = {"text": text, "model_id": "eleven_multilingual_v2",
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.8, "style": 0.35, "use_speaker_boost": True, "speed": 1.0},
            "previous_text": LINES[i - 1][1] if i else None, "next_text": LINES[i + 1][1] if i + 1 < len(LINES) else None}
    req = urllib.request.Request(f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE}/with-timestamps?output_format=mp3_44100_128",
                                 data=json.dumps(body).encode(), headers={"xi-api-key": os.environ["XI"], "Content-Type": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=120))
    open(f"{sid}.mp3", "wb").write(base64.b64decode(d["audio_base64"]))
    a = d["alignment"]
    chars, st, en = a["characters"], a["character_start_times_seconds"], a["character_end_times_seconds"]
    words, cur = [], None
    for c, s, e in zip(chars, st, en):
        if c.isspace():
            cur = None
            continue
        if cur is None:
            cur = {"w": "", "t0": s, "t1": e}
            words.append(cur)
        cur["w"] += c
        cur["t1"] = e
    out[sid] = {"text": text, "words": words, "dur": en[-1]}
    print(sid, round(en[-1], 2), [(w["w"], round(w["t0"], 2)) for w in words])
json.dump(out, open("vo.json", "w"), indent=1)
