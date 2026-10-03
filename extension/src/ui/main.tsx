import { render } from "preact";
import { APP_VERSION } from "../core/defaults";
import { createCepPlatform } from "../host/cep";
import type { Platform } from "../host/platform";
import { App } from "./app";
import { Store, setStore } from "./store";
import "./styles.css";

declare global {
  interface Window {
    __adobe_cep__?: unknown;
    /** test harnesses can inject a platform before this script runs */
    __AUTOCAPTION_PLATFORM__?: Platform;
  }
}

function boot() {
  const root = document.getElementById("app")!;
  let platform: Platform;
  if (window.__AUTOCAPTION_PLATFORM__) platform = window.__AUTOCAPTION_PLATFORM__;
  else if (window.__adobe_cep__) platform = createCepPlatform(APP_VERSION);
  else {
    root.innerHTML = '<div class="center-page"><div class="welcome"><h1 class="h1">AutoCaption AE</h1><p class="lead">Open this panel inside After Effects: Window › Extensions › AutoCaption AE.</p></div></div>';
    return;
  }
  const store = new Store(platform);
  setStore(store);
  window.addEventListener("error", (e) => store.log("error", `ui error: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => store.log("error", `ui rejection: ${String(e.reason)}`));
  render(<App />, root);
  store.init();
}

boot();
