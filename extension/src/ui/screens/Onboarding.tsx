import { Icon } from "../icons";
import type { SelfTestRow } from "../../host/platform";
import { ErrorCard } from "../components/common";
import { getStore, useStore } from "../store";

// Rows shown to users, in order; technical names are never shown here.
const ROWS: { id: string; label: string }[] = [
  { id: "backend", label: "Backend" },
  { id: "runtime", label: "Runtime" },
  { id: "files", label: "Model integrity" },
  { id: "whisper-base", label: "Whisper Base" },
  { id: "whisper-small", label: "Whisper Small" },
  { id: "align-en", label: "English Alignment" },
  { id: "align-other", label: "Other languages" },
  { id: "vad", label: "VAD" },
  { id: "ffmpeg", label: "FFmpeg" },
  { id: "permissions", label: "Permissions" },
  { id: "gpu", label: "GPU" },
  { id: "cpu", label: "CPU fallback" },
];

function StatusCell({ row, running }: { row?: SelfTestRow; running: boolean }) {
  if (!row) return <span class="st">{running ? <span class="circle" /> : <span class="faint">—</span>}</span>;
  switch (row.status) {
    case "running":
      return <span class="st"><span class="spinner" /> Checking</span>;
    case "pass":
      return <span class="st pass">{Icon.check({ size: 14 })} Ready</span>;
    case "info":
      return <span class="st">{Icon.info({ size: 14 })} {row.check === "gpu" ? "Not available" : "Info"}</span>;
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
    <ul class="checks" aria-label="Backend verification" aria-busy={v.running}>
      {ROWS.map((r) => {
        const row = byId.get(r.id);
        return (
          <li key={r.id} title={row?.detail}>
            <span class="nm">
              {r.label}
              {props.showDetails && row?.detail ? <div class="faint small">{row.detail}</div> : null}
              {!props.showDetails && row?.status === "fail" && row.detail ? <div class="faint small">{row.detail}</div> : null}
              {!props.showDetails && row?.check === "gpu" && row.status !== "pass" ? <div class="faint small">The CPU will be used.</div> : null}
            </span>
            <StatusCell row={row} running={v.running} />
          </li>
        );
      })}
    </ul>
  );
}

export function Onboarding() {
  const store = getStore();
  const dir = useStore((s) => s.config.backendDir);
  const v = useStore((s) => s.verify);
  const step = !dir ? 0 : v.ok ? 2 : 1;
  const failed = !v.running && v.ok === false;

  return (
    <div class="scroll">
      <div class="center-page">
        <div class="welcome">
          <div class="row" style={{ gap: 12 }}>
            <div class="hero-mark">{Icon.logo({ size: 24 })}</div>
            <div>
              <h1 class="h1">AutoCaption AE</h1>
              <div class="muted small">Offline captions with word‑accurate timing</div>
            </div>
          </div>
          <div class="stepper" aria-hidden="true">
            <span class={step >= 0 ? "on" : ""} /><span class={step >= 1 ? "on" : ""} /><span class={step >= 2 ? "on" : ""} />
          </div>

          {step === 0 ? (
            <>
              <p class="lead">Welcome. Let’s connect the local caption engine. Choose the <b>backend</b> folder from the AutoCaption download.</p>
              <button class="btn btn-primary btn-lg btn-block" onClick={async () => { if (await store.chooseBackend()) store.runVerify(true); }}>
                {Icon.folder()} Choose Backend Folder
              </button>
            </>
          ) : (
            <>
              <div class="stack" style={{ gap: 6 }}>
                <div class="eyebrow">Backend folder</div>
                <div class="row">
                  <div class="path grow">{dir}</div>
                  <button class="btn" onClick={async () => { if (await store.chooseBackend()) store.runVerify(true); }}>Change</button>
                </div>
              </div>
              <VerifyList />
              {v.error ? <ErrorCard error={v.error} onAction={() => store.runVerify(true)} /> : null}
              {v.running ? (
                <div class="row muted"><span class="spinner" /> Verifying… this takes about half a minute the first time.</div>
              ) : v.ok ? (
                <div class="row" style={{ color: "var(--ok)", fontWeight: 600 }}>{Icon.check()} Everything is ready.</div>
              ) : failed ? (
                <div class="muted small">Replace the backend folder with a fresh copy from the download, then verify again.</div>
              ) : null}
              {v.ok ? (
                <button class="btn btn-primary btn-lg btn-block" onClick={() => { store.saveConfig({ onboarded: true, privacyAck: true }); store.set({ screen: "main" }); store.connect().catch(() => undefined); }}>
                  Start Captioning
                </button>
              ) : (
                <button class="btn btn-primary btn-lg btn-block" disabled={v.running} onClick={() => store.runVerify(true)}>
                  {v.running ? "Verifying…" : failed ? "Verify Again" : "Verify Backend"}
                </button>
              )}
            </>
          )}

          <div class="privacy">{Icon.shield()}<span>Your audio stays on this computer. AutoCaption AE does not upload your media.</span></div>
          <ol class="muted small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Select Backend</li>
            <li>Select an audio, video or precomp layer in After Effects</li>
            <li>Click Transcribe</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
