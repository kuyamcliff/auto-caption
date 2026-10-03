import { describe, expect, it } from "vitest";
import { buildPlan, hexToRGB } from "../src/core/aeplan";
import { captionTracks, charMaps, evalTrack, wordAmount, wordExpression } from "../src/core/anim";
import { DEFAULT_ANIMATION, DEFAULT_SEGMENT } from "../src/core/defaults";
import {
  deleteCaption, editCaptionText, mergeWithNext, resetEdits, setCaptionTiming, setGrouping, setWordTiming,
  splitCaption, validateForAE, views,
} from "../src/core/edit";
import { assColor, exportProject, parseCues, projectFromCues, toASS, toSRT, toTXT, toVTT } from "../src/core/formats";
import { History } from "../src/core/history";
import { parsePresetFile, sanitizePreset, serializePresets, BUILT_IN_PRESETS } from "../src/core/presets";
import { parseProject, projectFromResult, serializeProject, ProjectError } from "../src/core/project";
import { balanceLines, breakCost, captionViews, regroup, segmentRange } from "../src/core/segment";
import { audioToComp, formatClock, frameDurationFor, parseTime, snapToFrames, toFrame } from "../src/core/timing";
import type { EngineResult, SourceInfo, Word } from "../src/core/types";

// ------------------------------------------------------------------ helpers
function mkWords(text: string, start = 0, wordDur = 0.3, gap = 0.05, gaps: Record<number, number> = {}): Word[] {
  let t = start;
  return text.split(" ").map((tx, i) => {
    const w: Word = { id: `w${i + 1}`, text: tx, start: round(t), end: round(t + wordDur), timingSource: "aligned" };
    t += wordDur + (gaps[i] ?? gap);
    return w;
  });
}
const round = (x: number) => Math.round(x * 1000) / 1000;

function source(over: Partial<SourceInfo> = {}): SourceInfo {
  return {
    composition: "Main", layers: [{ name: "VO", index: 1, type: "audio" }], layerType: "audio", fps: 30,
    frameDuration: 1 / 30, compStartTime: 0, compDuration: 120, width: 1920, height: 1080, audioOffset: 0,
    audioDuration: 60, mapping: "render", ...over,
  };
}

function result(words: Word[]): EngineResult {
  return {
    schemaVersion: 1, language: "en", aligned: true, durationSec: 60, model: "base",
    words: words.map((w) => ({ id: w.id, text: w.text, start: w.start, end: w.end, timingSource: w.timingSource })),
    segments: [], warnings: [],
  };
}

const texts = (ws: Word[], ranges: [number, number][]) => ranges.map(([a, b]) => ws.slice(a, b + 1).map((w) => w.text).join(" "));

// ---------------------------------------------------------- segmentation
describe("segmentation", () => {
  it("is deterministic", () => {
    const ws = mkWords("one two three four five six seven eight nine ten eleven twelve");
    expect(segmentRange(ws, DEFAULT_SEGMENT)).toEqual(segmentRange(ws, DEFAULT_SEGMENT));
  });

  it("respects the word limit", () => {
    const ws = mkWords("a b c d e f g h i j k l m n o p q r s t");
    for (const n of [2, 3, 4, 5, 6]) {
      const r = segmentRange(ws, { ...DEFAULT_SEGMENT, maxWords: n });
      expect(r.every(([a, b]) => b - a + 1 <= n)).toBe(true);
      expect(r.flatMap(([a, b]) => ws.slice(a, b + 1)).length).toBe(ws.length);
    }
  });

  it("prefers natural clause breaks (spec example)", () => {
    const ws = mkWords("I really don't know what he was trying to say");
    const r = texts(ws, segmentRange(ws, { ...DEFAULT_SEGMENT, maxWords: 6, maxCharsPerLine: 40 }));
    expect(r).toEqual(["I really don't know", "what he was trying to say"]);
  });

  it("breaks at sentence ends", () => {
    const ws = mkWords("We made it. Now we go home and rest");
    const r = texts(ws, segmentRange(ws, { ...DEFAULT_SEGMENT, maxWords: 5 }));
    expect(r[0]).toBe("We made it.");
  });

  it("never keeps a long pause inside a caption", () => {
    const ws = mkWords("hello there my friend how are you", 0, 0.3, 0.05, { 2: 1.5 });
    const r = segmentRange(ws, { ...DEFAULT_SEGMENT, maxWords: 6 });
    for (const [a, b] of r) {
      for (let k = a; k < b; k++) expect(ws[k + 1].start - ws[k].end).toBeLessThanOrEqual(DEFAULT_SEGMENT.pauseSplit);
    }
  });

  it("avoids ending a caption on an article", () => {
    expect(breakCost(mkWords("I saw the car"), 2)).toBeGreaterThan(breakCost(mkWords("I saw the car"), 1));
  });

  it("keeps a number with its unit", () => {
    const ws = mkWords("it costs 25 dollars today ok");
    expect(breakCost(ws, 2)).toBeGreaterThan(breakCost(ws, 3));
  });

  it("changing words-per-line never changes word timing", () => {
    const ws = mkWords("the quick brown fox jumps over the lazy dog again and again");
    const before = JSON.stringify(ws);
    for (const n of [2, 3, 4, 5, 6, 9]) regroup(ws, [], { ...DEFAULT_SEGMENT, maxWords: n });
    expect(JSON.stringify(ws)).toBe(before);
  });

  it("handles an empty transcript", () => {
    expect(segmentRange([], DEFAULT_SEGMENT)).toEqual([]);
  });

  it("handles a single very long word", () => {
    const ws = mkWords("supercalifragilisticexpialidocious-and-more-and-more");
    expect(segmentRange(ws, { ...DEFAULT_SEGMENT, maxCharsPerLine: 10 })).toEqual([[0, 0]]);
  });
});

describe("line balancing", () => {
  it("balances two lines (spec example)", () => {
    const lines = balanceLines(mkWords("THIS IS REALLY GOOD"), 12);
    expect(lines.map((l) => l.map((w) => w.text).join(" "))).toEqual(["THIS IS", "REALLY GOOD"]);
  });
  it("keeps short captions on one line", () => {
    expect(balanceLines(mkWords("hi there"), 24)).toHaveLength(1);
  });
  it("prefers breaking after punctuation", () => {
    const lines = balanceLines(mkWords("Well, I think we should go now"), 20);
    expect(lines[0].map((w) => w.text).join(" ")).toBe("Well, I think");
  });
});

describe("caption display timing", () => {
  it("starts at the first word and never before", () => {
    const ws = mkWords("one two three four five six", 1.02);
    const caps = regroup(ws, [], DEFAULT_SEGMENT);
    const v = captionViews(ws, caps, DEFAULT_SEGMENT);
    expect(v[0].start).toBe(1.02);
    for (const c of v) expect(c.start).toBe(c.words[0].start);
  });
  it("never overlaps the next caption", () => {
    const ws = mkWords("a b c d e f g h i j k l", 0, 0.2, 0.02);
    const v = captionViews(ws, regroup(ws, [], { ...DEFAULT_SEGMENT, maxWords: 3 }), DEFAULT_SEGMENT);
    for (let i = 0; i < v.length - 1; i++) expect(v[i].end).toBeLessThanOrEqual(v[i + 1].start);
  });
  it("holds briefly after the last word when followed by silence", () => {
    const ws = mkWords("hello world", 0, 0.3, 0.05);
    const v = captionViews(ws, regroup(ws, [], DEFAULT_SEGMENT), DEFAULT_SEGMENT);
    expect(v[0].end).toBeCloseTo(ws[1].end + DEFAULT_SEGMENT.hold, 5);
  });
});

// ---------------------------------------------------------- timeline (A-H)
describe("timeline synchronisation", () => {
  const word = { id: "w1", text: "hi", start: 2, end: 2.4, timingSource: "aligned" as const };

  it("A: comp starts at 0, layer at 0 -> word time == AE time", () => {
    const p = projectFromResult(result([{ ...word, start: 1.5, end: 1.9 }]), source({ audioOffset: 0 }));
    expect(p.words[0].start).toBe(1.5);
  });

  it("B/H: non-zero composition start time only affects display", () => {
    const p = projectFromResult(result([word]), source({ compStartTime: 10 }));
    expect(p.words[0].start).toBe(2); // internal comp time
    expect(formatClock(p.words[0].start + p.source.compStartTime)).toBe("00:00:12.000");
  });

  it("C: layer at 15s, word 2s into the source -> caption at 17s", () => {
    // render mapping: AE renders from layer.inPoint (15s)
    expect(audioToComp(2, "render", 15)).toBe(17);
    // source mapping: decoded from source second 0, layer.startTime 15
    expect(audioToComp(2, "source", 0, { layerStartTime: 15, stretch: 100, sourceIn: 0 })).toBe(17);
  });

  it("D: trimmed layer does not shift captions", () => {
    // layer.startTime 15, trimmed so inPoint = 20; word is 7s into the source -> comp 22
    expect(audioToComp(2, "render", 20)).toBe(22); // rendered audio starts at the in-point
    expect(audioToComp(2, "source", 0, { layerStartTime: 15, stretch: 100, sourceIn: 5 })).toBe(22);
  });

  it("E: 50% time stretch halves source time", () => {
    // word 4s into the source, layer starts at 15, stretch 50% -> comp 17
    expect(audioToComp(4, "source", 0, { layerStartTime: 15, stretch: 50, sourceIn: 0 })).toBe(17);
    // with rendered audio AE already applied the stretch: word heard 2s after in-point
    expect(audioToComp(2, "render", 15)).toBe(17);
  });

  it("F: nested precomp -> rendered audio offset is the outer layer in-point", () => {
    // outer precomp layer at 30s; speech 3.25s into the rendered precomp audio
    const p = projectFromResult(result([{ ...word, start: 3.25, end: 3.5 }]), source({ audioOffset: 30, layerType: "precomp" }));
    expect(p.words[0].start).toBe(33.25);
  });

  it("G: frame placement is exact for common frame rates", () => {
    const rates: [number, number][] = [[23.976, 1001 / 24000], [24, 1 / 24], [25, 1 / 25], [29.97, 1001 / 30000],
      [30, 1 / 30], [50, 1 / 50], [59.94, 1001 / 60000], [60, 1 / 60]];
    for (const [fps, fd] of rates) {
      expect(frameDurationFor(fps)).toBeCloseTo(fd, 12);
      const r = snapToFrames(17.02, 18.5, fd);
      expect(Math.abs(r.inPoint - 17.02)).toBeLessThanOrEqual(fd / 2 + 1e-9);
      expect(r.inPoint / fd).toBeCloseTo(Math.round(r.inPoint / fd), 9);
      expect(r.outFrame).toBeGreaterThan(r.inFrame);
    }
    // adjacent captions sharing a boundary never overlap after snapping
    const a = snapToFrames(1, 2.0166, 1001 / 30000);
    const b = snapToFrames(2.0166, 3, 1001 / 30000);
    expect(a.outFrame).toBeLessThanOrEqual(b.inFrame);
    expect(toFrame(1.0, 1 / 24)).toBe(24);
  });

  it("reversed layer is flagged by stretch < 0 in source mapping", () => {
    expect(audioToComp(1, "source", 0, { layerStartTime: 10, stretch: -100, sourceIn: 0 })).toBe(9);
  });
});

describe("time parsing/formatting", () => {
  it("round-trips", () => {
    expect(formatClock(3725.25)).toBe("01:02:05.250");
    expect(formatClock(1.0205, ",")).toBe("00:00:01,021");
    expect(parseTime("1:02.5")).toBe(62.5);
    expect(parseTime("01:02:05,250")).toBeCloseTo(3725.25);
    expect(parseTime("abc")).toBeNaN();
  });
});

// ---------------------------------------------------------------- editing
function proj(text = "hello world this is a test of captions") {
  return projectFromResult(result(mkWords(text, 1)), source());
}

describe("editing", () => {
  it("unchanged text keeps every aligned timing", () => {
    const p = proj();
    const c = p.captions[0];
    const text = views(p)[0].text;
    expect(editCaptionText(p, c.id, text)).toBe(p);
  });

  it("inserted words are marked inferred and interpolated (spec example)", () => {
    const p0 = projectFromResult(result(mkWords("hello world", 1, 0.3, 0.4)), source());
    const c = p0.captions[0];
    const p = editCaptionText(p0, c.id, "hello beautiful world");
    const ws = views(p)[0].words;
    expect(ws.map((w) => w.text)).toEqual(["hello", "beautiful", "world"]);
    expect(ws[0].timingSource).toBe("aligned");
    expect(ws[2].timingSource).toBe("aligned");
    expect(ws[1].timingSource).toBe("inferred");
    expect(ws[1].start).toBeGreaterThanOrEqual(ws[0].end);
    expect(ws[1].end).toBeLessThanOrEqual(ws[2].start);
    expect(ws[0].start).toBe(1);
    // original alignment is untouched
    expect(p.sourceWords.map((w) => w.text)).toEqual(["hello", "world"]);
  });

  it("1:1 corrections keep timing and are flagged edited", () => {
    const p0 = proj("their going home");
    const p = editCaptionText(p0, p0.captions[0].id, "they're going home");
    const w = views(p)[0].words[0];
    expect(w.text).toBe("they're");
    expect(w.start).toBe(p0.words[0].start);
    expect(w.edited).toBe(true);
    expect(w.timingSource).toBe("aligned");
  });

  it("deleted words disappear from captions but stay in sourceWords", () => {
    const p0 = proj("um hello there");
    const p = editCaptionText(p0, p0.captions[0].id, "hello there");
    expect(views(p)[0].text).toBe("hello there");
    expect(p.sourceWords).toHaveLength(3);
  });

  it("punctuation/case edits keep timing", () => {
    const p0 = proj("hello world");
    const p = editCaptionText(p0, p0.captions[0].id, "Hello, world!");
    expect(views(p)[0].words.every((w) => w.timingSource === "aligned")).toBe(true);
  });

  it("split, merge, delete and timing changes", () => {
    let p = proj("one two three four five six seven eight");
    const first = p.captions[0];
    p = splitCaption(p, first.id, 2);
    expect(views(p)[0].text).toBe("one two");
    expect(views(p)[1].text).toBe("three four");
    p = mergeWithNext(p, p.captions[0].id);
    expect(views(p)[0].text).toBe("one two three four");
    const n = p.captions.length;
    p = deleteCaption(p, p.captions[n - 1].id);
    expect(p.captions).toHaveLength(n - 1);
    p = setCaptionTiming(p, p.captions[0].id, 0.5, 4);
    expect(views(p)[0].start).toBe(0.5);
    expect(views(p)[0].end).toBe(4);
    expect(setCaptionTiming(p, p.captions[0].id, 4, 1)).toBe(p); // invalid range rejected
  });

  it("locked captions survive regrouping", () => {
    let p = proj("one two three four five six seven eight nine ten");
    p = splitCaption(p, p.captions[0].id, 1);
    const locked = views(p)[0].text;
    p = setGrouping(p, { maxWords: 3 });
    expect(views(p)[0].text).toBe(locked);
    expect(views(p).slice(1).every((v) => v.words.length <= 3)).toBe(true);
  });

  it("manual word timing keeps order", () => {
    const p0 = proj("a b c");
    const p = setWordTiming(p0, p0.words[1].id, 99, 100);
    expect(p.words[1].start).toBeLessThanOrEqual(p.words[2].start);
    expect(p.words[1].timingSource).toBe("manual");
  });

  it("reset restores the original alignment", () => {
    let p = proj("hello world");
    p = editCaptionText(p, p.captions[0].id, "goodbye cruel world");
    p = resetEdits(p);
    expect(p.words.map((w) => w.text)).toEqual(["hello", "world"]);
    expect(p.words.every((w) => w.timingSource === "aligned")).toBe(true);
  });

  it("validates before AE creation", () => {
    expect(validateForAE(proj())).toEqual([]);
    const p = proj();
    const bad = { ...p, words: p.words.map((w, i) => (i === 0 ? { ...w, start: NaN } : w)) };
    expect(validateForAE(bad).length).toBeGreaterThan(0);
  });
});

describe("undo/redo", () => {
  it("restores snapshots in order", () => {
    const h = new History<number>();
    h.push(1, "a");
    h.push(2, "b");
    expect(h.undo(3)?.state).toBe(2);
    expect(h.undo(2)?.state).toBe(1);
    expect(h.redo(1)?.state).toBe(2);
    h.push(2, "c");
    expect(h.canRedo).toBe(false);
  });
});

// ------------------------------------------------------------ persistence
describe("project JSON", () => {
  it("round-trips without loss", () => {
    let p = proj("hello world this is great");
    p = editCaptionText(p, p.captions[0].id, "hello there world");
    const back = parseProject(serializeProject(p));
    expect(back.words).toEqual(p.words);
    expect(back.sourceWords).toEqual(p.sourceWords);
    expect(back.captions).toEqual(p.captions);
    expect(back.source).toEqual(p.source);
    expect(back.style).toEqual(p.style);
  });
  it("rejects invalid files with a readable error", () => {
    expect(() => parseProject("{")).toThrow(ProjectError);
    expect(() => parseProject(JSON.stringify({ schemaVersion: 2 }))).toThrow(/version/);
    expect(() => parseProject(JSON.stringify({ schemaVersion: 1, words: [{ id: "a", text: "x", start: 2, end: 1 }], captions: [] }))).toThrow(/timing/);
  });
});

// ---------------------------------------------------------------- formats
describe("exports", () => {
  const p = proj("Hello world. This is a test of the caption engine");
  it("SRT", () => {
    const srt = toSRT(p);
    expect(srt.startsWith("1\n00:00:01,000 --> ")).toBe(true);
    expect(srt).toMatch(/\n2\n/);
  });
  it("VTT", () => {
    expect(toVTT(p).startsWith("WEBVTT\n\n00:00:01.000 --> ")).toBe(true);
  });
  it("TXT", () => {
    expect(toTXT(p).trim()).toBe("Hello world. This is a test of the caption engine");
  });
  it("ASS with styles and karaoke timing", () => {
    const k = { ...p, animation: { ...DEFAULT_ANIMATION, preset: "karaoke" as const } };
    const ass = toASS(k);
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toMatch(/Dialogue: 0,0:00:01\.00,/);
    expect(ass).toMatch(/\{\\k\d+\}Hello/);
    expect(assColor("#FF8000")).toBe("&H000080FF");
  });
  it("JSON export re-imports", () => {
    expect(parseProject(exportProject(p, "json")).words).toEqual(p.words);
  });
  it("SRT/VTT import", () => {
    const cues = parseCues("1\n00:00:01,000 --> 00:00:02,500\nHello <i>world</i>\n\n2\n00:00:03.000 --> 00:00:04.000\nSecond line\n");
    expect(cues).toEqual([{ start: 1, end: 2.5, text: "Hello world" }, { start: 3, end: 4, text: "Second line" }]);
    const vtt = parseCues("WEBVTT\n\n00:01.000 --> 00:02.000 align:center\nHi\n");
    expect(vtt[0].start).toBe(1);
    const ip = projectFromCues(cues, "x");
    expect(views(ip)[0].start).toBe(1);
    expect(views(ip)[0].end).toBe(2.5);
    expect(ip.words.every((w) => w.timingSource === "inferred")).toBe(true);
    expect(toSRT(ip)).toContain("00:00:01,000 --> 00:00:02,500");
  });
});

// -------------------------------------------------------------- animation
describe("animation", () => {
  it("word animations use real word starts, not even spacing", () => {
    const wt = { starts: [0, 0.31, 0.47, 1.2], ends: [0.29, 0.45, 0.8, 1.5] };
    const pre = wordAmount("wordPop", 0.18, 0.3, 1, 0, wt);
    const post = wordAmount("wordPop", 0.18, 0.5, 1, 0, wt);
    expect(pre).toBe(100); // word 2 still hidden at 0.30s
    expect(post).toBeLessThan(5); // visible after its start
    expect(wordAmount("karaoke", 0.18, 1.19, 3, 0, wt)).toBe(0);
    expect(wordAmount("karaoke", 0.18, 1.3, 3, 0, wt)).toBe(100);
    expect(wordAmount("highlight", 0.18, 0.4, 1, 0, wt)).toBe(100);
    expect(wordAmount("highlight", 0.18, 0.6, 1, 0, wt)).toBe(0);
  });

  it("character maps follow the layer text", () => {
    const m = charMaps("hi you\rthere", ["hi", "you", "there"], { starts: [0, 0.5, 1], ends: [0.4, 0.9, 1.4] });
    expect(m.charWord).toEqual([0, 0, -1, 1, 1, 1, -1, 2, 2, 2, 2, 2]);
    expect(m.charTime[7]).toBe(1);
  });

  it("generated expression is ES3 and evaluates like the preview", () => {
    const wt = { starts: [0, 0.4], ends: [0.3, 0.8] };
    const expr = wordExpression("karaoke", 0.18, "ab cd", ["ab", "cd"], wt);
    expect(expr).not.toMatch(/=>|\blet\b|\bconst\b/);
    for (const [t, idx] of [[0.2, 4], [0.5, 4], [0.1, 1]] as [number, number][]) {
      // eslint-disable-next-line no-new-func
      const fn = new Function("textIndex", "time", "thisLayer", `${expr.replace(/r;$/, "return r;")}`);
      const got = fn(idx, t, { inPoint: 0 });
      const m = charMaps("ab cd", ["ab", "cd"], wt);
      expect(got).toBeCloseTo(wordAmount("karaoke", 0.18, t, m.charWord[idx - 1], m.charTime[idx - 1], wt), 6);
    }
  });

  it("caption tracks are well formed", () => {
    for (const preset of ["fade", "pop", "slideUp", "slideDown", "bounce"] as const) {
      const tr = captionTracks({ ...DEFAULT_ANIMATION, preset }, 72);
      expect(tr.opacity.length).toBeGreaterThan(0);
      expect(evalTrack(tr.opacity, 10, 20, 100)).toBe(100);
      expect(evalTrack(tr.opacity, 0, 20, 100)).toBe(0);
    }
  });
});

describe("AE plan", () => {
  it("snaps layers to frames and keeps word expression timing relative to the layer", () => {
    const p = { ...proj("one two three four five six"), animation: { ...DEFAULT_ANIMATION, preset: "wordPop" as const } };
    const fd = 1001 / 30000;
    const plan = buildPlan(p, fd);
    expect(plan.layers.length).toBe(views(p).length);
    for (const l of plan.layers) {
      expect(l.inPoint / fd).toBeCloseTo(Math.round(l.inPoint / fd), 6);
      expect(l.outPoint).toBeGreaterThan(l.inPoint);
      expect(l.wordExpression).toContain("var S=");
    }
    expect(plan.layers[0].name).toBe("Caption 001");
    expect(hexToRGB("#FF0000")).toEqual([1, 0, 0]);
  });
});

describe("presets", () => {
  it("round-trips user presets and drops invalid data", () => {
    const mine = { ...BUILT_IN_PRESETS[1], id: "u1", name: "My Caption", builtIn: false };
    const back = parsePresetFile(serializePresets([BUILT_IN_PRESETS[0], mine]));
    expect(back.map((x) => x.name)).toEqual(["My Caption"]);
    expect(sanitizePreset({ name: "x", style: { fill: "red", fontSize: "big" } })?.style.fill).toBe("#FFFFFF");
    expect(sanitizePreset({})).toBeNull();
    expect(parsePresetFile("garbage")).toEqual([]);
  });
});
