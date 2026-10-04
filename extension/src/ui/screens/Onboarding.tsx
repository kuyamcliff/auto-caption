import { Icon } from "../icons";
import type { SelfTestRow } from "../../host/platform";
import { AsyncButton, ErrorCard } from "../components/common";
import { getStore, useStore } from "../store";

// Rows of the engine check, in the order the engine runs them.
const ROWS: { id: string; label: string }[] = [
  { id: "engine", label: "Engine" },
  { id: "runtime", label: "Engine runtime" },
  { id: "files", label: "File integrity" },
  { id: "permissions", label: "Permissions" },
  { id: "decoder", label: "Audio decoding" },
  { id: "silence", label: "Speech detection" },
  { id: "speech-fast", label: "Fast transcription" },
  { id: "speech-accurate", label: "Accurate transcription" },
  { id: "timing-en", label: "Word timing (English)" },
  { id: "timing-other", label: "Word timing (other languages)" },
  { id: "gpu", label: "Graphics acceleration" },
  { id: "cpu", label: "Processor fallback" },
];

function StatusCell({ row, running }: { row?: SelfTestRow; running: boolean }) {
  if (!row) return <span class="st faint">{running ? <span class="circle" /> : "Not checked"}</span>;
  switch (row.status) {
    case "running":
      return <span class="st"><span class="spinner" /> Checking</span>;
    case "pass":
      return <span class="st pass">{Icon.check({ size: 14 })} Ready</span>;
    case "info":
      return <span class="st">{Icon.info({ size: 14 })} {row.check === "gpu" ? "Not available" : "Not included"}</span>;
    case "warn":
      return <span class="st warn">{Icon.alert({ size: 14 })} Limited</span>;
    default:
      return <span class="st fail">{Icon.x({ size: 14 })} Failed</span>;
  }
}

export function VerifyList(props: { showDetails?: boolean }) {
  const v = useStore((s) => s.verify);
  const byId = new Map(v.rows.map((r) => [r.check, r]));
  return (
    <ul class="checks" aria-label="Engine check" aria-busy={v.running}>
      {ROWS.map((r) => {
        const row = byId.get(r.id);
        return (
          <li key={r.id} title={row?.detail}>
            <span class="nm">
              {r.label}
              {props.showDetails && row?.detail ? <div class="faint small">{row.detail}</div> : null}
              {!props.showDetails && row?.check === "gpu" && row.status === "info" ? <div class="faint small">Your processor will be used.</div>
                : !props.showDetails && row?.status === "info" && row.detail ? <div class="faint small">{row.detail}</div>
                : !props.showDetails && row && (row.status === "fail" || row.status === "warn") && row.detail ? <div class="faint small">{row.detail}</div> : null}
            </span>
            <StatusCell row={row} running={v.running} />
          </li>
        );
      })}
    </ul>
  );
}

export function Credit() {
  return <div class="credit">Made by <b>cyriqvfx</b></div>;
}

export function Onboarding() {
  const store = getStore();
  const dir = useStore((s) => s.config.backendDir);
  const v = useStore((s) => s.verify);
  const step = !dir ? 0 : v.ok ? 2 : 1;
  const failed = !v.running && v.ok === false;
  const choose = async () => {
    if (await store.chooseBackend()) store.runVerify(true);
  };

  return (
    <div class="scroll">
      <div class="center-page">
        <div class="welcome">
          <div class="row" style={{ gap: 12 }}>
            <div class="hero-mark">{Icon.logo({ size: 24 })}</div>
            <div>
              <h1 class="h1">AutoCaption AE</h1>
              <div class="muted small">Captions with word‑accurate timing, made on this computer</div>
            </div>
          </div>
          <div class="stepper" aria-hidden="true">
            <span class={step >= 0 ? "on" : ""} /><span class={step >= 1 ? "on" : ""} /><span class={step >= 2 ? "on" : ""} />
          </div>

          {step === 0 ? (
            <>
              <p class="lead">Welcome. Point AutoCaption to its engine: the <b>AutoCaption Engine</b> folder from your download.</p>
              <AsyncButton class="btn btn-primary btn-lg btn-block" icon={Icon.folder()} onClick={choose}>Choose Engine Folder</AsyncButton>
            </>
          ) : (
            <>
              <div class="stack" style={{ gap: 6 }}>
                <div class="eyebrow">Engine folder</div>
                <div class="row">
                  <div class="path grow" title={dir ?? ""}>{dir}</div>
                  <AsyncButton disabled={v.running} onClick={choose}>Change</AsyncButton>
                </div>
              </div>
              <VerifyList />
              {v.error ? <ErrorCard error={v.error} onAction={(a) => (a === "locate" ? choose() : store.runVerify(true))} /> : null}
              {v.running ? (
                <div class="row muted small"><span class="spinner" /> Checking the engine. The first check takes about a minute.</div>
              ) : v.ok ? (
                <div class="row" style={{ color: "var(--ok)", fontWeight: 600 }}>{Icon.check()} Everything is ready.</div>
              ) : failed ? (
                <div class="muted small">Copy a fresh AutoCaption Engine folder from the download, choose it, then check again.</div>
              ) : null}
              {v.ok ? (
                <AsyncButton class="btn btn-primary btn-lg btn-block" onClick={async () => {
                  await store.saveConfig({ onboarded: true, privacyAck: true });
                  store.set({ screen: "main" });
                  store.connect().catch(() => undefined);
                }}>Start Captioning</AsyncButton>
              ) : (
                <button type="button" class="btn btn-primary btn-lg btn-block" aria-busy={v.running} onClick={() => { if (!v.running) store.runVerify(true); }}>
                  {v.running ? <><span class="spinner" aria-hidden="true" /> Checking…</> : failed ? "Check Again" : "Check Engine"}
                </button>
              )}
            </>
          )}

          <div class="privacy">{Icon.shield()}<span>Your audio stays on this computer. Nothing is uploaded, and no account is needed.</span></div>
          <ol class="muted small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Choose the engine folder</li>
            <li>Select an audio, video or precomp layer in After Effects</li>
            <li>Click Transcribe</li>
          </ol>
          <Credit />
        </div>
      </div>
    </div>
  );
}
