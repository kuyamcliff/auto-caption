// Pure editing operations on a Project. Every function returns a new Project
// and never mutates its input, which makes undo/redo a list of snapshots.
// Original engine output lives in project.sourceWords and is never touched.

import { captionViews, newCaptionId, normWord, regroup } from "./segment";
import type { Caption, Project, Word } from "./types";

let wordCounter = 0;
function newWordId(): string {
  wordCounter += 1;
  return `u${Date.now().toString(36)}${wordCounter.toString(36)}`;
}

function touch(p: Project): Project {
  return { ...p, project: { ...p.project, updatedAt: new Date().toISOString() } };
}

export function tokenize(text: string, noSpaces: boolean): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (noSpaces) return Array.from(clean.replace(/ /g, ""));
  return clean.split(" ");
}

/** Longest-common-subsequence alignment of two token lists (by normalised text). */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] && a[i] !== "" ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j] && a[i] !== "") {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Spread `count` new words over [lo, hi] proportionally to their length. */
function spread(tokens: string[], lo: number, hi: number): { start: number; end: number }[] {
  const lens = tokens.map((t) => Math.max(1, t.length));
  const total = lens.reduce((x, y) => x + y, 0);
  const out: { start: number; end: number }[] = [];
  let acc = 0;
  for (const l of lens) {
    const s = lo + ((hi - lo) * acc) / total;
    acc += l;
    out.push({ start: s, end: lo + ((hi - lo) * acc) / total });
  }
  return out;
}

/**
 * Replace the text of one caption. Unchanged words keep their aligned timing,
 * 1:1 corrections ("their" -> "there") keep the timing of the word they
 * replace (the audio is the same word) and are flagged edited. Inserted words
 * get interpolated timing marked "inferred" -- never presented as aligned.
 */
export function editCaptionText(p: Project, captionId: string, newText: string): Project {
  const cap = p.captions.find((c) => c.id === captionId);
  if (!cap) return p;
  const noSpaces = !!p.transcription.noSpaces;
  const byId = new Map(p.words.map((w) => [w.id, w]));
  const oldWords = cap.wordIds.map((id) => byId.get(id)).filter((w): w is Word => !!w);
  const tokens = tokenize(newText, noSpaces);
  if (!tokens.length) return deleteCaption(p, captionId);
  if (oldWords.length && tokens.join(" ") === oldWords.map((w) => w.text).join(" ")) return p;

  const a = oldWords.map((w) => normWord(w.text));
  const b = tokens.map(normWord);
  const pairs = lcsPairs(a, b);
  const result: Word[] = [];
  // walk gaps between matched pairs
  const anchors: [number, number][] = [[-1, -1], ...pairs, [oldWords.length, tokens.length]];
  const capIndex = p.captions.indexOf(cap);
  const prevWord = (() => {
    for (let k = capIndex - 1; k >= 0; k--) {
      const ids = p.captions[k].wordIds;
      const w = byId.get(ids[ids.length - 1]);
      if (w) return w;
    }
    return undefined;
  })();
  const nextWord = (() => {
    for (let k = capIndex + 1; k < p.captions.length; k++) {
      const w = byId.get(p.captions[k].wordIds[0]);
      if (w) return w;
    }
    return undefined;
  })();
  for (let k = 0; k < anchors.length - 1; k++) {
    const [ai, bi] = anchors[k];
    const [aj, bj] = anchors[k + 1];
    if (ai >= 0) {
      const ow = oldWords[ai];
      const nt = tokens[bi];
      result.push(nt === ow.text ? ow : { ...ow, text: nt, edited: true });
    }
    const removed = oldWords.slice(ai + 1, aj);
    const inserted = tokens.slice(bi + 1, bj);
    if (!inserted.length) continue;
    if (removed.length === inserted.length) {
      inserted.forEach((t, x) => result.push({ ...removed[x], text: t, edited: true }));
      continue;
    }
    let lo: number;
    let hi: number;
    if (removed.length) {
      lo = removed[0].start;
      hi = removed[removed.length - 1].end;
    } else {
      const before = ai >= 0 ? oldWords[ai] : prevWord;
      const after = aj < oldWords.length ? oldWords[aj] : nextWord;
      lo = before ? before.end : after ? Math.max(0, after.start - 0.3 * inserted.length) : 0;
      hi = after ? after.start : lo + 0.3 * inserted.length;
      if (hi - lo < 0.06 * inserted.length) {
        // no silence to place the word in: share the neighbours' boundary region
        const mid = (lo + hi) / 2;
        lo = Math.max(before ? before.start : mid - 0.1, mid - 0.06 * inserted.length);
        hi = Math.max(lo + 0.06 * inserted.length, Math.min(after ? after.end : mid + 0.1, mid + 0.06 * inserted.length));
      }
    }
    spread(inserted, lo, hi).forEach((r, x) => {
      result.push({ id: newWordId(), text: inserted[x], start: r.start, end: r.end, timingSource: "inferred" });
    });
  }
  const removedIds = new Set(oldWords.map((w) => w.id));
  const firstPos = p.words.findIndex((w) => removedIds.has(w.id));
  const words = p.words.filter((w) => !removedIds.has(w.id));
  const insertAt = firstPos >= 0 ? firstPos : words.length;
  words.splice(insertAt, 0, ...result);
  // keep global start order for words inferred at the edges
  const captions = p.captions.map((c) => (c.id === captionId ? { ...c, wordIds: result.map((w) => w.id) } : c));
  return touch({ ...p, words, captions });
}

export function splitCaption(p: Project, captionId: string, atWordIndex: number): Project {
  const i = p.captions.findIndex((c) => c.id === captionId);
  if (i < 0) return p;
  const c = p.captions[i];
  if (atWordIndex <= 0 || atWordIndex >= c.wordIds.length) return p;
  const a: Caption = { id: c.id, wordIds: c.wordIds.slice(0, atWordIndex), locked: true, start: c.start };
  const b: Caption = { id: newCaptionId(), wordIds: c.wordIds.slice(atWordIndex), locked: true, end: c.end };
  const captions = [...p.captions.slice(0, i), a, b, ...p.captions.slice(i + 1)];
  return touch({ ...p, captions });
}

export function mergeWithNext(p: Project, captionId: string): Project {
  const i = p.captions.findIndex((c) => c.id === captionId);
  if (i < 0 || i >= p.captions.length - 1) return p;
  const a = p.captions[i];
  const b = p.captions[i + 1];
  const merged: Caption = { id: a.id, wordIds: [...a.wordIds, ...b.wordIds], locked: true, start: a.start, end: b.end };
  return touch({ ...p, captions: [...p.captions.slice(0, i), merged, ...p.captions.slice(i + 2)] });
}

export function deleteCaption(p: Project, captionId: string): Project {
  const c = p.captions.find((x) => x.id === captionId);
  if (!c) return p;
  const ids = new Set(c.wordIds);
  return touch({ ...p, captions: p.captions.filter((x) => x.id !== captionId), words: p.words.filter((w) => !ids.has(w.id)) });
}

/** Manual display timing for a caption (word timing untouched). */
export function setCaptionTiming(p: Project, captionId: string, start: number, end: number): Project {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) return p;
  return touch({
    ...p,
    captions: p.captions.map((c) => (c.id === captionId ? { ...c, start, end, locked: true } : c)),
  });
}

/**
 * Manual timing for one word; marks it "manual". The start is clamped between
 * its neighbours' starts so word order (and caption contiguity) stays valid.
 */
export function setWordTiming(p: Project, wordId: string, start: number, end: number): Project {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || start < 0) return p;
  const i = p.words.findIndex((w) => w.id === wordId);
  if (i < 0) return p;
  const lo = i > 0 ? p.words[i - 1].start : 0;
  const hi = i < p.words.length - 1 ? p.words[i + 1].start : Infinity;
  const s = Math.min(Math.max(start, lo), hi);
  const e = Math.max(s, end);
  const words = p.words.map((w, k) => (k === i ? { ...w, start: s, end: e, timingSource: "manual" as const } : w));
  return touch({ ...p, words });
}

export function setGrouping(p: Project, patch: Partial<Project["segment"]>, keepLocked = true): Project {
  const segment = { ...p.segment, ...patch };
  const base = keepLocked ? p.captions : [];
  return touch({ ...p, segment, captions: regroup(p.words, base, segment, !!p.transcription.noSpaces) });
}

/** Restore the engine's original words and regroup (undoable). */
export function resetEdits(p: Project): Project {
  const words = p.sourceWords.map((w) => ({ ...w }));
  return touch({ ...p, words, captions: regroup(words, [], p.segment, !!p.transcription.noSpaces) });
}

export function views(p: Project) {
  return captionViews(p.words, p.captions, p.segment, !!p.transcription.noSpaces);
}

export function findCaptionAt(p: Project, t: number): string | null {
  const v = views(p);
  let lo = 0;
  let hi = v.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (v[mid].end <= t) lo = mid + 1;
    else if (v[mid].start > t) hi = mid - 1;
    else return v[mid].id;
  }
  return null;
}

/** Sanity check before creating AE layers. Returns human-readable problems. */
export function validateForAE(p: Project): string[] {
  const problems: string[] = [];
  const v = views(p);
  if (!v.length) problems.push("There are no captions to create.");
  for (const c of v) {
    if (!Number.isFinite(c.start) || !Number.isFinite(c.end)) problems.push(`Caption ${c.index + 1} has invalid timing.`);
    else if (c.end <= c.start) problems.push(`Caption ${c.index + 1} ends before it starts.`);
    else if (c.start < -1 || c.end > p.source.compDuration + 60) problems.push(`Caption ${c.index + 1} is outside the composition.`);
    for (const w of c.words) {
      if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) problems.push(`A word in caption ${c.index + 1} has invalid timing.`);
    }
    if (problems.length > 5) break;
  }
  return problems;
}
