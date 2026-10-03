// Builds the exact layer plan host.jsx executes. All decisions (frame
// snapping, text, line breaks, keyframes, expressions) are made here in
// tested TypeScript; the ExtendScript side only applies them.

import { captionTracks, WORD_PRESETS, wordAnimatorProps, wordExpression } from "./anim";
import { views } from "./edit";
import { joinWords } from "./segment";
import { snapToFrames } from "./timing";
import type { Project, StyleSettings } from "./types";

export interface LayerPlan {
  name: string;
  text: string;
  inPoint: number;
  outPoint: number;
  /** keyframes in absolute composition seconds */
  opacity: [number, number][];
  scale: [number, number][];
  offsetY: [number, number][];
  wordExpression?: string;
}

export interface AEPlan {
  setName: string;
  frameDuration: number;
  compWidth: number;
  compHeight: number;
  style: StyleSettings & { fillRGB: number[]; strokeRGB: number[]; shadowRGB: number[]; backgroundRGB: number[] };
  wordAnimator: null | { opacity?: number; scale?: number; fillRGB?: number[] };
  layers: LayerPlan[];
}

export function hexToRGB(hex: string): number[] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? m[1] : "ffffff";
  return [0, 2, 4].map((i) => Math.round((parseInt(v.slice(i, i + 2), 16) / 255) * 1000) / 1000);
}

export function buildPlan(p: Project, frameDuration: number, setName = "AUTO CAPTIONS"): AEPlan {
  const noSpaces = !!p.transcription.noSpaces;
  const a = p.animation;
  const tracks = captionTracks(a, p.style.fontSize);
  const perWord = WORD_PRESETS.has(a.preset);
  const vs = views(p);
  const pad = String(vs.length).length > 3 ? String(vs.length).length : 3;
  const layers: LayerPlan[] = vs.map((v, i) => {
    const fr = snapToFrames(v.start, v.end, frameDuration);
    const lineTexts = v.lines.map((l) => joinWords(l, noSpaces));
    let text = lineTexts.join("\r");
    if (p.style.allCaps) text = text.toLocaleUpperCase();
    const dur = fr.outPoint - fr.inPoint;
    const abs = (keys: typeof tracks.opacity): [number, number][] =>
      keys.map((k) => [round6(fr.inPoint + Math.max(0, Math.min(dur, k.fromEnd ? dur - k.t : k.t))), k.v] as [number, number])
        .sort((x, y) => x[0] - y[0])
        .filter((k, j, arr) => j === 0 || k[0] > arr[j - 1][0] + 1e-6);
    const plan: LayerPlan = {
      name: `Caption ${String(i + 1).padStart(pad, "0")}`,
      text,
      inPoint: round6(fr.inPoint),
      outPoint: round6(fr.outPoint),
      opacity: abs(tracks.opacity),
      scale: abs(tracks.scale),
      offsetY: abs(tracks.offsetY),
    };
    if (perWord) {
      const words = v.lines.flat();
      const wt = { starts: words.map((w) => w.start - fr.inPoint), ends: words.map((w) => w.end - fr.inPoint) };
      const wordTexts = words.map((w) => (p.style.allCaps ? w.text.toLocaleUpperCase() : w.text));
      plan.wordExpression = wordExpression(a.preset, a.duration, text, noSpaces ? Array.from(text.replace(/\s/g, "")) : wordTexts,
        noSpaces ? expandNoSpace(words, wt) : wt);
    }
    return plan;
  });
  const props = perWord ? wordAnimatorProps(a) : null;
  return {
    setName,
    frameDuration,
    compWidth: p.source.width,
    compHeight: p.source.height,
    style: {
      ...p.style,
      fillRGB: hexToRGB(p.style.fill), strokeRGB: hexToRGB(p.style.stroke),
      shadowRGB: hexToRGB(p.style.shadowColor), backgroundRGB: hexToRGB(p.style.background),
    },
    wordAnimator: props ? { opacity: props.opacity, scale: props.scale, fillRGB: props.fill ? hexToRGB(props.fill) : undefined } : null,
    layers,
  };
}

/** For languages written without spaces each character is its own unit. */
function expandNoSpace(words: { text: string }[], wt: { starts: number[]; ends: number[] }) {
  const starts: number[] = [];
  const ends: number[] = [];
  words.forEach((w, i) => {
    const chars = Array.from(w.text.replace(/\s/g, ""));
    const span = (wt.ends[i] - wt.starts[i]) / Math.max(1, chars.length);
    chars.forEach((_, k) => {
      starts.push(wt.starts[i] + span * k);
      ends.push(wt.starts[i] + span * (k + 1));
    });
  });
  return { starts, ends };
}

/** Trim float noise without moving times off the frame grid (AE accepts any double). */
function round6(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}
