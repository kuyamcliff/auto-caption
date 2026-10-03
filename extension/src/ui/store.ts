// Application state and actions. Components subscribe with useStore().

import { useEffect, useState } from "preact/hooks";
import { buildPlan } from "../core/aeplan";
import { APP_VERSION } from "../core/defaults";
import * as E from "../core/edit";
import { exportProject, parseCues, projectFromCues, type ExportFormat, EXPORT_FORMATS } from "../core/formats";
import { History } from "../core/history";
import { BUILT_IN_PRESETS, parsePresetFile, serializePresets, type StylePreset } from "../core/presets";
import { parseProject, projectFromResult, ProjectError, serializeProject } from "../core/project";
import { frameDurationFor } from "../core/timing";
import type { AnimationSettings, EngineResult, Project, SourceInfo, StyleSettings } from "../core/types";
import { BackendClient, BackendError, type JobSnapshot, type ModelsInfo } from "../host/client";
import type { CompInfo, Platform, SelectionLayer, SelfTestRow } from "../host/platform";
import { friendlyError, type FriendlyError } from "./errors";

// ------------------------------------------------------------------ types
export interface Config {
  version: 1;
  backendDir: string | null;
  defaultModel: string;
  defaultLanguage: string;
  wordsPerLine: number;
  uiScale: number;
  theme: "auto" | "dark" | "light";
  device: "auto" | "cpu" | "cuda";
  batchSize: number;
  vad: "pyannote" | "off";
  debug: boolean;
  onboarded: boolean;
  privacyAck: boolean;
  lastStyle?: StyleSettings;
  lastAnimation?: AnimationSettings;
}

export const DEFAULT_CONFIG: Config = {
  version: 1, backendDir: null, defaultModel: "base", defaultLanguage: "auto", wordsPerLine: 4, uiScale: 1,
  theme: "auto", device: "auto", batchSize: 0, vad: "pyannote", debug: false, onboarded: false, privacyAck: false,
};

export type BackendStatus = "unset" | "missing" | "offline" | "starting" | "ready" | "error" | "incompatible";

export interface Selection {
  status: "loading" | "none" | "no-comp" | "no-audio" | "ready" | "error";
  message?: string;
  comp?: CompInfo;
  layers: SelectionLayer[];
  aeVersion?: string;
}

export type JobPhase = "idle" | "extracting" | "running" | "done" | "failed" | "cancelled";

export interface JobState {
  phase: JobPhase;
  kind: "transcribe" | "align";
  snapshot?: JobSnapshot;
  error?: FriendlyError;
  startedAt?: number;
  note?: string;
}

export interface Toast {
  id: number;
  kind: "ok" | "warn" | "err" | "info";
  text: string;
  action?: { label: string; run: () => void };
}

export interface DialogAction {
  label: string;
  kind?: "primary" | "danger" | "ghost";
  run?: () => void;
}

export interface Dialog {
  title: string;
  body: string | string[];
  details?: string;
  actions: DialogAction[];
  input?: { label: string; value: string; placeholder?: string };
}

export interface RecentEntry {
  id: string;
  name: string;
  updatedAt: string;
  captions: number;
  language: string;
}

export interface AppState {
  ready: boolean;
  screen: "main" | "onboarding" | "settings" | "help";
  settingsTab: "general" | "backend" | "appearance" | "advanced" | "diagnostics" | "about";
  config: Config;
  backend: { status: BackendStatus; version?: string; error?: FriendlyError; models?: ModelsInfo; manifest?: Record<string, unknown> };
  verify: { running: boolean; rows: SelfTestRow[]; ok?: boolean; error?: FriendlyError; finishedAt?: number };
  selection: Selection;
  job: JobState;
  project: Project | null;
  canUndo: boolean;
  canRedo: boolean;
  selectedId: string | null;
  editingId: string | null;
  search: string;
  previewTime: number;
  playing: boolean;
  presets: StylePreset[];
  presetId: string | null;
  fonts: { ps: string; family: string; style: string }[];
  toasts: Toast[];
  dialog: Dialog | null;
  recent: RecentEntry[];
  busyCreate: boolean;
  diagnostics?: Record<string, unknown>;
}

// ----------------------------------------------------------------- store
type Listener = () => void;

export class Store {
  state: AppState;
  private listeners = new Set<Listener>();
  private history = new History<Project>();
  private client: BackendClient | null = null;
  private startPromise: Promise<BackendClient> | null = null;
  private saveTimer: number | null = null;
  private toastSeq = 0;
  private abort: AbortController | null = null;
  private cancelRequested = false;
  private logQueue: string[] = [];

  constructor(public platform: Platform) {
    this.state = {
      ready: false, screen: "main", settingsTab: "general", config: { ...DEFAULT_CONFIG },
      backend: { status: "unset" }, verify: { running: false, rows: [] },
      selection: { status: "loading", layers: [] }, job: { phase: "idle", kind: "transcribe" },
      project: null, canUndo: false, canRedo: false, selectedId: null, editingId: null, search: "",
      previewTime: 0, playing: false, presets: [...BUILT_IN_PRESETS], presetId: "clean", fonts: [],
      toasts: [], dialog: null, recent: [], busyCreate: false,
    };
  }

  // -------------------------------------------------------------- basics
  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  get f() {
    return this.platform.files;
  }
  private configPath() {
    return this.f.join(this.f.appDataDir(), "config.json");
  }
  private presetsPath() {
    return this.f.join(this.f.appDataDir(), "presets.json");
  }
  private projectsDir() {
    return this.f.join(this.f.appDataDir(), "projects");
  }
  logsDir() {
    return this.f.join(this.f.localDataDir(), "logs");
  }

  log(level: "info" | "warn" | "error", msg: string) {
    if (level === "info" && !this.state.config.debug && !/^(start|backend|job|create|export|import)/.test(msg)) return;
    this.logQueue.push(`${new Date().toISOString()} ${level.toUpperCase()} ${msg}`);
    if (this.logQueue.length === 1) setTimeout(() => this.flushLog(), 500);
  }
  private async flushLog() {
    const lines = this.logQueue.splice(0);
    if (!lines.length) return;
    try {
      const p = this.f.join(this.logsDir(), "extension.log");
      const prev = (await this.f.readText(p)) ?? "";
      let next = prev + lines.join("\n") + "\n";
      if (next.length > 1_000_000) {
        // rotate: keep one previous file, cap total size
        await this.f.writeText(this.f.join(this.logsDir(), "extension.1.log"), prev);
        next = lines.join("\n") + "\n";
      }
      await this.f.writeText(p, next);
    } catch {
      /* logging must never break the panel */
    }
  }

  toast(kind: Toast["kind"], text: string, action?: Toast["action"], ms = 4500) {
    const id = ++this.toastSeq;
    this.set({ toasts: [...this.state.toasts.slice(-2), { id, kind, text, action }] });
    setTimeout(() => this.dismissToast(id), ms);
  }
  dismissToast(id: number) {
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }
  showDialog(d: Dialog | null) {
    this.set({ dialog: d });
  }
  ask(title: string, body: string | string[], actions: DialogAction[], details?: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.set({
        dialog: {
          title, body, details,
          actions: actions.map((a) => ({ ...a, run: () => { this.set({ dialog: null }); resolve(a.label); } })),
        },
      });
    });
  }
  prompt(title: string, label: string, value: string, confirm: string): Promise<string | null> {
    return new Promise((resolve) => {
      const d: Dialog = {
        title, body: "", input: { label, value },
        actions: [
          { label: "Cancel", kind: "ghost", run: () => { this.set({ dialog: null }); resolve(null); } },
          { label: confirm, kind: "primary", run: () => { const v = this.state.dialog?.input?.value ?? ""; this.set({ dialog: null }); resolve(v.trim() || null); } },
        ],
      };
      this.set({ dialog: d });
    });
  }
  setDialogInput(value: string) {
    const d = this.state.dialog;
    if (d?.input) this.set({ dialog: { ...d, input: { ...d.input, value } } });
  }

  // -------------------------------------------------------------- init
  async init() {
    const raw = await this.f.readText(this.configPath());
    let config = { ...DEFAULT_CONFIG };
    if (raw) {
      try {
        config = { ...DEFAULT_CONFIG, ...JSON.parse(raw), version: 1 };
      } catch {
        this.toast("warn", "Settings file was unreadable and has been reset.");
      }
    }
    const presetsText = await this.f.readText(this.presetsPath());
    const mine = presetsText ? parsePresetFile(presetsText) : [];
    this.set({ config, presets: [...BUILT_IN_PRESETS, ...mine], ready: true, screen: config.backendDir && config.onboarded ? "main" : "onboarding" });
    this.applyAppearance();
    this.log("info", `start panel ${APP_VERSION} (${this.platform.kind})`);
    this.loadRecent();
    this.platform.host.cleanupTemp().then((r) => {
      if (r.ok && r.removed) this.log("info", `start removed ${r.removed} temp comp(s)`);
    });
    this.platform.backend.onExit((code) => {
      this.client = null;
      this.startPromise = null;
      if (this.state.backend.status === "ready") {
        this.set({ backend: { ...this.state.backend, status: "offline" } });
        this.log("warn", `backend exited (${code})`);
      }
    });
    this.platform.host.getFonts().then((r) => {
      if (r.ok && r.fonts.length) this.set({ fonts: r.fonts });
    });
    this.startSelectionPolling();
    if (config.backendDir && config.onboarded) {
      this.connect().catch(() => undefined);
    }
  }

  async saveConfig(patch: Partial<Config>) {
    const config = { ...this.state.config, ...patch };
    this.set({ config });
    this.applyAppearance();
    try {
      await this.f.writeText(this.configPath(), JSON.stringify(config, null, 1));
    } catch (e) {
      this.toast("err", "Could not save settings.");
      this.log("error", `config save failed: ${e}`);
    }
  }

  applyAppearance() {
    const c = this.state.config;
    const root = document.documentElement;
    root.style.setProperty("zoom", String(c.uiScale));
    root.dataset.theme = c.theme === "light" ? "light" : "dark";
    if (c.theme === "auto") {
      const t = this.platform.host.theme();
      if (t?.background) {
        root.style.setProperty("--bg", t.background);
        const lum = parseInt(t.background.slice(1, 3), 16);
        if (lum > 140) root.dataset.theme = "light";
      }
    } else {
      root.style.removeProperty("--bg");
    }
  }

  // ----------------------------------------------------------- backend
  /** Start (or reuse) the local backend and return a client. */
  connect(): Promise<BackendClient> {
    if (this.client && this.platform.backend.running()) return Promise.resolve(this.client);
    if (this.startPromise) return this.startPromise;
    const dir = this.state.config.backendDir;
    if (!dir) {
      this.set({ backend: { status: "unset" } });
      return Promise.reject(new BackendError("BACKEND_UNSET", "Choose the backend folder first."));
    }
    this.set({ backend: { ...this.state.backend, status: "starting", error: undefined } });
    this.startPromise = (async () => {
      if (!(await this.platform.backend.executable(dir))) {
        this.set({ backend: { status: "missing", error: friendlyError({ code: "BACKEND_MISSING", message: "" }) } });
        throw new BackendError("BACKEND_MISSING", "Backend not found.");
      }
      try {
        const info = await this.platform.backend.start(dir);
        const client = new BackendClient(info.port, info.token);
        const health = await client.health();
        const [models, manifest] = await Promise.all([client.models(), client.manifest()]);
        const compat = await client.verify(this.platform.extensionVersion).catch(() => null);
        if (compat && !compat.verify.compatibility.compatible) {
          this.set({ backend: { status: "incompatible", version: health.version, error: friendlyError({ code: "INCOMPATIBLE", message: `Backend ${health.version} needs extension ${compat.verify.compatibility.min}–${compat.verify.compatibility.max}.` }) } });
          await this.platform.backend.stop();
          throw new BackendError("INCOMPATIBLE", "Incompatible backend.");
        }
        this.client = client;
        this.startKeepalive();
        this.set({ backend: { status: "ready", version: health.version, models, manifest: manifest.manifest } });
        if (health.orphansCleaned) this.toast("info", "Cleaned up temporary files from an unfinished job.");
        this.log("info", `backend ready ${health.version} on port ${info.port}`);
        if (compat && !compat.verify.ok) {
          this.set({ backend: { ...this.state.backend, status: "error", error: friendlyError({ code: "BACKEND_DAMAGED", message: "", detail: [...compat.verify.missing, ...compat.verify.corrupt].join("\n") }) } });
        }
        return client;
      } catch (e) {
        const err = e as BackendError & { detail?: string };
        if (this.state.backend.status === "starting") {
          this.set({ backend: { status: "error", error: friendlyError({ code: err.code || "BACKEND_START", message: err.message, detail: err.detail }) } });
        }
        this.log("error", `backend start failed: ${err.code} ${err.message}`);
        throw e;
      } finally {
        this.startPromise = null;
      }
    })();
    return this.startPromise;
  }

  private keepalive: number | null = null;
  /** The backend exits after 10 idle minutes; ping while the panel is open. */
  private startKeepalive() {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = window.setInterval(() => {
      if (!this.client) return;
      this.client.health().catch(() => {
        if (this.state.job.phase !== "running" && this.state.backend.status === "ready") {
          this.client = null;
          this.set({ backend: { ...this.state.backend, status: "offline" } });
        }
      });
    }, 60000);
  }

  async stopBackend() {
    try {
      await this.client?.shutdown();
    } catch {
      /* already stopped */
    }
    await this.platform.backend.stop();
    this.client = null;
    this.set({ backend: { ...this.state.backend, status: "offline" } });
  }

  async chooseBackend(): Promise<boolean> {
    const dir = await this.f.chooseFolder("Choose the AutoCaption “backend” folder", this.state.config.backendDir ?? undefined);
    if (!dir) return false;
    // Accept the package root too: use its backend/ subfolder.
    let chosen = dir;
    if (!(await this.platform.backend.executable(dir))) {
      const sub = this.f.join(dir, "backend");
      if (await this.platform.backend.executable(sub)) chosen = sub;
    }
    if (!(await this.platform.backend.executable(chosen))) {
      this.toast("err", "That folder does not contain AutoCaptionBackend.exe. Choose the “backend” folder from the download.");
      return false;
    }
    await this.stopBackend();
    await this.saveConfig({ backendDir: chosen });
    this.set({ backend: { status: "offline" }, verify: { running: false, rows: [] } });
    return true;
  }

  async locateAndVerify() {
    if (await this.chooseBackend()) await this.runVerify(true);
  }

  async locateAndConnect() {
    if (await this.chooseBackend()) await this.connect().catch(() => undefined);
  }

  /** Real verification: runs the backend's own end-to-end self-test. */
  async runVerify(quick = true) {
    const dir = this.state.config.backendDir;
    if (!dir) return;
    this.set({ verify: { running: true, rows: [] } });
    const rows = new Map<string, SelfTestRow>();
    try {
      const res = await this.platform.backend.selfTest(dir, (row) => {
        rows.set(row.check, row);
        this.set({ verify: { running: true, rows: [...rows.values()] } });
      }, quick);
      this.set({ verify: { running: false, rows: [...rows.values()], ok: res.ok, finishedAt: Date.now() } });
      this.log(res.ok ? "info" : "warn", `backend verify ${res.ok ? "passed" : "failed: " + res.failed.join(",")}`);
      if (res.ok && this.state.backend.status !== "ready") this.connect().catch(() => undefined);
    } catch (e) {
      const err = e as Error & { code?: string; detail?: string };
      this.set({ verify: { running: false, rows: [...rows.values()], ok: false, error: friendlyError({ code: err.code || "SELFTEST_FAILED", message: err.message, detail: err.detail }) } });
    }
  }

  async loadDiagnostics() {
    try {
      const c = await this.connect();
      const d = await c.diagnostics();
      const info = await this.platform.host.info();
      this.set({ diagnostics: { ...d.diagnostics, extensionVersion: APP_VERSION, afterEffects: info.ok ? `${info.aeVersion} ${info.build}` : "unknown" } });
    } catch {
      const info = await this.platform.host.info();
      this.set({ diagnostics: { extensionVersion: APP_VERSION, afterEffects: info.ok ? info.aeVersion : "unknown", backend: "not running" } });
    }
  }

  // --------------------------------------------------------- selection
  startSelectionPolling() {
    const poll = async () => {
      if (document.visibilityState !== "hidden" && this.state.job.phase !== "extracting" && !this.state.busyCreate) {
        await this.refreshSelection();
      }
      window.setTimeout(poll, 800);
    };
    poll();
  }

  async refreshSelection() {
    const r = await this.platform.host.getSelection();
    let sel: Selection;
    if (!r.ok) {
      sel = { status: r.code === "NO_COMP" || r.code === "NO_PROJECT" ? "no-comp" : "error", message: r.message, layers: [] };
    } else if (!r.layers.length) {
      sel = { status: "none", comp: r.comp, layers: [], aeVersion: r.aeVersion };
    } else {
      const withAudio = r.layers.filter((l) => l.hasAudio);
      sel = { status: withAudio.length ? "ready" : "no-audio", comp: r.comp, layers: r.layers, aeVersion: r.aeVersion };
    }
    const prev = this.state.selection;
    if (JSON.stringify(prev) !== JSON.stringify(sel)) this.set({ selection: sel });
  }

  // ---------------------------------------------------------- transcribe
  private async ensureDisk(seconds: number): Promise<boolean> {
    const need = Math.max(200e6, seconds * 48000 * 2 * 2 * 1.5);
    const free = await this.f.freeBytes(this.f.tempDir()).catch(() => null);
    if (free !== null && free < need) {
      this.set({ job: { phase: "failed", kind: "transcribe", error: friendlyError({ code: "DISK_FULL", message: "" }) } });
      return false;
    }
    return true;
  }

  async transcribe(opts: { model: string; language: string }) {
    const sel = this.state.selection;
    if (sel.status !== "ready" || !sel.comp) return;
    if (this.state.job.phase === "extracting" || this.state.job.phase === "running") return;
    const layers = sel.layers.filter((l) => l.hasAudio);
    const comp = sel.comp;
    this.cancelRequested = false;
    this.set({ job: { phase: "extracting", kind: "transcribe", startedAt: Date.now() }, playing: false });
    this.log("info", `job start: ${layers.length} layer(s), model ${opts.model}, lang ${opts.language}`);
    let client: BackendClient;
    try {
      client = await this.connect();
    } catch (e) {
      const err = e as BackendError & { detail?: string };
      this.set({ job: { phase: "failed", kind: "transcribe", error: friendlyError({ code: err.code || "BACKEND_START", message: err.message, detail: err.detail }) } });
      return;
    }
    const span = Math.max(...layers.map((l) => Math.max(l.inPoint, l.outPoint))) - Math.min(...layers.map((l) => Math.min(l.inPoint, l.outPoint)));
    if (!(await this.ensureDisk(span))) return;
    const renderDir = this.f.join(this.f.tempDir(), "renders", `r${Date.now().toString(36)}`);
    await this.f.mkdir(renderDir);
    const rendered = await this.platform.host.renderAudio(comp.id, layers.map((l) => l.index), renderDir);
    if (this.cancelRequested) {
      await this.f.remove(renderDir);
      this.set({ job: { phase: "cancelled", kind: "transcribe" } });
      return;
    }
    let source: SourceInfo;
    let body: Parameters<BackendClient["transcribe"]>[0];
    const options = { model: opts.model, language: opts.language, device: this.state.config.device, batchSize: this.state.config.batchSize, vad: this.state.config.vad };
    const layerType = layers.length > 1 ? "unknown" : layers[0].type;
    const baseSource = {
      composition: comp.name, compId: comp.id, layers: layers.map((l) => ({ name: l.name, index: l.index, type: l.type })),
      layerType, fps: comp.fps, frameDuration: comp.frameDuration || frameDurationFor(comp.fps), compStartTime: comp.displayStartTime,
      compDuration: comp.duration, width: comp.width, height: comp.height,
    };
    let note: string | undefined;
    if (rendered.ok) {
      source = { ...baseSource, audioOffset: rendered.audioOffset, audioDuration: rendered.duration, mapping: "render" };
      body = { audioPath: rendered.path, options };
    } else {
      await this.f.remove(renderDir);
      // Fallback: decode the footage file directly, mapping time from layer settings.
      const L = layers[0];
      const simple = layers.length === 1 && L.sourcePath && !L.footageMissing && !L.timeRemap && L.stretch > 0 && L.type !== "precomp";
      if (!simple) {
        this.set({ job: { phase: "failed", kind: "transcribe", error: friendlyError({ code: rendered.code, message: rendered.message, detail: rendered.detail }) } });
        this.log("error", `render failed ${rendered.code}: ${rendered.detail ?? ""}`);
        return;
      }
      const k = L.stretch / 100;
      const inP = Math.max(0, L.inPoint);
      const outP = Math.min(comp.duration, L.outPoint);
      const sourceIn = (inP - L.startTime) / k;
      const dur = (outP - inP) / k;
      // stretch != 100% cannot be represented as a pure offset; refuse rather than mistime
      if (Math.abs(k - 1) > 1e-6) {
        this.set({ job: { phase: "failed", kind: "transcribe", error: friendlyError({ code: rendered.code, message: rendered.message, detail: rendered.detail }) } });
        return;
      }
      source = { ...baseSource, audioOffset: inP, audioDuration: dur, mapping: "render" };
      body = { audioPath: L.sourcePath!, source: { start: sourceIn, duration: dur }, options };
      note = "After Effects could not render the audio, so the source file was used. Timing follows the layer's position.";
    }
    try {
      const { jobId } = await client.transcribe(body);
      this.set({ job: { phase: "running", kind: "transcribe", startedAt: this.state.job.startedAt, note } });
      this.abort = new AbortController();
      const final = await client.follow(jobId, (snap) => this.set({ job: { ...this.state.job, snapshot: snap } }), this.abort.signal);
      if (final.state === "completed" && final.result) {
        this.adoptResult(final.result, source);
        this.set({ job: { phase: "done", kind: "transcribe", snapshot: final, note } });
        this.log("info", `job done: ${final.result.words.length} words, ${final.result.timings?.totalSec ?? "?"}s`);
      } else if (final.state === "cancelled") {
        this.set({ job: { phase: "cancelled", kind: "transcribe" } });
        this.log("info", "job cancelled");
      } else {
        const er = final.error || { code: "ENGINE_ERROR", message: "Transcription failed." };
        this.set({ job: { phase: "failed", kind: "transcribe", error: friendlyError(er) } });
        this.log("error", `job failed ${er.code}: ${er.detail ?? er.message}`);
      }
    } catch (e) {
      const err = e as BackendError;
      if (err.code === "BUSY") {
        this.set({ job: { phase: "failed", kind: "transcribe", error: friendlyError({ code: "BUSY", message: err.message }) } });
      } else {
        this.set({ job: { phase: "failed", kind: "transcribe", error: friendlyError({ code: err.code || "ENGINE_ERROR", message: err.message, detail: (err as BackendError).detail }) } });
      }
      await this.f.remove(renderDir);
    }
  }

  async cancelJob() {
    this.cancelRequested = true;
    const snap = this.state.job.snapshot;
    if (snap && this.client) {
      try {
        await this.client.cancel(snap.jobId);
      } catch {
        /* job already finished */
      }
    }
    if (this.state.job.phase === "extracting") this.set({ job: { ...this.state.job, note: "Cancelling after After Effects finishes the audio…" } });
  }

  dismissJob() {
    this.set({ job: { phase: "idle", kind: "transcribe" } });
  }

  private adoptResult(result: EngineResult, source: SourceInfo) {
    const c = this.state.config;
    const preset = this.state.presets.find((p) => p.id === this.state.presetId);
    const project = projectFromResult(result, source, {
      segment: { maxWords: c.wordsPerLine },
      style: c.lastStyle ?? preset?.style,
      animation: c.lastAnimation ?? preset?.animation,
    });
    this.history.clear();
    this.set({ project, canUndo: false, canRedo: false, selectedId: project.captions[0]?.id ?? null, previewTime: project.words[0]?.start ?? 0, editingId: null, search: "" });
    this.scheduleSave();
    for (const w of result.warnings) this.toast("warn", w.message, undefined, 8000);
  }

  // ------------------------------------------------------------ editing
  apply(label: string, fn: (p: Project) => Project) {
    const p = this.state.project;
    if (!p) return;
    const next = fn(p);
    if (next === p) return;
    this.history.push(p, label);
    this.set({ project: next, canUndo: this.history.canUndo, canRedo: this.history.canRedo });
    this.scheduleSave();
  }
  undo() {
    const p = this.state.project;
    if (!p) return;
    const e = this.history.undo(p);
    if (e) {
      this.set({ project: e.state, canUndo: this.history.canUndo, canRedo: this.history.canRedo, editingId: null });
      this.toast("info", `Undid: ${e.label}`, undefined, 1800);
      this.scheduleSave();
    }
  }
  redo() {
    const p = this.state.project;
    if (!p) return;
    const e = this.history.redo(p);
    if (e) {
      this.set({ project: e.state, canUndo: this.history.canUndo, canRedo: this.history.canRedo, editingId: null });
      this.toast("info", `Redid: ${e.label}`, undefined, 1800);
      this.scheduleSave();
    }
  }
  setWordsPerLine(n: number) {
    this.apply(`Words per line: ${n}`, (p) => E.setGrouping(p, { maxWords: n }));
    this.saveConfig({ wordsPerLine: n });
  }
  setLines(maxLines: 1 | 2) {
    this.apply(maxLines === 1 ? "Single line" : "Two lines", (p) => E.setGrouping(p, { maxLines }));
  }
  setStyle(patch: Partial<StyleSettings>, label = "Style change") {
    this.apply(label, (p) => ({ ...p, style: { ...p.style, ...patch } }));
    this.set({ presetId: null });
    this.rememberLook();
  }
  setAnimation(patch: Partial<AnimationSettings>, label = "Animation change") {
    this.apply(label, (p) => ({ ...p, animation: { ...p.animation, ...patch } }));
    this.rememberLook();
  }
  private lookTimer: number | null = null;
  private rememberLook() {
    if (this.lookTimer) clearTimeout(this.lookTimer);
    this.lookTimer = window.setTimeout(() => {
      const p = this.state.project;
      if (p) this.saveConfig({ lastStyle: p.style, lastAnimation: p.animation });
    }, 800);
  }
  applyPreset(id: string) {
    const preset = this.state.presets.find((x) => x.id === id);
    if (!preset) return;
    this.apply(`Preset: ${preset.name}`, (p) => ({ ...p, style: { ...preset.style }, animation: { ...preset.animation } }));
    this.set({ presetId: id });
    this.rememberLook();
  }
  async savePreset() {
    const p = this.state.project;
    if (!p) return;
    const name = await this.prompt("Save caption style", "Preset name", "My Caption", "Save preset");
    if (!name) return;
    const preset: StylePreset = { id: `u${Date.now().toString(36)}`, name, style: { ...p.style }, animation: { ...p.animation } };
    const presets = [...this.state.presets.filter((x) => x.builtIn || x.name !== name), preset];
    this.set({ presets, presetId: preset.id });
    try {
      await this.f.writeText(this.presetsPath(), serializePresets(presets));
      this.toast("ok", `Saved preset “${name}”`);
    } catch {
      this.toast("err", "Could not save the preset.");
    }
  }
  async deletePreset(id: string) {
    const presets = this.state.presets.filter((x) => x.id !== id || x.builtIn);
    this.set({ presets, presetId: this.state.presetId === id ? null : this.state.presetId });
    await this.f.writeText(this.presetsPath(), serializePresets(presets)).catch(() => undefined);
  }

  // ------------------------------------------------------- persistence
  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveProject(), 900);
  }
  private async saveProject() {
    const p = this.state.project;
    if (!p) return;
    try {
      await this.f.writeText(this.f.join(this.projectsDir(), `${p.project.id}.json`), serializeProject(p));
      await this.loadRecent();
    } catch (e) {
      this.log("error", `project save failed: ${e}`);
    }
  }
  async loadRecent() {
    const dir = this.projectsDir();
    const names = (await this.f.list(dir)).filter((n) => n.endsWith(".json"));
    const out: RecentEntry[] = [];
    for (const n of names) {
      const text = await this.f.readText(this.f.join(dir, n));
      if (!text) continue;
      try {
        const raw = JSON.parse(text);
        out.push({ id: raw.project.id, name: raw.project.name, updatedAt: raw.project.updatedAt, captions: raw.captions.length, language: raw.transcription?.language ?? "" });
      } catch {
        /* skip corrupt entry */
      }
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    // keep the 20 most recent sessions
    for (const old of out.slice(20)) await this.f.remove(this.f.join(dir, `${old.id}.json`));
    this.set({ recent: out.slice(0, 20) });
  }
  async openRecent(id: string) {
    const text = await this.f.readText(this.f.join(this.projectsDir(), `${id}.json`));
    if (!text) return this.toast("err", "That transcription could not be found.");
    try {
      this.loadProject(parseProject(text));
    } catch (e) {
      this.toast("err", e instanceof ProjectError ? e.message : "That transcription is damaged.");
    }
  }
  loadProject(p: Project) {
    this.history.clear();
    this.set({ project: p, canUndo: false, canRedo: false, selectedId: p.captions[0]?.id ?? null, previewTime: p.words[0]?.start ?? 0, job: { phase: "idle", kind: "transcribe" }, editingId: null });
  }
  closeProject() {
    this.set({ project: null, selectedId: null, playing: false });
  }
  async removeRecent(id: string) {
    await this.f.remove(this.f.join(this.projectsDir(), `${id}.json`));
    await this.loadRecent();
  }

  // ------------------------------------------------------- import/export
  async exportAs(format: ExportFormat) {
    const p = this.state.project;
    if (!p) return;
    const fmt = EXPORT_FORMATS.find((f) => f.id === format)!;
    const safe = (p.source.composition || "captions").replace(/[\\/:*?"<>|]+/g, " ").trim() || "captions";
    const path = await this.f.chooseSaveFile(`Export ${fmt.label}`, `${safe}.${fmt.ext}`, fmt.ext);
    if (!path) return;
    try {
      const text = exportProject(p, format);
      await this.f.writeText(path, format === "srt" || format === "txt" ? text.replace(/\n/g, "\r\n") : text);
      this.toast("ok", `Exported ${fmt.ext.toUpperCase()}`, { label: "Show", run: () => this.f.reveal(this.f.dirname(path)) });
      this.log("info", `export ${format}`);
    } catch (e) {
      this.toast("err", "Export failed. Check that the folder is writable.");
      this.log("error", `export failed: ${e}`);
    }
  }

  async importFile() {
    const path = await this.f.chooseOpenFile("Import captions", ["json", "srt", "vtt"]);
    if (!path) return;
    const text = await this.f.readText(path);
    if (text === null) return this.toast("err", "Could not read that file.");
    try {
      let p: Project;
      if (/\.json$/i.test(path)) p = parseProject(text);
      else {
        const cues = parseCues(text);
        if (!cues.length) throw new ProjectError("No subtitles were found in that file.");
        const base = this.state.project ?? undefined;
        const name = path.split(/[\\/]/).pop() || "Imported";
        p = projectFromCues(cues, name, base);
        const sel = this.state.selection;
        if (!base && sel.comp) {
          p = { ...p, source: { ...p.source, composition: sel.comp.name, compId: sel.comp.id, fps: sel.comp.fps, frameDuration: sel.comp.frameDuration, compStartTime: sel.comp.displayStartTime, compDuration: sel.comp.duration, width: sel.comp.width, height: sel.comp.height } };
        }
      }
      this.loadProject(p);
      this.scheduleSave();
      this.toast("ok", `Imported ${E.views(p).length} captions`);
      this.log("info", "import ok");
    } catch (e) {
      this.toast("err", e instanceof ProjectError ? e.message : "That file could not be imported.");
    }
  }

  /** Replace estimated word timing (e.g. imported SRT) with forced alignment against the selected layer. */
  async alignToAudio() {
    const p = this.state.project;
    const sel = this.state.selection;
    if (!p || sel.status !== "ready" || !sel.comp) {
      this.toast("warn", "Select the audio layer these captions belong to.");
      return;
    }
    const lang = p.transcription.language || "en";
    const layers = sel.layers.filter((l) => l.hasAudio);
    this.cancelRequested = false;
    this.set({ job: { phase: "extracting", kind: "align", startedAt: Date.now() } });
    try {
      const client = await this.connect();
      const renderDir = this.f.join(this.f.tempDir(), "renders", `r${Date.now().toString(36)}`);
      await this.f.mkdir(renderDir);
      const r = await this.platform.host.renderAudio(sel.comp.id, layers.map((l) => l.index), renderDir);
      if (!r.ok) {
        await this.f.remove(renderDir);
        this.set({ job: { phase: "failed", kind: "align", error: friendlyError({ code: r.code, message: r.message, detail: r.detail }) } });
        return;
      }
      const segments = E.views(p).map((v) => ({ start: Math.max(0, v.start - r.audioOffset), end: Math.max(0.05, v.end - r.audioOffset), text: v.text }))
        .filter((s) => s.end > 0 && s.start < r.duration);
      const { jobId } = await client.align({ audioPath: r.path, language: lang, segments });
      this.set({ job: { phase: "running", kind: "align", startedAt: this.state.job.startedAt } });
      const final = await client.follow(jobId, (snap) => this.set({ job: { ...this.state.job, snapshot: snap } }));
      if (final.state !== "completed" || !final.result) {
        this.set({ job: { phase: final.state === "cancelled" ? "cancelled" : "failed", kind: "align", error: final.error ? friendlyError(final.error) : undefined } });
        return;
      }
      const comp = sel.comp;
      const source: SourceInfo = {
        ...p.source, composition: comp.name, compId: comp.id, layers: layers.map((l) => ({ name: l.name, index: l.index, type: l.type })),
        layerType: layers.length > 1 ? "unknown" : layers[0].type, fps: comp.fps, frameDuration: comp.frameDuration, compStartTime: comp.displayStartTime,
        compDuration: comp.duration, width: comp.width, height: comp.height, audioOffset: r.audioOffset, audioDuration: r.duration, mapping: "render",
      };
      const aligned = projectFromResult({ ...final.result, model: p.transcription.model }, source, { segment: p.segment, style: p.style, animation: p.animation, name: p.project.name });
      this.history.push(p, "Align to audio");
      this.set({ project: aligned, canUndo: true, canRedo: false, job: { phase: "done", kind: "align", snapshot: final } });
      this.scheduleSave();
      this.toast("ok", "Word timing aligned to the audio.");
    } catch (e) {
      const err = e as BackendError;
      this.set({ job: { phase: "failed", kind: "align", error: friendlyError({ code: err.code || "ENGINE_ERROR", message: err.message }) } });
    }
  }

  // ------------------------------------------------------- AE creation
  async createLayers() {
    const p = this.state.project;
    if (!p || this.state.busyCreate) return;
    const problems = E.validateForAE(p);
    if (problems.length) {
      await this.ask("Captions need attention", problems, [{ label: "OK", kind: "primary" }]);
      return;
    }
    if (!p.source.compId) {
      await this.ask("No composition", "Open the composition for these captions and transcribe or align it first.", [{ label: "OK", kind: "primary" }]);
      return;
    }
    let project = p;
    const st = await this.platform.host.layerState(p.source.compId, p.source.layers.map((l) => l.index));
    if (!st.ok) {
      await this.ask("Composition not found", st.message, [{ label: "OK", kind: "primary" }]);
      return;
    }
    const active = this.state.selection.comp;
    if (active && active.id !== p.source.compId) {
      const choice = await this.ask("The composition changed since transcription",
        [`The captions belong to “${p.source.composition}”, but “${active.name}” is active.`, `They will be created in “${st.comp.name}” so they stay in sync with the audio.`],
        [{ label: "Cancel", kind: "ghost" }, { label: `Create in “${st.comp.name}”`, kind: "primary" }]);
      if (choice === "Cancel" || choice === null) return;
    }
    // Did the source layer move? Offer to follow it.
    const first = st.layers[0];
    const orig = p.source.layers[0];
    if (p.source.mapping === "render" && first && orig && first.name === orig.name) {
      const delta = Math.min(...st.layers.filter(Boolean).map((l) => l!.inPoint)) - p.source.audioOffset;
      if (Math.abs(delta) > p.source.frameDuration / 2) {
        const choice = await this.ask("The source layer moved",
          `“${orig.name}” starts ${Math.abs(delta).toFixed(2)} s ${delta > 0 ? "later" : "earlier"} than when it was transcribed.`,
          [{ label: "Cancel", kind: "ghost" }, { label: "Keep original timing", kind: "ghost" }, { label: "Move captions with it", kind: "primary" }]);
        if (choice === "Cancel" || choice === null) return;
        if (choice === "Move captions with it") {
          project = shiftProject(p, delta);
          this.history.push(p, "Follow moved layer");
          this.set({ project, canUndo: true });
        }
      }
    }
    let mode: "replace" | "add" = "add";
    const existing = await this.platform.host.existingCaptions(p.source.compId);
    if (existing.ok && existing.count > 0) {
      const choice = await this.ask("Existing AutoCaption layers detected",
        `This composition already has ${existing.count} AutoCaption layer${existing.count === 1 ? "" : "s"}. Other layers are never touched.`,
        [{ label: "Cancel", kind: "ghost" }, { label: "Add another set", kind: "ghost" }, { label: "Replace", kind: "primary" }]);
      if (choice === "Cancel" || choice === null) return;
      mode = choice === "Replace" ? "replace" : "add";
    }
    this.set({ busyCreate: true, playing: false });
    const fd = st.comp.frameDuration || frameDurationFor(st.comp.fps);
    const plan = buildPlan({ ...project, source: { ...project.source, width: st.comp.width, height: st.comp.height } }, fd);
    const t0 = performance.now();
    const res = await this.platform.host.createLayers(plan, { compId: p.source.compId, mode });
    this.set({ busyCreate: false });
    if (res.ok) {
      this.toast("ok", `Created ${res.created} caption layer${res.created === 1 ? "" : "s"} in “${st.comp.name}”`);
      this.log("info", `create ${res.created} layers in ${Math.round(performance.now() - t0)} ms (${mode})`);
    } else {
      await this.ask("Could not create caption layers", [res.message, "Use Edit › Undo in After Effects to remove any partially created layers."], [{ label: "OK", kind: "primary" }], res.detail);
      this.log("error", `create failed ${res.code}: ${res.message}`);
    }
  }

  jumpTo(t: number) {
    this.set({ previewTime: t });
    const id = this.state.project?.source.compId;
    if (id) this.platform.host.jumpTo(id, t);
  }
}

function shiftProject(p: Project, delta: number): Project {
  const sh = (w: { start: number; end: number }) => ({ start: Math.round((w.start + delta) * 1000) / 1000, end: Math.round((w.end + delta) * 1000) / 1000 });
  return {
    ...p,
    source: { ...p.source, audioOffset: p.source.audioOffset + delta },
    words: p.words.map((w) => ({ ...w, ...sh(w) })),
    sourceWords: p.sourceWords.map((w) => ({ ...w, ...sh(w) })),
    captions: p.captions.map((c) => ({ ...c, ...(c.start !== undefined ? { start: c.start + delta } : {}), ...(c.end !== undefined ? { end: c.end + delta } : {}) })),
  };
}

// ------------------------------------------------------------- hooks
let storeRef: Store | null = null;
export function setStore(s: Store) {
  storeRef = s;
}
export function getStore(): Store {
  if (!storeRef) throw new Error("store not initialised");
  return storeRef;
}

/** Subscribe to a slice of state; re-renders only when the slice changes. */
export function useStore<T>(select: (s: AppState) => T): T {
  const store = getStore();
  const [value, setValue] = useState(() => select(store.state));
  useEffect(() => {
    let last = select(store.state);
    setValue(() => last);
    return store.subscribe(() => {
      const next = select(store.state);
      if (next !== last) {
        last = next;
        setValue(() => next);
      }
    });
  }, []);
  return value;
}

