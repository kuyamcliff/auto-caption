// Animation model shared by the panel preview and the After Effects build.
//
// Caption-level presets are keyframe tracks (editable in AE afterwards).
// Word-level presets are an expression selector whose per-character amount
// is computed from the *aligned word start times*; the preview evaluates the
// exact same formula, so what you preview is what AE renders.

import type { AnimationSettings } from "./types";

export interface Key {
  /** seconds from caption start (>= 0) or, if fromEnd, seconds before caption end */
  t: number;
  v: number;
  fromEnd?: boolean;
}

export interface CaptionTracks {
  opacity: Key[]; // 0..100
  scale: Key[]; // percent
  offsetY: Key[]; // pixels, added to position y
}

/** Keyframes for caption-level presets (relative to caption start/end). */
export function captionTracks(a: AnimationSettings, fontSize: number): CaptionTracks {
  const d = Math.max(0.04, a.duration);
  const tr: CaptionTracks = { opacity: [], scale: [], offsetY: [] };
  const fadeIn = (len: number) => [{ t: 0, v: 0 }, { t: len, v: 100 }];
  switch (a.preset) {
    case "fade":
      tr.opacity = fadeIn(d);
      break;
    case "pop":
      tr.opacity = fadeIn(d * 0.5);
      tr.scale = [{ t: 0, v: 60 }, { t: d * 0.7, v: 106 }, { t: d, v: 100 }];
      break;
    case "slideUp":
    case "slideDown": {
      const dist = Math.round(fontSize * 0.45) * (a.preset === "slideUp" ? 1 : -1);
      tr.opacity = fadeIn(d * 0.8);
      tr.offsetY = [{ t: 0, v: dist }, { t: d, v: 0 }];
      break;
    }
    case "bounce":
      tr.opacity = fadeIn(d * 0.35);
      tr.scale = [{ t: 0, v: 0 }, { t: d * 0.5, v: 116 }, { t: d * 0.75, v: 94 }, { t: d, v: 100 }];
      break;
    default:
      break;
  }
  if (a.animateOut && a.preset !== "none") {
    tr.opacity.push({ t: d * 0.8, v: 100, fromEnd: true }, { t: 0, v: 0, fromEnd: true });
    if (!tr.opacity.some((k) => !k.fromEnd)) tr.opacity.unshift({ t: 0, v: 100 });
  }
  return tr;
}

/** AE "Easy Ease"-like cubic bezier (0.33,0,0.67,1) evaluated for x in [0,1]. */
export function easeEasy(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // solve bezier x(t) for t, then y(t)
  const cx = (t: number) => 3 * 0.33 * t * (1 - t) ** 2 + 3 * 0.67 * t * t * (1 - t) + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (cx(mid) < x) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  return 3 * t * t * (1 - t) + t ** 3;
}

/** Evaluate a keyframe track at time `t` seconds from caption start. */
export function evalTrack(keys: Key[], t: number, captionDur: number, rest: number): number {
  if (!keys.length) return rest;
  const abs = keys.map((k) => ({ t: k.fromEnd ? captionDur - k.t : k.t, v: k.v })).sort((a, b) => a.t - b.t);
  if (t <= abs[0].t) return abs[0].v;
  for (let i = 0; i < abs.length - 1; i++) {
    const a = abs[i];
    const b = abs[i + 1];
    if (t <= b.t) {
      const span = b.t - a.t;
      const x = span > 0 ? (t - a.t) / span : 1;
      return a.v + (b.v - a.v) * easeEasy(x);
    }
  }
  return abs[abs.length - 1].v;
}

// ------------------------------------------------------------- word level
export const WORD_PRESETS = new Set(["wordPop", "karaoke", "typewriter", "highlight"]);
export const KARAOKE_RAMP = 0.06;

export interface WordTiming {
  /** seconds relative to caption (layer) start */
  starts: number[];
  ends: number[];
}

/**
 * Per-character data for the expression selector (AE "Based On: Characters").
 * `charWord[i]` is the word index of character i of the layer text, -1 for
 * whitespace; `charTime[i]` is when that character appears (typewriter).
 */
export function charMaps(text: string, wordTexts: string[], wt: WordTiming): { charWord: number[]; charTime: number[] } {
  const charWord: number[] = [];
  const charTime: number[] = [];
  // Languages written without spaces: every character is its own unit.
  const perChar = wordTexts.length > 0 && wordTexts.every((t) => Array.from(t).length === 1);
  let w = 0;
  let k = 0; // position inside current word
  let inWord = false;
  for (const ch of Array.from(text)) {
    if (/\s/.test(ch)) {
      charWord.push(-1);
      charTime.push(0);
      if (inWord) {
        w++;
        k = 0;
        inWord = false;
      }
      continue;
    }
    if (perChar && inWord) {
      w++;
      k = 0;
    }
    inWord = true;
    const wi = Math.min(w, wordTexts.length - 1);
    const len = Math.max(1, Array.from(wordTexts[wi] ?? "").length);
    const dur = Math.min(0.15, Math.max(0, (wt.ends[wi] ?? 0) - (wt.starts[wi] ?? 0)));
    charWord.push(wi);
    charTime.push(round3((wt.starts[wi] ?? 0) + (dur * k) / len));
    k++;
  }
  return { charWord, charTime };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Amount (-100..100) of the word animator for one character at layer time t.
 * Mirrors the generated AE expression exactly.
 */
export function wordAmount(preset: string, d: number, t: number, wi: number, charTime: number, wt: WordTiming): number {
  if (wi < 0) return 0;
  const s = wt.starts[wi];
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  switch (preset) {
    case "wordPop": {
      const p = (t - s) / Math.max(0.01, d);
      if (p < 0) return 100;
      if (p >= 1) return 0;
      // back-ease out: overshoot gives a small negative amount (scale > 100%)
      const c1 = 1.70158;
      const c3 = c1 + 1;
      const e = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
      return 100 * (1 - e);
    }
    case "karaoke":
      return 100 * clamp((t - s) / KARAOKE_RAMP);
    case "highlight": {
      const next = wi + 1 < wt.starts.length ? wt.starts[wi + 1] : wt.ends[wi] + 0.25;
      return 100 * (clamp((t - s) / KARAOKE_RAMP) - clamp((t - next) / KARAOKE_RAMP));
    }
    case "typewriter":
      return t < charTime ? 100 : 0;
    default:
      return 0;
  }
}

/** What the word animator changes (amount 100 = full effect). */
export function wordAnimatorProps(a: AnimationSettings): { opacity?: number; scale?: number; fill?: string } {
  switch (a.preset) {
    case "wordPop":
      return { opacity: 0, scale: 45 };
    case "karaoke":
      return { fill: a.highlightColor };
    case "highlight":
      return { fill: a.highlightColor, scale: 108 };
    case "typewriter":
      return { opacity: 0 };
    default:
      return {};
  }
}

function arr(xs: number[]): string {
  return "[" + xs.map((x) => (Number.isInteger(x) ? String(x) : x.toFixed(3))).join(",") + "]";
}

/**
 * AE expression for the Expression Selector "Amount" (Based On: Characters).
 * ES3-compatible so it runs on both the Legacy and JavaScript engines.
 */
export function wordExpression(preset: string, d: number, text: string, wordTexts: string[], wt: WordTiming): string {
  const { charWord, charTime } = charMaps(text, wordTexts, wt);
  const head =
    `// AutoCaption AE: word timing from forced alignment (seconds from layer in-point)\n` +
    `var W=${arr(charWord)};\nvar S=${arr(wt.starts.map(round3))};\nvar E=${arr(wt.ends.map(round3))};\n` +
    `var i=textIndex-1;var w=(i>=0&&i<W.length)?W[i]:-1;var t=time-thisLayer.inPoint;var r=0;\n` +
    `function cl(x){return x<0?0:(x>1?1:x);}\n`;
  let body: string;
  switch (preset) {
    case "wordPop":
      body = `if(w>=0){var p=(t-S[w])/${Math.max(0.01, d).toFixed(3)};if(p<0){r=100;}else if(p>=1){r=0;}else{var c1=1.70158,c3=c1+1;var e=1+c3*Math.pow(p-1,3)+c1*Math.pow(p-1,2);r=100*(1-e);}}\n`;
      break;
    case "karaoke":
      body = `if(w>=0){r=100*cl((t-S[w])/${KARAOKE_RAMP});}\n`;
      break;
    case "highlight":
      body = `if(w>=0){var n=(w+1<S.length)?S[w+1]:E[w]+0.25;r=100*(cl((t-S[w])/${KARAOKE_RAMP})-cl((t-n)/${KARAOKE_RAMP}));}\n`;
      break;
    case "typewriter":
      body = `var C=${arr(charTime)};\nif(w>=0){r=(t<C[i])?100:0;}\n`;
      break;
    default:
      body = "";
  }
  return head + body + "r;";
}
