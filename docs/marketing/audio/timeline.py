"""Real-time timeline for the voiced cut. Each scene keeps its original story
timing (the HTML's render(t) clock) and is mapped onto real time with
piecewise-linear anchors keyed to voice-over word times. Writes timeline.json,
used by both the HTML (visuals) and mix.py (audio)."""
import json

vo = json.load(open("vo.json"))
W = lambda sid, i: vo[sid]["words"][i]["t0"]  # word start inside the line

# scene: story start/end, voice lead-in (s), real duration, anchors (real_local, story_local)
S = {}
def scene(sid, a, b, lead, dur, anchors):
    S[sid] = {"a": a, "b": b, "lead": lead, "dur": dur, "anchors": [[0, 0]] + anchors + [[dur, b - a]]}

scene("s1", 0, 3.4, 0.30, 3.4, [])
L = 0.15; scene("s2", 3.4, 6.6, L, 3.95, [[L + W("s2", 2), 0.75], [L + W("s2", 4), 1.45], [L + vo["s2"]["dur"] - 0.1, 2.35]])
L = 0.20; scene("s3", 6.6, 9.6, L, 6.3, [[L + W("s3", 1), 0.70], [L + W("s3", 3), 1.30], [L + W("s3", 7) - 0.1, 1.75], [5.85, 2.55]])
L = 0.30; scene("s4", 9.6, 14.8, L, 5.6, [[L, 0.15], [L + W("s4", 3) - 0.05, 0.95], [L + W("s4", 4) + 0.05, 1.30], [L + W("s4", 5), 3.35], [5.25, 4.85]])
L = 0.25; scene("s5", 14.8, 18.8, L, 4.0, [])
L = 0.10; scene("s6", 18.8, 21.8, L, 7.9, [[L + W("s6", 2) - 0.1, 0.75], [L + W("s6", 5) - 0.1, 1.50], [L + W("s6", 8) - 0.1, 2.25]])
L = 0.15; scene("s7", 21.8, 24.01, L, 5.6, [[L + W("s7", 2), 0.40], [L + W("s7", 3), 0.75], [L + W("s7", 4), 1.15], [L + vo["s7"]["dur"] + 0.2, 1.45]])

t = 0.0
for sid, s in S.items():
    s["A"] = round(t, 4)
    t += s["dur"]
    xs = [p[0] for p in s["anchors"]]
    assert xs == sorted(xs), (sid, xs)
TOTAL = round(t, 4)

def real(story):
    """story time -> real time (inverse of the scene map)."""
    for s in S.values():
        if s["a"] <= story < s["b"] or (s is list(S.values())[-1] and story >= s["a"]):
            loc = story - s["a"]
            an = s["anchors"]
            for (r0, s0), (r1, s1) in zip(an, an[1:]):
                if s0 <= loc <= s1:
                    return s["A"] + r0 + (r1 - r0) * ((loc - s0) / (s1 - s0) if s1 > s0 else 0)
    raise ValueError(story)

hook = [{"w": w["w"], "t": round(S["s1"]["lead"] + w["t0"], 3)} for w in vo["s1"]["words"]]
voice = [{"sid": sid, "at": round(S[sid]["A"] + S[sid]["lead"], 3)} for sid in S]

# sound cues (real seconds): name, time, gain dB
cues = []
cue = lambda name, story=None, at=None, gain=0.0: cues.append({"sfx": name, "at": round(at if at is not None else real(story), 3), "gain": gain})
for h in hook:
    cue("pop", at=h["t"], gain=-4)
for w in (3.1, 14.55, 18.55):                       # playhead wipes
    cue("whoosh", story=w - 0.05, gain=-8)
for st in (3.55, 4.15, 4.85):                       # S2 lines
    cue("tick", story=st, gain=-10)
cue("riser", at=real(6.6) - 1.3, gain=-12)
cue("impact", story=6.66, gain=-6)                  # logo reveal
cue("whoosh", story=9.6, gain=-14)                  # panel slides in
cue("click", story=10.87, gain=-2)                  # Transcribe
for st in (11.6, 12.45, 12.95, 13.3):               # steps complete
    cue("tick", story=st, gain=-12)
for i in range(5):                                  # captions arrive
    cue("pop", story=13.45 + i * 0.12, gain=-6)
for i, b in enumerate((6.30, 6.58, 6.71, 6.88)):    # S5 playhead reaches each word
    cue("tick", story=15.5 + (b - 6.15) / (7.45 - 6.15) * 2.6, gain=-9)
for a in (18.8, 19.55, 20.3, 21.05):                # feature cards
    cue("whoosh", story=a, gain=-16)
for i in range(5):                                  # export chips
    cue("pop", story=20.36 + i * 0.06, gain=-7)
cue("impact", story=21.86, gain=-12)                # end card
for st in (22.2, 22.55, 22.95):
    cue("pop", story=st, gain=-4)
cue("chime", story=23.2, gain=-8)

json.dump({"total": TOTAL, "scenes": S, "hook": hook, "voice": voice, "cues": sorted(cues, key=lambda c: c["at"])}, open("timeline.json", "w"), indent=1)
print("total", TOTAL, "s;", len(cues), "cues")
for sid, s in S.items():
    print(sid, s["A"], s["dur"], s["anchors"])
