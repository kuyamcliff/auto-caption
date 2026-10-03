import { useEffect } from "preact/hooks";
import { APP_VERSION } from "../../core/defaults";
import { AsyncButton, copyText, ErrorCard, Seg } from "../components/common";
import { Icon } from "../icons";
import { getStore, useStore, type AppState } from "../store";
import { Credit, VerifyList } from "./Onboarding";

const TABS: { id: AppState["settingsTab"]; label: string }[] = [
  { id: "general", label: "General" }, { id: "engine", label: "Engine" }, { id: "appearance", label: "Appearance" },
  { id: "advanced", label: "Advanced" }, { id: "diagnostics", label: "Diagnostics" }, { id: "about", label: "About" },
];

const QUALITY_FALLBACK = [{ id: "fast", label: "Fast", description: "Quickest results" }, { id: "accurate", label: "Accurate", description: "Best for difficult audio" }];

function General() {
  const store = getStore();
  const c = useStore((s) => s.config);
  const models = useStore((s) => s.backend.models);
  const quality = models?.quality?.length ? models.quality : QUALITY_FALLBACK;
  return (
    <div class="stack-lg">
      <div class="field">
        <label>Default quality</label>
        <Seg label="Default quality" value={c.defaultModel} onChange={(v) => store.saveConfig({ defaultModel: v })}
          options={quality.map((m) => ({ value: m.id, label: m.label, title: m.description }))} />
        <span class="faint small">Fast gives the quickest results. Accurate takes longer and handles difficult audio better.</span>
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

function Engine() {
  const store = getStore();
  const c = useStore((s) => s.config);
  const b = useStore((s) => s.backend);
  const v = useStore((s) => s.verify);
  const label = { unset: "Not set", missing: "Not found", offline: "Stopped", starting: "Starting", ready: "Running", error: "Needs attention", incompatible: "Wrong version" }[b.status];
  return (
    <div class="stack-lg">
      <div class="field">
        <label>Engine folder</label>
        <div class="path" title={c.backendDir ?? ""}>{c.backendDir ?? "Not chosen yet"}</div>
        <div class="row row-wrap">
          <AsyncButton icon={Icon.folder({ size: 14 })} disabled={v.running} onClick={() => store.locateAndVerify()}>Choose Engine Folder</AsyncButton>
          {c.backendDir ? <AsyncButton class="btn btn-ghost" icon={Icon.external({ size: 14 })} onClick={() => store.f.reveal(c.backendDir!)}>Show in Explorer</AsyncButton> : null}
        </div>
      </div>
      <div class="row">
        <span class="muted grow">Status</span>
        <span class="row" style={{ gap: 6 }}>
          {b.status === "starting" ? <span class="spinner" /> : <span class={`dot ${b.status === "ready" ? "ok" : b.status === "offline" ? "" : "err"}`} />}
          {label}{b.version ? ` · ${b.version}` : ""}
        </span>
      </div>
      {b.error && b.status !== "ready" ? (
        <ErrorCard error={b.error} onAction={(a) => (a === "locate" ? store.locateAndVerify() : a === "verify" ? store.runVerify(true) : store.connect().catch(() => undefined))} />
      ) : null}
      <div class="row row-wrap">
        {b.status === "ready"
          ? <AsyncButton icon={Icon.stop({ size: 12 })} onClick={() => store.stopBackend()}>Stop Engine</AsyncButton>
          : <AsyncButton icon={Icon.play({ size: 12 })} busyText="Starting…" disabled={!c.backendDir || b.status === "starting"} onClick={() => store.connect().catch(() => undefined)}>Start Engine</AsyncButton>}
        <span class="faint small">The engine starts by itself when you transcribe, and stops after 10 idle minutes.</span>
      </div>
      <div class="divider" />
      <div class="row">
        <div class="grow">
          <div class="card-title">Check engine</div>
          <div class="faint small">Runs a real test transcription, checks every engine file and tests graphics acceleration.</div>
        </div>
        <button type="button" class="btn btn-primary" aria-busy={v.running} disabled={!c.backendDir} onClick={() => { if (!v.running) store.runVerify(false); }}>
          {v.running ? <><span class="spinner" aria-hidden="true" /> Checking…</> : "Check"}
        </button>
      </div>
      {v.rows.length || v.running ? <VerifyList showDetails /> : null}
      {v.ok === true && !v.running ? <div class="row" style={{ color: "var(--ok)" }}>{Icon.check()} Everything is ready.</div> : null}
      {v.ok === false && !v.running ? (
        <div class="notice err"><span class="ico">{Icon.alert()}</span><div><div class="notice-title">How to repair</div>
          <div class="muted">Delete the AutoCaption Engine folder, copy a fresh one from the download, then click Choose Engine Folder. Nothing needs to be downloaded separately.</div></div></div>
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
        <label>Panel scale</label>
        <Seg label="Panel scale" value={c.uiScale} onChange={(v) => store.saveConfig({ uiScale: v })}
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
        <label>Processing</label>
        <Seg label="Processing" value={c.device} onChange={(v) => store.saveConfig({ device: v })}
          options={[{ value: "auto", label: "Automatic" }, { value: "gpu", label: "Graphics card" }, { value: "cpu", label: "Processor" }]} />
        <span class="faint small">Automatic uses a supported NVIDIA graphics card when there is one, and your processor otherwise.</span>
      </div>
      <div class="field">
        <label for="bs">Batch size</label>
        <select id="bs" class="select" value={String(c.batchSize)} onChange={(e) => store.saveConfig({ batchSize: parseInt((e.target as HTMLSelectElement).value, 10) })}>
          <option value="0">Automatic</option>
          {[2, 4, 8, 16, 24].map((n) => <option value={String(n)} key={n}>{n}</option>)}
        </select>
        <span class="faint small">Lower values use less memory. Higher values can be faster on a graphics card.</span>
      </div>
      <div class="field">
        <label>Skip silence</label>
        <Seg label="Skip silence" value={c.vad} onChange={(v) => store.saveConfig({ vad: v })} options={[{ value: "on", label: "On (recommended)" }, { value: "off", label: "Off" }]} />
        <span class="faint small">Skips silence and music before transcribing. Turn it off only if speech is being missed.</span>
      </div>
      <label class="check"><input type="checkbox" checked={c.debug} onChange={(e) => store.saveConfig({ debug: (e.target as HTMLInputElement).checked })} /> Detailed logging</label>
    </div>
  );
}

function Diagnostics() {
  const store = getStore();
  const d = useStore((s) => s.diagnostics);
  useEffect(() => { store.loadDiagnostics(); }, []);
  const gpu = d?.gpu as { available?: boolean; name?: string; memory?: string | number } | undefined;
  const none = "Unknown";
  const rows: [string, string][] = d ? [
    ["Panel version", String(d.extensionVersion ?? APP_VERSION)],
    ["Engine version", String(d.engineVersion ?? none)],
    ["After Effects", String(d.afterEffects ?? none)],
    ["Graphics", gpu ? (gpu.available ? `${gpu.name ?? "NVIDIA graphics card"}${gpu.memory ? ` (${gpu.memory})` : ""}` : "No supported graphics card. The processor is used.") : none],
    ["Processor", `${d.cpu ?? none}${d.cpuCores ? ` · ${d.cpuCores} threads` : ""}`],
    ["Memory", d.ramGB ? `${d.ramGB} GB` : none],
    ["Free temp space", d.tempFreeGB ? `${d.tempFreeGB} GB` : none],
    ["Operating system", String(d.os ?? none)],
    ["Engine", d.engineStatus ? String(d.engineStatus) : d.engineRunning ? "Running, ready to transcribe" : "Running, idle"],
  ] : [];
  return (
    <div class="stack-lg">
      {!d ? <div class="row muted"><span class="spinner" /> Collecting…</div> : (
        <dl class="kv">{rows.map(([k, v]) => [<dt key={`${k}t`}>{k}</dt>, <dd key={`${k}d`}>{v}</dd>])}</dl>
      )}
      <div class="row row-wrap">
        <AsyncButton icon={Icon.copy({ size: 14 })} disabled={!d} onClick={() => {
          const ok = copyText(rows.map(([k, v]) => `${k}: ${v}`).join("\n"));
          store.toast(ok ? "ok" : "err", ok ? "Diagnostics copied" : "Could not copy");
        }}>Copy diagnostics</AsyncButton>
        <AsyncButton icon={Icon.folder({ size: 14 })} onClick={() => store.f.reveal(store.logsDir())}>Open logs</AsyncButton>
        <AsyncButton icon={Icon.refresh({ size: 14 })} onClick={() => store.loadDiagnostics()}>Refresh</AsyncButton>
        <AsyncButton icon={Icon.stop({ size: 12 })} onClick={async () => { await store.stopBackend(); store.toast("ok", "Engine stopped. It starts again when needed."); }}>Stop Engine</AsyncButton>
      </div>
      <div class="faint small">Diagnostics never include your audio or transcripts.</div>
    </div>
  );
}

function About() {
  const store = getStore();
  const dir = useStore((s) => s.config.backendDir);
  return (
    <div class="stack-lg">
      <div class="row" style={{ gap: 12 }}>
        <div class="hero-mark">{Icon.logo({ size: 24 })}</div>
        <div>
          <div class="h1" style={{ fontSize: 16 }}>AutoCaption AE</div>
          <div class="muted">Version {APP_VERSION} · Made by <b>cyriqvfx</b></div>
        </div>
      </div>
      <p class="muted" style={{ margin: 0 }}>Automatic captions for After Effects with word‑accurate timing. Everything runs on this computer.</p>
      <div class="privacy">{Icon.shield()}<span>Your audio stays on this computer. AutoCaption AE does not upload your media, and has no telemetry or analytics.</span></div>
      <div class="row row-wrap">
        <AsyncButton icon={Icon.external({ size: 14 })} disabled={!dir} title={dir ? undefined : "Choose the engine folder first"}
          onClick={() => store.f.reveal(store.f.join(dir!, "Third-party notices.txt"))}>Third-party notices</AsyncButton>
        <button type="button" class="btn" onClick={() => store.set({ settingsTab: "diagnostics" })}>Diagnostics</button>
      </div>
      <Credit />
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
          <button type="button" class="tab" role="tab" key={t.id} aria-selected={tab === t.id} onClick={() => store.set({ settingsTab: t.id })}>{t.label}</button>
        ))}
      </div>
      <div class="scroll">
        <div class="page" style={{ maxWidth: 560 }}>
          <div class="card card-pad" role="tabpanel">
            {tab === "general" ? <General /> : tab === "engine" ? <Engine /> : tab === "appearance" ? <Appearance /> : tab === "advanced" ? <Advanced /> : tab === "diagnostics" ? <Diagnostics /> : <About />}
          </div>
        </div>
      </div>
    </>
  );
}
