// Built-in caption styles and user preset handling.

import { DEFAULT_ANIMATION, DEFAULT_STYLE } from "./defaults";
import type { AnimationSettings, StyleSettings } from "./types";

export interface StylePreset {
  id: string;
  name: string;
  builtIn?: boolean;
  style: StyleSettings;
  animation: AnimationSettings;
}

const S = DEFAULT_STYLE;
const A = DEFAULT_ANIMATION;

export const BUILT_IN_PRESETS: StylePreset[] = [
  { id: "clean", name: "Clean White", builtIn: true, style: { ...S }, animation: { ...A, preset: "pop" } },
  {
    id: "bold-social", name: "Bold Social", builtIn: true,
    style: { ...S, font: "Arial-Black", fontFamily: "Arial Black", fontSize: 84, allCaps: true, strokeWidth: 10, positionY: 0.62 },
    animation: { ...A, preset: "wordPop", duration: 0.16 },
  },
  {
    id: "youtube", name: "YouTube Clean", builtIn: true,
    style: { ...S, font: "ArialMT", fontFamily: "Arial", fontSize: 56, strokeEnabled: false, backgroundEnabled: true, backgroundOpacity: 0.72, positionY: 0.86 },
    animation: { ...A, preset: "fade", duration: 0.12 },
  },
  {
    id: "anime", name: "Anime White", builtIn: true,
    style: { ...S, font: "Impact", fontFamily: "Impact", fontSize: 80, strokeWidth: 8, shadowEnabled: true, shadowOpacity: 0.8, tracking: 20 },
    animation: { ...A, preset: "slideUp", duration: 0.2 },
  },
  {
    id: "karaoke", name: "Karaoke Yellow", builtIn: true,
    style: { ...S, font: "Arial-BoldMT", fontFamily: "Arial", fontSize: 76, allCaps: true, strokeWidth: 8 },
    animation: { ...A, preset: "karaoke", highlightColor: "#FFD43B" },
  },
  {
    id: "highlight", name: "Active Word", builtIn: true,
    style: { ...S, font: "Arial-Black", fontFamily: "Arial Black", fontSize: 78, allCaps: true, strokeWidth: 9, positionY: 0.7 },
    animation: { ...A, preset: "highlight", highlightColor: "#4ADE80" },
  },
];

/** Fonts that ship with Windows; used when AE cannot list installed fonts. */
export const FALLBACK_FONTS: { ps: string; family: string; label: string }[] = [
  { ps: "ArialMT", family: "Arial", label: "Arial" },
  { ps: "Arial-BoldMT", family: "Arial", label: "Arial Bold" },
  { ps: "Arial-Black", family: "Arial Black", label: "Arial Black" },
  { ps: "Impact", family: "Impact", label: "Impact" },
  { ps: "SegoeUI", family: "Segoe UI", label: "Segoe UI" },
  { ps: "SegoeUI-Bold", family: "Segoe UI", label: "Segoe UI Bold" },
  { ps: "SegoeUI-Black", family: "Segoe UI Black", label: "Segoe UI Black" },
  { ps: "Verdana-Bold", family: "Verdana", label: "Verdana Bold" },
  { ps: "Tahoma-Bold", family: "Tahoma", label: "Tahoma Bold" },
  { ps: "TrebuchetMS-Bold", family: "Trebuchet MS", label: "Trebuchet Bold" },
  { ps: "Georgia-Bold", family: "Georgia", label: "Georgia Bold" },
  { ps: "Calibri-Bold", family: "Calibri", label: "Calibri Bold" },
  { ps: "ComicSansMS-Bold", family: "Comic Sans MS", label: "Comic Sans Bold" },
];

const COLOR = /^#[0-9a-f]{6}$/i;

/** Sanitise a stored preset: unknown or invalid fields fall back to defaults. */
export function sanitizePreset(raw: unknown): StylePreset | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim()) return null;
  const style = { ...S } as Record<string, unknown>;
  const inStyle = (r.style || {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(S)) {
    const x = inStyle[k];
    if (typeof v === "number" && typeof x === "number" && Number.isFinite(x)) style[k] = x;
    else if (typeof v === "boolean" && typeof x === "boolean") style[k] = x;
    else if (typeof v === "string" && typeof x === "string" && x.length < 200) {
      if (/color|fill|stroke|background$/i.test(k) && k !== "strokeEnabled" && !COLOR.test(x)) continue;
      style[k] = x;
    }
  }
  const anim = { ...A, ...((r.animation || {}) as object) } as AnimationSettings;
  if (!["none", "fade", "pop", "slideUp", "slideDown", "bounce", "wordPop", "karaoke", "typewriter", "highlight"].includes(anim.preset)) anim.preset = A.preset;
  if (!Number.isFinite(anim.duration) || anim.duration <= 0 || anim.duration > 2) anim.duration = A.duration;
  if (!COLOR.test(anim.highlightColor)) anim.highlightColor = A.highlightColor;
  return { id: typeof r.id === "string" ? r.id : `u${Date.now().toString(36)}`, name: r.name.trim().slice(0, 60), style: style as unknown as StyleSettings, animation: anim };
}

export interface PresetFile {
  version: 1;
  presets: StylePreset[];
}

export function parsePresetFile(text: string): StylePreset[] {
  try {
    const data = JSON.parse(text) as PresetFile;
    if (data.version !== 1 || !Array.isArray(data.presets)) return [];
    return data.presets.map(sanitizePreset).filter((x): x is StylePreset => !!x);
  } catch {
    return [];
  }
}

export function serializePresets(presets: StylePreset[]): string {
  return JSON.stringify({ version: 1, presets: presets.filter((p) => !p.builtIn) } satisfies PresetFile, null, 1);
}
