// Caption segmentation: groups aligned words into readable captions.
//
// Deterministic dynamic programming over break positions. A caption may hold
// at most `maxWords` words and must fit in `maxLines` lines of
// `maxCharsPerLine`. Among all valid partitions we pick the one with the
// lowest total cost, where cost rewards breaking at sentence ends, clause
// punctuation and pauses, penalises breaking after articles/prepositions
// ("the | car") and penalises very short captions. Grouping never touches
// word timing.

import type { Caption, SegmentSettings, Word } from "./types";

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/;
const CLAUSE_END = /[,;:，、—–-]["'”’)\]]*$/;

// Words that should not end a caption line ("the | car", "to | go").
const BAD_LINE_END = new Set([
  "a", "an", "the", "to", "of", "in", "on", "at", "for", "with", "from", "by", "into", "onto", "about",
  "and", "or", "but", "nor", "so", "if", "than", "as", "my", "your", "his", "her", "its", "our",
  "their", "this", "that", "these", "those", "is", "are", "was", "were", "be", "been", "am", "i", "i'm",
  "you're", "we're", "they're", "he's", "she's", "it's", "very", "really", "not", "no", "don't", "can't",
  "won't", "didn't", "doesn't", "will", "would", "could", "should", "can", "may", "might", "must", "just",
  "he", "she", "we", "they", "you", "it",
  // es / fr / de / it / pt articles & prepositions
  "el", "la", "los", "las", "un", "una", "de", "del", "y", "que", "le", "les", "des", "du", "et",
  "der", "die", "das", "ein", "eine", "und", "il", "lo", "gli", "e", "di", "o", "os", "as", "do", "da",
]);

// Words that make a good start of a new caption ("… | because we", "… | and then").
const GOOD_LINE_START = new Set([
  "and", "but", "or", "so", "because", "when", "while", "if", "then", "which", "who", "where",
  "that", "what", "why", "how", "although", "though", "until", "after", "before", "since", "unless",
]);

export function normWord(text: string): string {
  return text.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
}

export function joinWords(words: { text: string }[], noSpaces = false): string {
  return words.map((w) => w.text).join(noSpaces ? "" : " ");
}

/** Cost of placing a caption break after words[i] (before words[i+1]). */
export function breakCost(words: Word[], i: number): number {
  const w = words[i];
  const next = words[i + 1];
  if (!next) return -20; // end of transcript
  let cost = 0;
  if (SENTENCE_END.test(w.text)) cost -= 10;
  else if (CLAUSE_END.test(w.text)) cost -= 5;
  const gap = Math.max(0, next.start - w.end);
  cost -= Math.min(8, gap * 20);
  const n = normWord(w.text);
  if (!SENTENCE_END.test(w.text) && !CLAUSE_END.test(w.text) && BAD_LINE_END.has(n)) cost += 6;
  if (GOOD_LINE_START.has(normWord(next.text))) cost -= 2;
  // Never split a number from its unit/currency ("25 | dollars", "10 | %").
  if (/\d$/.test(w.text) && /^[%°]|^(percent|dollars?|euros?|pounds?|yen|am|pm)$/i.test(next.text)) cost += 8;
  return cost;
}

function captionChars(words: Word[], a: number, b: number, noSpaces: boolean): number {
  let n = 0;
  for (let k = a; k <= b; k++) n += words[k].text.length + (noSpaces || k === a ? 0 : 1);
  return n;
}

function fitsLines(words: Word[], a: number, b: number, s: SegmentSettings, noSpaces: boolean): boolean {
  const chars = captionChars(words, a, b, noSpaces);
  if (chars <= s.maxCharsPerLine) return true;
  if (s.maxLines < 2) return a === b; // a single over-long word is allowed alone
  if (a === b) return true;
  const lines = balanceLines(words.slice(a, b + 1), s.maxCharsPerLine, noSpaces);
  return lines.every((l) => joinWords(l, noSpaces).length <= s.maxCharsPerLine) || b - a === 0;
}

/**
 * Split words into captions. Returns arrays of word indices [start, end].
 */
export function segmentRange(words: Word[], s: SegmentSettings, noSpaces = false): [number, number][] {
  const n = words.length;
  if (n === 0) return [];
  const best = new Array<number>(n + 1).fill(Infinity);
  const prev = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  const maxWords = Math.max(1, Math.floor(s.maxWords));
  for (let end = 1; end <= n; end++) {
    // caption = words[start .. end-1]
    for (let start = end - 1; start >= 0 && end - start <= maxWords; start--) {
      if (best[start] === Infinity) continue;
      // hard constraints
      if (end - 1 > start) {
        // Growing leftwards adds the gap after words[start]; a long pause may
        // never sit inside a caption.
        if (words[start + 1].start - words[start].end > s.pauseSplit) break;
        if (words[end - 1].end - words[start].start > s.maxDuration) break;
      }
      if (!fitsLines(words, start, end - 1, s, noSpaces)) break;
      const count = end - start;
      let cost = breakCost(words, end - 1);
      // prefer fuller captions; strongly avoid orphans
      const missing = maxWords - count;
      cost += missing * missing * 0.6;
      if (count === 1 && maxWords > 1) {
        const before = start > 0 ? words[start].start - words[start - 1].end : 10;
        const after = end < n ? words[end].start - words[end - 1].end : 10;
        if (before < s.pauseSplit && after < s.pauseSplit) cost += 4;
      }
      const total = best[start] + cost;
      if (total < best[end] - 1e-9) {
        best[end] = total;
        prev[end] = start;
      }
    }
    if (best[end] === Infinity) {
      // Unreachable (e.g. a single word longer than every limit): force it alone.
      best[end] = best[end - 1] + 50;
      prev[end] = end - 1;
    }
  }
  const out: [number, number][] = [];
  for (let end = n; end > 0; end = prev[end]) out.push([prev[end], end - 1]);
  return out.reverse();
}

/**
 * Split a caption's words into at most two lines, choosing the break that
 * makes line lengths most even while avoiding bad line endings.
 * "THIS IS REALLY GOOD" -> ["THIS IS", "REALLY GOOD"].
 */
export function balanceLines<T extends { text: string }>(words: T[], maxCharsPerLine: number, noSpaces = false): T[][] {
  const total = joinWords(words, noSpaces).length;
  if (words.length < 2 || total <= maxCharsPerLine) return [words];
  let bestK = 1;
  let bestCost = Infinity;
  for (let k = 1; k < words.length; k++) {
    const a = joinWords(words.slice(0, k), noSpaces).length;
    const b = joinWords(words.slice(k), noSpaces).length;
    let cost = Math.abs(a - b);
    if (a > maxCharsPerLine || b > maxCharsPerLine) cost += 1000 + Math.max(a, b);
    const last = words[k - 1].text;
    if (SENTENCE_END.test(last)) cost -= 6;
    else if (CLAUSE_END.test(last)) cost -= 4;
    else if (BAD_LINE_END.has(normWord(last))) cost += 5;
    // a slightly longer bottom line reads better (pyramid shape)
    if (b >= a) cost -= 0.5;
    if (cost < bestCost) {
      bestCost = cost;
      bestK = k;
    }
  }
  return [words.slice(0, bestK), words.slice(bestK)];
}

let captionCounter = 0;
export function newCaptionId(): string {
  captionCounter += 1;
  return `c${Date.now().toString(36)}${captionCounter.toString(36)}`;
}

/**
 * Regroup working words into captions, keeping locked captions untouched and
 * segmenting only the free runs of words between them.
 */
export function regroup(words: Word[], existing: Caption[], s: SegmentSettings, noSpaces = false): Caption[] {
  const index = new Map(words.map((w, i) => [w.id, i]));
  const locked = existing
    .filter((c) => c.locked && c.wordIds.length && c.wordIds.every((id) => index.has(id)))
    .sort((a, b) => index.get(a.wordIds[0])! - index.get(b.wordIds[0])!);
  const lockedWord = new Set(locked.flatMap((c) => c.wordIds));
  const out: Caption[] = [];
  let run: number[] = [];
  let li = 0;
  const flush = () => {
    if (!run.length) return;
    const sub = run.map((i) => words[i]);
    for (const [a, b] of segmentRange(sub, s, noSpaces)) {
      out.push({ id: newCaptionId(), wordIds: sub.slice(a, b + 1).map((w) => w.id) });
    }
    run = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (lockedWord.has(w.id)) {
      flush();
      const c = locked[li];
      if (c && c.wordIds[0] === w.id) {
        out.push(c);
        li++;
      }
      continue;
    }
    run.push(i);
  }
  flush();
  return out;
}

export interface CaptionView {
  id: string;
  index: number;
  start: number;
  end: number;
  words: Word[];
  lines: Word[][];
  text: string;
  locked: boolean;
  hasInferred: boolean;
}

/**
 * Resolve display timing for every caption. Word timing is never modified;
 * captions start at their first word and stay visible until shortly after
 * their last word (bridging short gaps so text does not flicker).
 */
export function captionViews(words: Word[], captions: Caption[], s: SegmentSettings, noSpaces = false): CaptionView[] {
  const byId = new Map(words.map((w) => [w.id, w]));
  const views: CaptionView[] = [];
  for (const c of captions) {
    const ws = c.wordIds.map((id) => byId.get(id)).filter((w): w is Word => !!w);
    if (!ws.length) continue;
    const start = c.start ?? ws[0].start;
    const end = c.end ?? Math.max(...ws.map((w) => w.end));
    views.push({
      id: c.id, index: views.length, start, end, words: ws,
      lines: s.maxLines === 2 ? balanceLines(ws, s.maxCharsPerLine, noSpaces) : [ws],
      text: joinWords(ws, noSpaces), locked: !!c.locked,
      hasInferred: ws.some((w) => w.timingSource !== "aligned" && w.timingSource !== "manual"),
    });
  }
  const capById = new Map(captions.map((c) => [c.id, c]));
  for (let i = 0; i < views.length; i++) {
    const v = views[i];
    const c = capById.get(v.id);
    const next = views[i + 1];
    if (c?.end === undefined) {
      const lastEnd = v.end;
      let end = lastEnd + s.hold;
      if (next) {
        const gap = next.start - lastEnd;
        end = gap < s.hold + 0.25 ? next.start : Math.min(end, next.start);
      }
      if (end - v.start < s.minDuration) end = next ? Math.min(next.start, v.start + s.minDuration) : v.start + s.minDuration;
      v.end = Math.max(end, lastEnd);
    }
    if (next && v.end > next.start) v.end = Math.max(v.start + 0.001, next.start);
  }
  return views;
}
