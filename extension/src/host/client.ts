// HTTP client for the local backend (127.0.0.1, per-session token).

import type { EngineResult } from "../core/types";

export interface JobSnapshot {
  jobId: string;
  kind: string;
  state: "queued" | "preparing" | "transcribing" | "aligning" | "building" | "completed" | "cancelled" | "failed" | "cancelling";
  stage: string;
  message: string;
  progress: number | null;
  error: { code: string; message: string; detail?: string; hint?: string[] } | null;
  elapsedSec: number;
  result?: EngineResult;
}

export class BackendError extends Error {
  constructor(public code: string, message: string, public detail = "", public status = 0) {
    super(message);
  }
}

export interface ModelsInfo {
  whisper: { id: string; label: string; description: string; sizeBytes: number; revision: string }[];
  alignment: { language: string; label: string }[];
  languages: { code: string; name: string; aligned: boolean }[];
}

export class BackendClient {
  constructor(private port: number, private token: string) {}

  private url(path: string) {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 30000): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: { "Content-Type": "application/json", "X-AutoCaption-Token": this.token },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new BackendError("BACKEND_UNREACHABLE", "The caption engine is not responding.", String(e));
    } finally {
      clearTimeout(timer);
    }
    let data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      data = await res.json();
    } catch {
      throw new BackendError("BAD_RESPONSE", "The caption engine sent an unexpected reply.", "", res.status);
    }
    if (!res.ok || data.ok === false) {
      const err = data.error || {};
      const e = new BackendError(err.code || "BACKEND_ERROR", err.message || "The caption engine reported an error.", "", res.status);
      (e as BackendError & { jobId?: string }).jobId = data.jobId;
      throw e;
    }
    return data as T;
  }

  health() {
    return this.request<{ version: string; apiVersion: number; activeJob: string | null; orphansCleaned: number; workerRunning: boolean }>("GET", "/health", undefined, 5000);
  }
  manifest() {
    return this.request<{ manifest: Record<string, unknown> }>("GET", "/manifest");
  }
  models() {
    return this.request<ModelsInfo>("GET", "/models");
  }
  diagnostics() {
    return this.request<{ diagnostics: Record<string, unknown> }>("GET", "/diagnostics");
  }
  verify(extensionVersion: string, full = false) {
    return this.request<{ verify: { ok: boolean; checked: number; missingCount: number; corruptCount: number; missing: string[]; corrupt: string[]; models: { kind: string; id: string; ok: boolean }[]; compatibility: { compatible: boolean; min: string; max: string } } }>(
      "POST", "/verify", { extensionVersion, full }, 600000);
  }
  transcribe(body: { audioPath: string; source?: { start?: number; duration?: number }; options: Record<string, unknown> }) {
    return this.request<{ jobId: string }>("POST", "/transcribe", body);
  }
  align(body: { audioPath: string; language: string; segments: { start: number; end: number; text: string }[] }) {
    return this.request<{ jobId: string }>("POST", "/align", body);
  }
  cancel(jobId: string) {
    return this.request<{ job: JobSnapshot }>("POST", "/cancel", { jobId });
  }
  job(jobId: string) {
    return this.request<{ job: JobSnapshot }>("GET", `/job/${jobId}`);
  }
  stopEngine() {
    return this.request<object>("POST", "/stop-engine", {});
  }
  shutdown() {
    return this.request<object>("POST", "/shutdown", {}, 3000);
  }

  /**
   * Follow a job via Server-Sent Events (streamed fetch so the token stays
   * in a header). Falls back to polling if streaming is unavailable.
   * Resolves with the final snapshot including the result.
   */
  async follow(jobId: string, onUpdate: (s: JobSnapshot) => void, signal?: AbortSignal): Promise<JobSnapshot> {
    const terminal = new Set(["completed", "failed", "cancelled"]);
    try {
      const res = await fetch(this.url(`/job/${jobId}/events`), { headers: { "X-AutoCaption-Token": this.token }, signal });
      if (!res.ok || !res.body) throw new Error("no stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          const snap = JSON.parse(data.slice(6)) as JobSnapshot;
          onUpdate(snap);
          if (terminal.has(snap.state)) {
            reader.cancel().catch(() => undefined);
            return (await this.job(jobId)).job;
          }
        }
      }
    } catch (e) {
      if (signal?.aborted) throw e;
    }
    // polling fallback
    for (;;) {
      const { job } = await this.job(jobId);
      onUpdate(job);
      if (terminal.has(job.state)) return job;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}
