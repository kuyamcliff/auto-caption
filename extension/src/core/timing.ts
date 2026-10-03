// Timeline math shared by the panel, the exporters and (mirrored) host.jsx.

/** Exact frame duration for common NTSC rates (AE stores 1001/24000 etc.). */
export function frameDurationFor(fps: number): number {
  const ntsc: Record<string, number> = { "23.976": 24, "29.97": 30, "47.952": 48, "59.94": 60, "119.88": 120 };
  const key = (Math.round(fps * 1000) / 1000).toString();
  if (ntsc[key]) return 1001 / (ntsc[key] * 1000);
  return 1 / fps;
}

/** Nearest frame index for a time. */
export function toFrame(t: number, frameDuration: number): number {
  return Math.round(t / frameDuration + 1e-9);
}

export interface FrameRange {
  inFrame: number;
  outFrame: number;
  inPoint: number;
  outPoint: number;
}

/**
 * Snap a caption's [start, end) to whole frames. Start rounds to the nearest
 * frame; the caption always lasts at least one frame. Because adjacent
 * captions share boundary values, rounding never makes them overlap.
 */
export function snapToFrames(start: number, end: number, frameDuration: number): FrameRange {
  const inFrame = toFrame(start, frameDuration);
  const outFrame = Math.max(inFrame + 1, toFrame(end, frameDuration));
  return { inFrame, outFrame, inPoint: inFrame * frameDuration, outPoint: outFrame * frameDuration };
}

/**
 * Map transcribed-audio time to composition time.
 *
 * "render" mapping (default): After Effects rendered the composition's own
 * audio for [audioOffset, audioOffset + duration], so every AE timing feature
 * (start time, trims, stretch, remap, nested precomps) is already applied and
 * the mapping is a pure offset.
 *
 * "source" mapping (fallback when rendering is unavailable): the source file
 * was decoded directly from `sourceIn` seconds; layer.startTime and stretch
 * are applied here. Only valid for un-remapped footage layers.
 */
export interface SourceMapping {
  layerStartTime: number;
  stretch: number; // percent, AE layer.stretch (negative = reversed)
  sourceIn: number; // source-file seconds where decoding started
}

export function audioToComp(t: number, mapping: "render" | "source" | "import", audioOffset: number, src?: SourceMapping): number {
  if (mapping === "source" && src) {
    const sourceTime = src.sourceIn + t;
    return src.layerStartTime + sourceTime * (src.stretch / 100);
  }
  return audioOffset + t;
}

/** Composition time -> timecode as AE displays it (includes displayStartTime). */
export function formatTimecode(compTime: number, compStartTime = 0): string {
  return formatClock(compTime + compStartTime, ".");
}

export function formatClock(t: number, msSep: "." | "," = "."): string {
  const neg = t < 0;
  let ms = Math.round(Math.abs(t) * 1000);
  const h = Math.floor(ms / 3600000);
  ms -= h * 3600000;
  const m = Math.floor(ms / 60000);
  ms -= m * 60000;
  const s = Math.floor(ms / 1000);
  ms -= s * 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${neg ? "-" : ""}${p(h)}:${p(m)}:${p(s)}${msSep}${p(ms, 3)}`;
}

/** Short form for compact UI: 1:02.35 */
export function formatShort(t: number): string {
  const neg = t < 0;
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  return `${neg ? "-" : ""}${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Parse "1:02.5", "01:02:03,250", "62.5" into seconds. Returns NaN if invalid. */
export function parseTime(text: string): number {
  const t = text.trim().replace(",", ".");
  if (!t) return NaN;
  if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const m = t.match(/^(-)?(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return NaN;
  const v = (m[2] ? parseInt(m[2], 10) * 3600 : 0) + parseInt(m[3], 10) * 60 + parseFloat(m[4]);
  return m[1] ? -v : v;
}
