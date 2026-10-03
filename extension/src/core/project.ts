// Project creation, (de)serialisation and validation (schemaVersion 1).

import { APP_VERSION, DEFAULT_ANIMATION, DEFAULT_SEGMENT, DEFAULT_STYLE } from "./defaults";
import { regroup } from "./segment";
import { audioToComp } from "./timing";
import type { EngineResult, Project, SourceInfo, Word } from "./types";

const TIMING = new Set(["aligned", "inferred", "fallback", "manual"]);

export function newProjectId(): string {
  const r = Math.random().toString(36).slice(2, 8);
  return `p${Date.now().toString(36)}${r}`;
}

/** Build a project from an engine result. Audio-relative word times become composition times here. */
export function projectFromResult(
  result: EngineResult,
  source: SourceInfo,
  opts: { name?: string; segment?: Partial<Project["segment"]>; style?: Project["style"]; animation?: Project["animation"] } = {},
): Project {
  const toComp = (t: number) => round3(audioToComp(t, source.mapping, source.audioOffset));
  const words: Word[] = result.words.map((w) => ({
    id: w.id, text: w.text, start: toComp(w.start), end: toComp(w.end), timingSource: w.timingSource,
    ...(w.score !== undefined ? { score: w.score } : {}),
  }));
  const segment = { ...DEFAULT_SEGMENT, ...opts.segment };
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    app: { name: "AutoCaption AE", version: APP_VERSION },
    project: { id: newProjectId(), name: opts.name || `${source.composition} – ${source.layers.map((l) => l.name).join(", ")}`, createdAt: now, updatedAt: now },
    source,
    transcription: {
      language: result.language, languageProbability: result.languageProbability ?? null, noSpaces: !!result.noSpaces,
      model: result.model || "base", aligned: result.aligned, alignmentModel: result.alignmentModel ?? null,
      device: result.device, warnings: result.warnings || [],
    },
    sourceWords: words.map((w) => ({ ...w })),
    words,
    captions: regroup(words, [], segment, !!result.noSpaces),
    segment,
    style: opts.style ? { ...opts.style } : { ...DEFAULT_STYLE },
    animation: opts.animation ? { ...opts.animation } : { ...DEFAULT_ANIMATION },
  };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export class ProjectError extends Error {}

function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function checkWords(list: unknown, field: string): Word[] {
  if (!Array.isArray(list)) throw new ProjectError(`${field} must be a list.`);
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const w = raw as Record<string, unknown>;
    if (typeof w?.id !== "string" || typeof w.text !== "string") throw new ProjectError(`${field}[${i}] needs id and text.`);
    if (!isNum(w.start) || !isNum(w.end) || (w.end as number) < (w.start as number)) throw new ProjectError(`${field}[${i}] has invalid timing.`);
    if (seen.has(w.id)) throw new ProjectError(`${field} has a duplicate id ${w.id}.`);
    seen.add(w.id);
    const ts = TIMING.has(w.timingSource as string) ? (w.timingSource as Word["timingSource"]) : "inferred";
    const out: Word = { id: w.id, text: w.text, start: w.start as number, end: w.end as number, timingSource: ts };
    if (isNum(w.score)) out.score = w.score;
    if (w.edited === true) out.edited = true;
    return out;
  });
}

/** Parse and validate an AutoCaption project JSON. Unknown style keys fall back to defaults. */
export function parseProject(text: string): Project {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectError("This file is not valid JSON.");
  }
  if (!raw || typeof raw !== "object") throw new ProjectError("This file is not an AutoCaption project.");
  if (raw.schemaVersion !== 1) throw new ProjectError(`Unsupported project version (${String(raw.schemaVersion)}).`);
  const words = checkWords(raw.words, "words");
  const sourceWords = raw.sourceWords ? checkWords(raw.sourceWords, "sourceWords") : words.map((w) => ({ ...w }));
  const ids = new Set(words.map((w) => w.id));
  if (!Array.isArray(raw.captions)) throw new ProjectError("captions must be a list.");
  const captions = (raw.captions as Record<string, unknown>[]).map((c, i) => {
    if (typeof c?.id !== "string" || !Array.isArray(c.wordIds)) throw new ProjectError(`captions[${i}] is invalid.`);
    const wordIds = (c.wordIds as unknown[]).filter((x): x is string => typeof x === "string" && ids.has(x));
    return {
      id: c.id, wordIds, ...(c.locked ? { locked: true } : {}),
      ...(isNum(c.start) ? { start: c.start } : {}), ...(isNum(c.end) ? { end: c.end } : {}),
    };
  }).filter((c) => c.wordIds.length);
  const src = (raw.source || {}) as Partial<SourceInfo>;
  const fps = isNum(src.fps) && src.fps > 0 ? src.fps : 30;
  const source: SourceInfo = {
    composition: String(src.composition ?? "Composition"), compId: isNum(src.compId) ? src.compId : undefined,
    layers: Array.isArray(src.layers) ? src.layers : [], layerType: src.layerType ?? "unknown",
    fps, frameDuration: isNum(src.frameDuration) ? src.frameDuration : 1 / fps,
    compStartTime: isNum(src.compStartTime) ? src.compStartTime : 0,
    compDuration: isNum(src.compDuration) ? src.compDuration : Math.max(0, ...words.map((w) => w.end)) + 1,
    width: isNum(src.width) ? src.width : 1920, height: isNum(src.height) ? src.height : 1080,
    audioOffset: isNum(src.audioOffset) ? src.audioOffset : 0,
    audioDuration: isNum(src.audioDuration) ? src.audioDuration : 0,
    mapping: src.mapping === "source" || src.mapping === "import" ? src.mapping : "render",
  };
  const tr = (raw.transcription || {}) as Partial<Project["transcription"]>;
  const proj = (raw.project || {}) as Partial<Project["project"]>;
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    app: { name: "AutoCaption AE", version: APP_VERSION },
    project: { id: typeof proj.id === "string" ? proj.id : newProjectId(), name: String(proj.name ?? "Imported captions"), createdAt: String(proj.createdAt ?? now), updatedAt: now },
    source,
    transcription: {
      language: String(tr.language ?? "en"), languageProbability: tr.languageProbability ?? null, noSpaces: !!tr.noSpaces,
      model: String(tr.model ?? "base"), aligned: !!tr.aligned, alignmentModel: tr.alignmentModel ?? null,
      device: tr.device, warnings: Array.isArray(tr.warnings) ? tr.warnings : [],
    },
    sourceWords,
    words,
    captions: captions.length ? captions : regroup(words, [], { ...DEFAULT_SEGMENT, ...(raw.segment as object) }, !!tr.noSpaces),
    segment: { ...DEFAULT_SEGMENT, ...(raw.segment as object) },
    style: { ...DEFAULT_STYLE, ...(raw.style as object) },
    animation: { ...DEFAULT_ANIMATION, ...(raw.animation as object) },
  };
}

export function serializeProject(p: Project): string {
  return JSON.stringify(p, null, 1);
}
