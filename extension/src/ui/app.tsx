import { DialogHost, MenuButton, Toasts } from "./components/common";
import { Icon } from "./icons";
import { Help } from "./screens/Help";
import { Main } from "./screens/Main";
import { Onboarding } from "./screens/Onboarding";
import { Settings } from "./screens/Settings";
import { getStore, useStore } from "./store";

function BackendPill() {
  const store = getStore();
  const b = useStore((s) => s.backend.status);
  const job = useStore((s) => s.job.phase);
  const working = job === "extracting" || job === "running";
  const [dot, label] = working ? ["busy", "Working"] : b === "ready" ? ["ok", "Ready"] : b === "starting" ? ["busy", "Starting"]
    : b === "offline" || b === "unset" ? ["", "Offline"] : b === "missing" ? ["err", "Not found"] : ["err", "Error"];
  const items = b === "ready"
    ? [{ label: "Backend: Running", heading: true }, { label: "Verify installation", icon: Icon.check({ size: 14 }), run: () => { store.set({ screen: "settings", settingsTab: "backend" }); store.runVerify(false); } }, { label: "Stop backend", icon: Icon.stop({ size: 12 }), run: () => store.stopBackend() }]
    : b === "error" || b === "incompatible"
      ? [{ label: "Backend: Error", heading: true }, { label: "Verify", icon: Icon.check({ size: 14 }), run: () => { store.set({ screen: "settings", settingsTab: "backend" }); store.runVerify(true); } }, { label: "Repair instructions", icon: Icon.help({ size: 14 }), run: () => store.set({ screen: "settings", settingsTab: "backend" }) }]
      : [{ label: `Backend: ${label}`, heading: true }, { label: "Start Backend", icon: Icon.play({ size: 12 }), run: () => store.connect().catch(() => undefined), disabled: b === "starting" }, { label: "Locate Backend", icon: Icon.folder({ size: 14 }), run: () => store.locateAndVerify() }];
  return (
    <MenuButton right items={items} button={(open, toggle) => (
      <button class="pill" aria-expanded={open} aria-label={`Engine status: ${label}`} onClick={toggle}>
        <span class={`dot ${dot}`} />{label}
      </button>
    )} />
  );
}

export function App() {
  const store = getStore();
  const ready = useStore((s) => s.ready);
  const screen = useStore((s) => s.screen);
  if (!ready) return <div class="center-page"><span class="spinner" /></div>;
  const sub = screen === "settings" || screen === "help";
  return (
    <div class="shell">
      <header class="topbar">
        {sub ? (
          <button class="btn btn-ghost" style={{ paddingLeft: 4 }} onClick={() => store.set({ screen: store.state.config.onboarded ? "main" : "onboarding" })}>
            <span style={{ transform: "rotate(90deg)", display: "inline-flex" }}>{Icon.chevron({ size: 14 })}</span> Back
          </button>
        ) : (
          <div class="brand"><span class="brand-mark">{Icon.logo({ size: 12 })}</span>AutoCaption</div>
        )}
        {sub ? <span class="card-title">{screen === "settings" ? "Settings" : "Help"}</span> : null}
        <span class="spacer" />
        {screen !== "onboarding" ? <BackendPill /> : null}
        <button class="btn btn-ghost icon-btn" aria-label="Help" title="Help" aria-pressed={screen === "help"} onClick={() => store.set({ screen: screen === "help" ? "main" : "help" })}>{Icon.help()}</button>
        <button class="btn btn-ghost icon-btn" aria-label="Settings" title="Settings" aria-pressed={screen === "settings"} onClick={() => store.set({ screen: screen === "settings" ? (store.state.config.onboarded ? "main" : "onboarding") : "settings" })}>{Icon.gear()}</button>
      </header>
      {screen === "onboarding" ? <Onboarding /> : screen === "settings" ? <Settings /> : screen === "help" ? <Help /> : <Main />}
      <Toasts />
      <DialogHost />
    </div>
  );
}
