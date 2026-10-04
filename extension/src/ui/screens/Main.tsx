import { useEffect, useState } from "preact/hooks";
import { EXPORT_FORMATS } from "../../core/formats";
import { CaptionEditor } from "../components/CaptionEditor";
import { AsyncButton, ErrorCard, MenuButton, Notice, runBusy, Seg } from "../components/common";
import { Preview } from "../components/Preview";
import { StylePanel } from "../components/StylePanel";
import type { ErrorAction } from "../errors";
import { Icon } from "../icons";
import { getStore, PACK_LANGUAGES, qualityLabel, qualityOptions, useStore, type JobState, type RecentEntry } from "../store";
import { Credit } from "./Onboarding";

const LANG_FALLBACK = [
  ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"],
  ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"], ["ru", "Russian"], ["nl", "Dutch"], ["hi", "Hindi"],
] as const;

function deviceLabel(device: string) {
  return /^(gpu|cuda)$/i.test(device) ? "Graphics card" : "Processor"; // stored value, not shown
}

function layerIcon(type: string) {
  return type === "audio" ? Icon.wave() : type === "video" ? Icon.film() : type === "precomp" ? Icon.layers() : Icon.wave();
}

function SourceCard() {
  const sel = useStore((s) => s.selection);
  const ready = sel.status === "ready";
  const audioLayers = sel.layers.filter((l) => l.hasAudio);
  let body;
  if (sel.status === "loading") body = <span class="source-empty">Looking for a selected layer…</span>;
  else if (sel.status === "no-comp") body = <span class="source-empty">Open a composition, then select an audio, video, or precomp layer.</span>;
  else if (sel.status === "none") body = <span class="source-empty">Select an audio, video, or precomp layer in After Effects to get started.</span>;
  else if (sel.status === "no-audio") body = (
    <span class="source-empty">This layer does not contain usable audio.<br />Select an audio/video/precomp layer with audio.</span>
  );
  else if (sel.status === "error") body = <span class="source-empty">{sel.message}</span>;
  else {
    const first = audioLayers[0];
    const span = Math.max(...audioLayers.map((l) => l.outPoint)) - Math.min(...audioLayers.map((l) => l.inPoint));
    body = (
      <div class="grow" style={{ minWidth: 0 }}>
        <div class="source-name ellipsis" title={audioLayers.map((l) => l.name).join(", ")}>
          {audioLayers.length > 1 ? `${audioLayers.length} layers mixed` : first.name}
        </div>
        <div class="faint small ellipsis">
          {sel.comp?.name} · {audioLayers.length > 1 ? audioLayers.map((l) => l.name).join(", ") : first.type === "precomp" ? "Precomp" : first.type === "video" ? "Video" : "Audio"} · {span.toFixed(1)} s
        </div>
      </div>
    );
  }
  const muted = audioLayers.filter((l) => !l.audioEnabled);
  const skipped = sel.layers.length - audioLayers.length;
  return (
    <div class="stack" style={{ gap: 6 }}>
      <div class="eyebrow">Source</div>
      <div class="source">
        <div class={`source-ico${ready ? " ready" : ""}`}>{ready ? layerIcon(audioLayers.length > 1 ? "precomp" : audioLayers[0].type) : Icon.layers()}</div>
        {body}
      </div>
      {ready && muted.length ? <div class="faint small">{Icon.info({ size: 12 })} Audio switch is off on {muted.length === 1 ? `“${muted[0].name}”` : `${muted.length} layers`}. AutoCaption still listens to it; your project is not changed.</div> : null}
      {ready && skipped ? <div class="faint small">{Icon.info({ size: 12 })} {skipped} selected layer{skipped > 1 ? "s have" : " has"} no audio and will be ignored.</div> : null}
    </div>
  );
}

const STEPS: { id: string; label: string }[] = [
  { id: "extract", label: "Rendering composition audio" },
  { id: "preparing", label: "Preparing audio" },
  { id: "transcribing", label: "Transcribing" },
  { id: "aligning", label: "Timing each word" },
  { id: "building", label: "Building captions" },
];

function stepIndex(job: JobState): number {
  if (job.phase === "extracting") return 0;
  const st = job.snapshot?.state;
  if (!st || st === "queued" || st === "preparing") return 1;
  if (st === "transcribing") return 2;
  if (st === "aligning") return 3;
  if (st === "building") return 4;
  return 5;
}

function useElapsed(since?: number) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!since) return "";
  const s = Math.floor((Date.now() - since) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function JobProgress() {
  const store = getStore();
  const job = useStore((s) => s.job);
  const elapsed = useElapsed(job.startedAt);
  const idx = stepIndex(job);
  const snap = job.snapshot;
  const pct = snap?.progress;
  const cancelling = snap?.state === "cancelling";
  const steps = job.kind === "align" ? STEPS.filter((s) => s.id !== "transcribing") : STEPS;
  return (
    <div class="stack" aria-live="polite">
      <div class="row">
        <span class="card-title grow">{job.kind === "align" ? "Matching timing to audio" : "Transcribing"}</span>
        <span class="mono faint">{elapsed}</span>
      </div>
      <ul class="steps">
        {steps.map((s) => {
          const i = STEPS.indexOf(s);
          const state = i < idx ? "done" : i === idx ? "active" : "";
          const showPct = state === "active" && typeof pct === "number" && (s.id === "transcribing" || s.id === "aligning");
          return (
            <li class={`step ${state}`} key={s.id}>
              <span class="step-ico">{state === "done" ? Icon.check({ size: 14 }) : state === "active" ? <span class="spinner" /> : <span class="circle" />}</span>
              <span>{s.id === "preparing" && snap?.stage === "loading" && state === "active" ? "Starting the engine" : s.id === "transcribing" && snap?.stage === "detecting" && state === "active" ? "Detecting language" : s.label}</span>
              {showPct ? <span class="pct">{Math.round((pct as number) * 100)}%</span> : null}
            </li>
          );
        })}
      </ul>
      <div class="progress-track" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={typeof pct === "number" ? Math.round(pct * 100) : undefined}>
        {typeof pct === "number" && (idx === 2 || idx === 3) ? <div class="progress-fill" style={{ width: `${Math.max(3, pct * 100)}%` }} /> : <div class="progress-fill progress-indet" />}
      </div>
      {job.note ? <div class="faint small">{job.note}</div> : null}
      {cancelling ? (
        <button type="button" class="btn btn-block" aria-busy="true"><span class="spinner" aria-hidden="true" /> Cancelling…</button>
      ) : <AsyncButton class="btn btn-block" busyText="Cancelling…" onClick={() => store.cancelJob()}>Cancel</AsyncButton>}
    </div>
  );
}

function TranscribeCard() {
  const store = getStore();
  const sel = useStore((s) => s.selection);
  const job = useStore((s) => s.job);
  const cfg = useStore((s) => s.config);
  const models = useStore((s) => s.backend.models);
  const backend = useStore((s) => s.backend.status);
  const [model, setModel] = useState(cfg.defaultModel);
  const [language, setLanguage] = useState(cfg.defaultLanguage);
  const running = job.phase === "extracting" || job.phase === "running";
  const langs = models?.languages ?? LANG_FALLBACK.map(([code, name]) => ({ code, name, aligned: ["en", "es", "fr", "de", "it"].includes(code) }));
  const chosen = langs.find((l) => l.code === language);
  const modelList = qualityOptions(models);
  const usable = modelList.find((m) => m.id === model && !m.missing) ? model : "fast";
  const desc = modelList.find((m) => m.id === usable)?.description;

  const onAction = (a: ErrorAction) => {
    if (a === "retry") store.transcribe({ model: usable, language });
    else if (a === "verify") { store.set({ screen: "settings", settingsTab: "engine" }); return store.runVerify(true); }
    else if (a === "locate") return store.locateAndConnect();
    else if (a === "language") { store.dismissJob(); document.getElementById("lang")?.focus(); }
    else if (a === "cpu") { store.saveConfig({ device: "cpu" }); store.transcribe({ model: usable, language }); }
    else store.dismissJob();
    return undefined;
  };

  return (
    <div class="card card-pad stack-lg">
      <SourceCard />
      {running ? <JobProgress /> : (
        <>
          <div class="grid2">
            <div class="field">
              <label>Quality</label>
              <Seg label="Quality" full value={usable} onChange={(v) => { setModel(v); store.saveConfig({ defaultModel: v }); }}
                options={modelList.map((m) => ({ value: m.id, label: m.label, title: m.description, disabled: m.missing }))} />
              <span class="faint small">{desc}</span>
            </div>
            <div class="field">
              <label for="lang">Language</label>
              <select id="lang" class="select" value={language} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setLanguage(v); store.saveConfig({ defaultLanguage: v }); }}>
                <option value="auto">Auto Detect</option>
                {langs.map((l) => <option value={l.code} key={l.code}>{l.name}</option>)}
              </select>
              <span class="faint small">{language === "auto" ? "Detected from the audio" : chosen?.aligned ? "Precise word timing" : PACK_LANGUAGES.includes(language) ? "Estimated timing. The More languages pack adds precise timing." : "Estimated word timing"}</span>
            </div>
          </div>
          {job.phase === "failed" && job.error ? <ErrorCard error={job.error} onAction={onAction} onClose={() => store.dismissJob()} /> : null}
          {job.phase === "cancelled" ? <Notice kind="info" onClose={() => store.dismissJob()}>Transcription cancelled. Temporary files were removed.</Notice> : null}
          <button class="btn btn-primary btn-lg btn-block" disabled={sel.status !== "ready" || backend === "starting"} onClick={() => store.transcribe({ model: usable, language })}>
            {backend === "starting" ? <><span class="spinner" aria-hidden="true" /> Starting engine…</> : <>{Icon.wave()} Transcribe</>}
          </button>
        </>
      )}
    </div>
  );
}

function RecentRow({ r }: { r: RecentEntry }) {
  const store = getStore();
  const [opening, setOpening] = useState(false);
  const [removing, setRemoving] = useState(false);
  const open = () => { if (!opening) runBusy(() => store.openRecent(r.id), setOpening); };
  return (
    <div class="cap" style={{ gridTemplateColumns: "1fr auto" }} role="button" tabIndex={0} aria-busy={opening}
      onClick={open} onKeyDown={(e) => { if (e.key === "Enter") open(); }}>
      <div style={{ minWidth: 0 }}>
        <div class="ellipsis" style={{ fontWeight: 600 }}>{r.name}</div>
        <div class="faint small">{r.captions} captions · {r.language.toUpperCase()} · {new Date(r.updatedAt).toLocaleString()}</div>
      </div>
      <div class="cap-actions" style={opening || removing ? { opacity: 1 } : undefined}>
        {opening ? <span class="spinner" aria-label="Opening" /> : (
          <button type="button" class="btn btn-ghost icon-btn sm" aria-label={`Remove ${r.name}`} title="Remove from list" aria-busy={removing}
            onClick={(e) => { e.stopPropagation(); if (!removing) runBusy(() => store.removeRecent(r.id), setRemoving); }}>
            {removing ? <span class="spinner" aria-hidden="true" /> : Icon.x({ size: 12 })}
          </button>
        )}
      </div>
    </div>
  );
}

function Recent() {
  const recent = useStore((s) => s.recent);
  if (!recent.length) return null;
  return (
    <div class="card">
      <div class="card-head"><span class="card-title">Recent transcriptions</span><span class="faint small" style={{ marginLeft: "auto" }}>Reopen without transcribing again</span></div>
      <div style={{ padding: 4 }}>
        {recent.slice(0, 6).map((r) => <RecentRow r={r} key={r.id} />)}
      </div>
    </div>
  );
}

function ProjectHeader() {
  const store = getStore();
  const p = useStore((s) => s.project)!;
  const warnings = p.transcription.warnings;
  const [hidden, setHidden] = useState(false);
  return (
    <div class="stack">
      <div class="card card-pad row" style={{ gap: 10 }}>
        <div class="source-ico ready">{layerIcon(p.source.layerType)}</div>
        <div class="grow" style={{ minWidth: 0 }}>
          <div class="source-name ellipsis">{p.source.layers.map((l) => l.name).join(", ") || p.project.name}</div>
          <div class="faint small ellipsis">{p.source.composition} · {p.transcription.language.toUpperCase()} · {qualityLabel(p.transcription.model)}{p.transcription.device ? ` · ${deviceLabel(p.transcription.device)}` : ""}</div>
        </div>
        <button type="button" class="btn" onClick={() => store.closeProject()} title="Back to source selection">{Icon.plus({ size: 14 })} New</button>
      </div>
      {!hidden && warnings.length ? (
        <Notice kind="warn" onClose={() => setHidden(true)}>
          {warnings.map((w) => <div key={w.code}>{w.message}</div>)}
        </Notice>
      ) : null}
    </div>
  );
}

function ActionBar() {
  const store = getStore();
  const p = useStore((s) => s.project);
  const busy = useStore((s) => s.busyCreate);
  return (
    <div class="actionbar">
      <MenuButton up button={(open, toggle, working) => (
        <button type="button" class="btn" aria-expanded={open} aria-busy={working} onClick={toggle}>
          {working ? <span class="spinner" aria-hidden="true" /> : Icon.download({ size: 14 })} Export {Icon.chevron({ size: 12 })}
        </button>
      )} items={[
        { label: "Export", heading: true },
        ...EXPORT_FORMATS.map((f) => ({ label: f.label, sub: f.hint, run: () => store.exportAs(f.id), disabled: !p })),
        { separator: true, label: "" },
        { label: "Import JSON, SRT or VTT…", icon: Icon.upload({ size: 14 }), run: () => store.importFile() },
      ]} />
      {busy ? (
        <button type="button" class="btn btn-primary btn-lg grow" aria-busy="true"><span class="spinner" aria-hidden="true" /> Creating layers…</button>
      ) : (
        <AsyncButton class="btn btn-primary btn-lg grow" icon={Icon.layers()} disabled={!p} onClick={() => store.createLayers()}>Create Text Layers</AsyncButton>
      )}
    </div>
  );
}

export function Main() {
  const store = getStore();
  const p = useStore((s) => s.project);
  const backend = useStore((s) => s.backend);

  // global shortcuts (not while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      const typing = tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT");
      if (typing || store.state.dialog) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { store.undo(); e.preventDefault(); }
      else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { store.redo(); e.preventDefault(); }
      else if (e.key === " " && store.state.project) { store.set({ playing: !store.state.playing }); e.preventDefault(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div class="scroll">
        <div class="page">
          {backend.status === "missing" || backend.status === "unset" ? (
            <ErrorCard error={backend.error ?? { code: "ENGINE_MISSING", title: "Engine not found", causes: ["The AutoCaption Engine folder was moved, renamed or deleted."], actions: ["locate"] }}
              onAction={() => store.locateAndVerify()} />
          ) : null}
          {!p ? (
            <div class="cols" style={{ gridTemplateColumns: "minmax(0, 560px)", justifyContent: "center" }}>
              <div class="col"><TranscribeCard /><Recent /><Credit /></div>
            </div>
          ) : (
            <div class="cols">
              <div class="col">
                <ProjectHeader />
                <CaptionEditor />
              </div>
              <div class="col col-side">
                <Preview />
                <StylePanel />
              </div>
            </div>
          )}
        </div>
      </div>
      <ActionBar />
    </>
  );
}
