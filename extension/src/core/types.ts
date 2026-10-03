// Core data model. All times are seconds in *composition time* (AE's internal
// time, where 0 is the start of the composition; displayStartTime is only
// added for display). Word timings are the source of truth; captions only
// group word ids and never own word timing.

export type TimingSource = "aligned" | "inferred" | "fallback" | "manual";

export interface Word {
  id: string;
  text: string;
  start: number;
  end: number;
  timingSource: TimingSource;
  score?: number;
  /** text changed by the user, timing still from the original word */
  edited?: boolean;
}

export interface Caption {
  id: string;
  wordIds: string[];
  /** user-locked grouping/timing: kept as-is when captions are regrouped */
  locked?: boolean;
  /** manual display timing overrides */
  start?: number;
  end?: number;
}

export interface SourceInfo {
  composition: string;
  compId?: number;
  layers: { name: string; index: number; type: LayerType }[];
  layerType: LayerType;
  fps: number;
  frameDuration: number;
  compStartTime: number; // displayStartTime
  compDuration: number;
  width: number;
  height: number;
  /** composition time that corresponds to t=0 of the transcribed audio */
  audioOffset: number;
  audioDuration: number;
  mapping: "render" | "source" | "import";
}

export type LayerType = "audio" | "video" | "precomp" | "unknown";

export interface TranscriptionInfo {
  language: string;
  languageProbability?: number | null;
  noSpaces?: boolean;
  model: string;
  aligned: boolean;
  alignmentModel?: string | null;
  device?: string;
  warnings: { code: string; message: string }[];
}

export interface SegmentSettings {
  maxWords: number;
  maxCharsPerLine: number;
  maxLines: 1 | 2;
  /** a silence longer than this always ends a caption */
  pauseSplit: number;
  maxDuration: number;
  /** keep a caption on screen this long after its last word if nothing follows */
  hold: number;
  minDuration: number;
}

export type AnimationPreset =
  | "none" | "fade" | "pop" | "slideUp" | "slideDown" | "bounce"
  | "wordPop" | "karaoke" | "typewriter" | "highlight";

export interface AnimationSettings {
  preset: AnimationPreset;
  duration: number; // seconds, in/out transition length
  easing: "easeOut" | "easeInOut" | "linear" | "back";
  highlightColor: string;
  animateOut: boolean;
}

export interface StyleSettings {
  font: string; // PostScript name
  fontFamily: string; // CSS family for preview
  fontSize: number; // px at comp resolution
  fill: string;
  strokeEnabled: boolean;
  stroke: string;
  strokeWidth: number;
  shadowEnabled: boolean;
  shadowColor: string;
  shadowOpacity: number; // 0..1
  shadowDistance: number;
  shadowSoftness: number;
  tracking: number;
  leading: number; // 0 = auto
  align: "left" | "center" | "right";
  positionY: number; // 0..1 of comp height (caption centre)
  positionX: number; // 0..1 of comp width
  allCaps: boolean;
  backgroundEnabled: boolean;
  background: string;
  backgroundOpacity: number;
  padding: number;
  scale: number; // percent
}

export interface Project {
  schemaVersion: 1;
  app: { name: "AutoCaption AE"; version: string };
  project: { id: string; name: string; createdAt: string; updatedAt: string };
  source: SourceInfo;
  transcription: TranscriptionInfo;
  /** words exactly as the engine produced them (never edited) */
  sourceWords: Word[];
  /** working words after user edits */
  words: Word[];
  captions: Caption[];
  segment: SegmentSettings;
  style: StyleSettings;
  animation: AnimationSettings;
}

export interface EngineResult {
  schemaVersion: 1;
  language: string;
  languageProbability?: number | null;
  noSpaces?: boolean;
  model?: string;
  device?: string;
  aligned: boolean;
  alignmentModel?: string | null;
  durationSec: number;
  words: { id: string; text: string; start: number; end: number; timingSource: TimingSource; score?: number }[];
  segments: { start: number; end: number; text: string; wordIds: string[] }[];
  warnings: { code: string; message: string }[];
  timings?: Record<string, number>;
}
