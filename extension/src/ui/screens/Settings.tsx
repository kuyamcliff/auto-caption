import { useEffect } from "preact/hooks";
import { APP_VERSION } from "../../core/defaults";
import { copyText, ErrorCard, Seg } from "../components/common";
import { Icon } from "../icons";
import { getStore, useStore, type AppState } from "../store";
import { VerifyList } from "./Onboarding";

const TABS: { id: AppState["settingsTab"]; label: string }[] = [
  { id: "general", label: "General" }, { id: "backend", label: "Backend" }, { id: "appearance", label: "Appearance" },
  { id: "advanced", label: "Advanced" }, { id: "diagnostics", label: "Diagnostics" }, { id: "about", label: "About" },
];

function General() {
  const store = getStore();
  const c = useStore((s) => s.config);
  const models = useStore((s) => s.backend.models);
  return (
    <div class="stack-lg">
      <div class="field">
        <label>Default model</label>
        <Seg label="Default model" value={c.defaultModel} onChange={(v) => store.saveConfig({ defaultModel: v })}
          options={(models?.whisper ?? [{ id: "base", label: "Base" }, { id: "small", label: "Small" }]).map((m) => ({ value: m.id, label: m.label }))} />
        <span class="faint small">Base is fastest. Small gives higher transcription quality.</span>
      </div>
      <div class="field">
        <label for="dl">Default language</label>
        <select id="dl" class="select" value={c.defaultLanguage} onChange={(e) => store.saveConfig({ defaultLanguage: (e.target as HTMLSelectElement).value })}>
          <option value="auto">Auto Detect</option>
          {(models?.languages ?? []).map((l) => <option value={l.code} key={l.code}>{l.name}</option>)}
        </select>
      </div>
      <div class="field">
        <label>Words per line</label>
        <Seg label="Words per line" value={c.wordsPerLine} onChange={(v) => store.saveConfig({ wordsPerLine: v })}
          options={[2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }))} />
      </div>
    </div>
  );
}

function Backend() {
  const store = getStore();
  const c = useStore((s) => s.config);
  const b = useStore((s) => s.backend);
  const v = useStore((s) => s.verify);
  const label = { unset: "Not set", missing: "Not found", offline: "Offline", starting: "Starting", ready: "Running", error: "Error", incompatible: "Incompatible" }[b.status];
  return (
    <div class="stack-lg">
      <div class="field">
        <label>Backend location</label>
        <div class="path">{c.backendDir ?? "Not selected"}</div>
        <div class="row row-wrap">
          <button class="btn" onClick={() => store.locateAndVerify()}>{Icon.folder({ size: 14 })} Locate Backend</button>
          {c.backendDir ? <button class="btn btn-ghost" onClick={() => store.f.reveal(c.backendDir!)}>{Icon.external({ size: 14 })} Show in Explorer</button> : null}
        </div>
      </div>
      <div class="row">
        <span class="muted grow">Backend status</span>
        <span class="row" style={{ gap: 6 }}><span class={`dot ${b.status === "ready" ? "ok" : b.status === "starting" ? "busy" : b.status === "offline" ? "" : "err"}`} />{label}{b.version ? ` · ${b.version}` : ""}</span>
      </div>
      {b.error && b.status !== "ready" ? <ErrorCard error={b.error} onAction={(a) => (a === "locate" ? store.chooseBackend() : a === "verify" ? store.runVerify(true) : store.connect().catch(() => undefined))} /> : null}
      <div class="row row-wrap">
        {b.status === "ready" ? <button class="btn" onClick={() => store.stopBackend()}>{Icon.stop({ size: 12 })} Stop backend</button>
          : <button class="btn" disabled={!c.backendDir || b.status === "starting"} onClick={() => store.connect().catch(() => undefined)}>{Icon.play({ size: 12 })} Start backend</button>}
      </div>
      <div class="divider" />
      <div class="row">
        <div class="grow">
          <div class="card-title">Verify installation</div>
          <div class="faint small">Runs a real test transcription, checks every model with SHA‑256 and tests the GPU.</div>
        </div>
        <button class="btn btn-primary" disabled={v.running || !c.backendDir} onClick={() => store.runVerify(false)}>{v.running ? "Verifying…" : "Verify"}</button>
      </div>
      {v.rows.length || v.running ? <VerifyList showDetails /> : null}
      {v.ok === true && !v.running ? <div class="row" style={{ color: "var(--ok)" }}>{Icon.check()} Everything is ready.</div> : null}
      {v.ok === false && !v.running ? (
        <div class="notice err"><span class="ico">{Icon.alert()}</span><div><div class="notice-title">Repair instructions</div>
          <div class="muted">Delete the backend folder and copy a fresh “backend” folder from the AutoCaption download, then click Locate Backend. Nothing needs to be downloaded separately.</div></div></div>
      ) : null}
    </div>
  );
}

function Appearance() {
  const store = getStore();
  const c = useStore((s) => s.config);
  return (
    <div class="stack-lg">
      <div class="field">
        <label>UI scale</label>
        <Seg label="UI scale" value={c.uiScale} onChange={(v) => store.saveConfig({ uiScale: v })}
          options={[{ value: 0.9, label: "90%" }, { value: 1, label: "100%" }, { value: 1.1, label: "110%" }, { value: 1.25, label: "125%" }]} />
      </div>
      <div class="field">
        <label>Theme</label>
        <Seg label="Theme" value={c.theme} onChange={(v) => store.saveConfig({ theme: v })}
          options={[{ value: "auto", label: "Match After Effects" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />
      </div>
    </div>
  );
}

function Advanced() {
  const store = getStore();
  const c = useStore((s) => s.config);
  return (
    <div class="stack-lg">
      <div class="field">
        <label>Compute device</label>
        <Seg label="Compute device" value={c.device} onChange={(v) => store.saveConfig({ device: v })}
          options={[{ value: "auto", label: "Auto" }, { value: "cpu", label: "CPU" }, { value: "cuda", label: "GPU" }]} />
        <span class="faint small">Auto uses a compatible NVIDIA GPU when available and falls back to the CPU.</span>
      </div>
      <div class="field">
        <label for="bs">Batch size</label>
        <select id="bs" class="select" value={String(c.batchSize)} onChange={(e) => store.saveConfig({ batchSize: parseInt((e.target as HTMLSelectElement).value, 10) })}>
          <option value="0">Automatic</option>
          {[2, 4, 8, 16, 24].map((n) => <option value={String(n)} key={n}>{n}</option>)}
        </select>
        <span class="faint small">Lower values use less memory; higher values can be faster on a GPU.</span>
      </div>
      <div class="field">
        <label>Voice activity detection</label>
        <Seg label="VAD mode" value={c.vad} onChange={(v) => store.saveConfig({ vad: v })} options={[{ value: "pyannote", label: "On (recommended)" }, { value: "off", label: "Off" }]} />
        <span class="faint small">Skips silence and music before transcribing. Turn off only if speech is being missed.</span>
      </div>
      <label class="check"><input type="checkbox" checked={c.debug} onChange={(e) => store.saveConfig({ debug: (e.target as HTMLInputElement).checked })} /> Debug logging</label>
    </div>
  );
}

function Diagnostics() {
  const store = getStore();
  const d = useStore((s) => s.diagnostics);
  useEffect(() => { store.loadDiagnostics(); }, []);
  const gpu = d?.gpu as { cudaDevices?: number; name?: string } | undefined;
  const rows: [string, string][] = d ? [
    ["Extension version", String(d.extensionVersion ?? APP_VERSION)],
    ["Backend version", String(d.backendVersion ?? "—")],
    ["After Effects", String(d.afterEffects ?? "—")],
    ["WhisperX", String(d.whisperx ?? "—")],
    ["faster-whisper", String(d.fasterWhisper ?? "—")],
    ["CTranslate2", String(d.ctranslate2 ?? "—")],
    ["PyTorch", String(d.torch ?? "—")],
    ["Models", d.models ? Object.entries(d.models as Record<string, string>).map(([k, v]) => `${k} (${String(v).slice(0, 8)})`).join(", ") : "—"],
    ["Alignment", d.alignmentModels ? Object.keys(d.alignmentModels as object).join(", ") : "—"],
    ["FFmpeg", String(d.ffmpeg ?? "—")],
    ["GPU", gpu ? (gpu.cudaDevices ? `${gpu.name ?? "NVIDIA GPU"} (CUDA)` : "None detected — CPU is used") : "—"],
    ["CPU", `${d.cpu ?? "—"}${d.cpuCores ? ` · ${d.cpuCores} threads` : ""}`],
    ["RAM", d.ramGB ? `${d.ramGB} GB` : "—"],
    ["Free temp space", d.tempFreeGB ? `${d.tempFreeGB} GB` : "—"],
    ["Operating system", String(d.os ?? "—")],
    ["Engine", d.engineRunning ? "Models loaded" : "Idle"],
  ] : [];
  return (
    <div class="stack-lg">
      {!d ? <div class="row muted"><span class="spinner" /> Collecting…</div> : (
        <dl class="kv">{rows.map(([k, v]) => [<dt key={`${k}t`}>{k}</dt>, <dd key={`${k}d`}>{v}</dd>])}</dl>
      )}
      <div class="row row-wrap">
        <button class="btn" disabled={!d} onClick={() => { const ok = copyText(rows.map(([k, v]) => `${k}: ${v}`).join("\n")); store.toast(ok ? "ok" : "err", ok ? "Diagnostics copied" : "Could not copy"); }}>{Icon.copy({ size: 14 })} Copy diagnostics</button>
        <button class="btn" onClick={() => store.f.reveal(store.logsDir())}>{Icon.folder({ size: 14 })} Open logs</button>
        <button class="btn" onClick={() => { store.stopBackend(); store.toast("ok", "Backend stopped. It starts again when needed."); }}>{Icon.stop({ size: 12 })} Stop backend</button>
      </div>
      <div class="faint small">Diagnostics never include your audio, transcripts or the session token.</div>
    </div>
  );
}

function About() {
  const store = getStore();
  return (
    <div class="stack-lg">
      <div class="row" style={{ gap: 12 }}>
        <div class="hero-mark">{Icon.logo({ size: 24 })}</div>
        <div>
          <div class="h1" style={{ fontSize: 16 }}>AutoCaption AE</div>
          <div class="muted">Version {APP_VERSION}</div>
        </div>
      </div>
      <p class="muted" style={{ margin: 0 }}>Offline automatic captions for After Effects.</p>
      <div class="muted small">Powered by WhisperX and faster-whisper. Word timing comes from forced alignment.</div>
      <div class="privacy">{Icon.shield()}<span>Your audio stays on this computer. AutoCaption AE does not upload your media, and has no telemetry or analytics.</span></div>
      <div class="row row-wrap">
        <button class="btn" disabled={!store.state.config.backendDir} onClick={() => store.f.reveal(store.f.join(store.state.config.backendDir!, "licenses"))}>{Icon.external({ size: 14 })} Licenses</button>
        <button class="btn" onClick={() => store.set({ settingsTab: "diagnostics" })}>Diagnostics</button>
      </div>
    </div>
  );
}

export function Settings() {
  const store = getStore();
  const tab = useStore((s) => s.settingsTab);
  return (
    <>
      <div class="tabs" role="tablist" aria-label="Settings">
        {TABS.map((t) => (
          <button class="tab" role="tab" key={t.id} aria-selected={tab === t.id} onClick={() => store.set({ settingsTab: t.id })}>{t.label}</button>
        ))}
      </div>
      <div class="scroll">
        <div class="page" style={{ maxWidth: 560 }}>
          <div class="card card-pad" role="tabpanel">
            {tab === "general" ? <General /> : tab === "backend" ? <Backend /> : tab === "appearance" ? <Appearance /> : tab === "advanced" ? <Advanced /> : tab === "diagnostics" ? <Diagnostics /> : <About />}
          </div>
        </div>
      </div>
    </>
  );
}
