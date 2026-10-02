import type { AnimationSettings, SegmentSettings, StyleSettings } from "./types";

export const APP_VERSION = "1.0.0";

export const DEFAULT_SEGMENT: SegmentSettings = {
  maxWords: 4,
  maxCharsPerLine: 24,
  maxLines: 2,
  pauseSplit: 0.9,
  maxDuration: 6,
  hold: 0.35,
  minDuration: 0.5,
};

export const DEFAULT_STYLE: StyleSettings = {
  font: "Arial-BoldMT",
  fontFamily: "Arial",
  fontSize: 72,
  fill: "#FFFFFF",
  strokeEnabled: true,
  stroke: "#000000",
  strokeWidth: 6,
  shadowEnabled: false,
  shadowColor: "#000000",
  shadowOpacity: 0.6,
  shadowDistance: 6,
  shadowSoftness: 12,
  tracking: 0,
  leading: 0,
  align: "center",
  positionY: 0.78,
  positionX: 0.5,
  allCaps: false,
  backgroundEnabled: false,
  background: "#000000",
  backgroundOpacity: 0.6,
  padding: 18,
  scale: 100,
};

export const DEFAULT_ANIMATION: AnimationSettings = {
  preset: "pop",
  duration: 0.18,
  easing: "easeOut",
  highlightColor: "#FFD43B",
  animateOut: false,
};

export const ANIMATION_PRESETS: { id: AnimationSettings["preset"]; label: string; perWord: boolean }[] = [
  { id: "none", label: "None", perWord: false },
  { id: "fade", label: "Fade", perWord: false },
  { id: "pop", label: "Pop", perWord: false },
  { id: "slideUp", label: "Slide Up", perWord: false },
  { id: "slideDown", label: "Slide Down", perWord: false },
  { id: "bounce", label: "Bounce", perWord: false },
  { id: "wordPop", label: "Word Pop", perWord: true },
  { id: "karaoke", label: "Karaoke", perWord: true },
  { id: "typewriter", label: "Typewriter", perWord: true },
  { id: "highlight", label: "Highlight", perWord: true },
];
