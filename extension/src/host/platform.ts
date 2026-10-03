// Platform abstraction. The UI and core only talk to these interfaces, so the
// CEP implementation can be swapped for UXP later without touching them.

export interface SelectionLayer {
  name: string;
  index: number;
  id: number | null;
  type: "audio" | "video" | "precomp" | "unknown";
  hasAudio: boolean;
  audioEnabled: boolean;
  enabled: boolean;
  inPoint: number;
  outPoint: number;
  startTime: number;
  stretch: number;
  timeRemap: boolean;
  sourcePath: string | null;
  sourceDuration: number | null;
  footageMissing?: boolean;
}

export interface CompInfo {
  name: string;
  id: number;
  fps: number;
  frameDuration: number;
  duration: number;
  displayStartTime: number;
  width: number;
  height: number;
  time: number;
}

export type HostResult<T> = ({ ok: true } & T) | { ok: false; code: string; message: string; detail?: string };

export interface HostBridge {
  getSelection(): Promise<HostResult<{ comp: CompInfo; layers: SelectionLayer[]; aeVersion: string }>>;
  layerState(compId: number, indices: number[]): Promise<HostResult<{ comp: CompInfo; layers: (SelectionLayer | null)[] }>>;
  renderAudio(compId: number, layerIndices: number[], outDir: string): Promise<HostResult<{ path: string; audioOffset: number; duration: number }>>;
  cleanupTemp(): Promise<HostResult<{ removed: number }>>;
  existingCaptions(compId: number): Promise<HostResult<{ count: number; sets: number }>>;
  createLayers(plan: unknown, opts: { compId: number; mode: "replace" | "add" }): Promise<HostResult<{ created: number; setName: string }>>;
  jumpTo(compId: number, t: number): Promise<HostResult<object>>;
  getFonts(): Promise<HostResult<{ fonts: { ps: string; family: string; style: string }[] }>>;
  info(): Promise<HostResult<{ aeVersion: string; build: string }>>;
  /** host theme colours, if the host exposes them */
  theme(): { background?: string } | null;
}

export interface Files {
  sep: string;
  join(...parts: string[]): string;
  dirname(p: string): string;
  readText(p: string): Promise<string | null>;
  writeText(p: string, data: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  isDir(p: string): Promise<boolean>;
  mkdir(p: string): Promise<void>;
  remove(p: string): Promise<void>;
  list(p: string): Promise<string[]>;
  size(p: string): Promise<number>;
  freeBytes(p: string): Promise<number | null>;
  appDataDir(): string;
  localDataDir(): string;
  tempDir(): string;
  reveal(p: string): Promise<void>;
  chooseFolder(title: string, initial?: string): Promise<string | null>;
  chooseOpenFile(title: string, exts: string[]): Promise<string | null>;
  chooseSaveFile(title: string, defaultName: string, ext: string): Promise<string | null>;
}

export interface SelfTestRow {
  check: string;
  label: string;
  status: "running" | "pass" | "fail" | "warn" | "info";
  detail?: string;
  trace?: string;
  required?: boolean;
}

export interface BackendProcess {
  /** Absolute path of the backend executable inside a backend folder (null if not found). */
  executable(backendDir: string): Promise<string | null>;
  start(backendDir: string): Promise<{ port: number; token: string; pid: number; version: string }>;
  running(): boolean;
  stop(): Promise<void>;
  selfTest(backendDir: string, onRow: (row: SelfTestRow) => void, quick: boolean): Promise<{ ok: boolean; failed: string[] }>;
  onExit(cb: (code: number | null) => void): void;
}

export interface Platform {
  kind: "cep" | "browser";
  host: HostBridge;
  files: Files;
  backend: BackendProcess;
  extensionVersion: string;
}
