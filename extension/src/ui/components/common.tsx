import type { ComponentChildren, JSX } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../icons";
import type { ErrorAction, FriendlyError } from "../errors";
import { getStore, useStore } from "../store";

export function Seg<T extends string | number>(props: { value: T; options: { value: T; label: string; title?: string; disabled?: boolean }[]; onChange: (v: T) => void; full?: boolean; label: string }) {
  return (
    <div class={`seg${props.full ? " full" : ""}`} role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button type="button" key={String(o.value)} aria-pressed={o.value === props.value} title={o.title} disabled={o.disabled} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Section(props: { title: string; icon?: JSX.Element; open: boolean; onToggle: () => void; right?: ComponentChildren; children: ComponentChildren }) {
  return (
    <div class="card">
      <button class="section-toggle" aria-expanded={props.open} onClick={props.onToggle}>
        {props.icon}
        <span class="card-title">{props.title}</span>
        {props.right ? <span class="faint small" style={{ marginLeft: "auto" }}>{props.right}</span> : null}
        <span class="chev" style={props.right ? { marginLeft: 6 } : undefined}>{Icon.chevron()}</span>
      </button>
      {props.open ? <div class="section-body">{props.children}</div> : null}
    </div>
  );
}

/** Shortest time a spinner stays up, so quick actions still read as "done". */
const MIN_SPIN_MS = 350;

/**
 * Run an action with busy feedback. Resolves after the action and at least
 * MIN_SPIN_MS. Unexpected errors become a toast and a log line, never a
 * silently dead control.
 */
export async function runBusy(action: () => unknown, setBusy: (b: boolean) => void, alive: () => boolean = () => true) {
  setBusy(true);
  const t0 = performance.now();
  try {
    await action();
  } catch (e) {
    const store = getStore();
    store.log("error", `action failed: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    store.toast("err", "That did not work. Please try again. Details are in the log.");
  } finally {
    const left = MIN_SPIN_MS - (performance.now() - t0);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    if (alive()) setBusy(false);
  }
}

function useAlive() {
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  return () => alive.current;
}

/** A button whose click shows a spinner until its (async) work is finished. */
export function AsyncButton(props: {
  onClick: () => unknown;
  children?: ComponentChildren;
  icon?: JSX.Element;
  busyText?: string;
  class?: string;
  disabled?: boolean;
  title?: string;
  label?: string;
  style?: JSX.CSSProperties;
  stop?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const alive = useAlive();
  return (
    <button type="button" class={props.class ?? "btn"} disabled={props.disabled} aria-busy={busy} title={props.title} aria-label={props.label} style={props.style}
      onClick={(e) => {
        if (props.stop) e.stopPropagation();
        if (!busy) runBusy(props.onClick, setBusy, alive);
      }}>
      {busy ? <span class="spinner" aria-hidden="true" /> : props.icon}
      {busy && props.busyText ? props.busyText : props.children}
    </button>
  );
}

export interface MenuItem {
  label: string;
  sub?: string;
  icon?: JSX.Element;
  run?: () => unknown;
  separator?: boolean;
  heading?: boolean;
  disabled?: boolean;
}

/** Button with a popover menu. Closes on outside click / Escape; arrow keys move focus. */
export function MenuButton(props: { button: (open: boolean, toggle: () => void, busy: boolean) => JSX.Element; items: MenuItem[]; up?: boolean; right?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useAlive();
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left?: number; right?: number }>({});
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggle = () => {
    if (busy) return;
    if (!open && ref.current) {
      // Fixed positioning so menus are never clipped by scrolling lists.
      const r = ref.current.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const up = props.up || r.bottom > vh * 0.6;
      const p: typeof pos = up ? { bottom: vh - r.top + 6 } : { top: r.bottom + 6 };
      if (props.right) p.right = Math.max(8, vw - r.right);
      else p.left = Math.max(8, Math.min(r.left, vw - 240));
      setPos(p);
    }
    setOpen(!open);
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)") ?? []);
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
        next?.focus();
        e.preventDefault();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>(".menu-item:not(:disabled)")?.focus(), 0);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div class="menu-wrap" ref={ref}>
      {props.button(open, toggle, busy)}
      {open ? createPortal(
        <div class="menu" role="menu" ref={menuRef} style={{ position: "fixed", ...pos, maxHeight: `${Math.round(window.innerHeight * 0.7)}px`, overflowY: "auto" }}>
          {props.items.map((it, i) =>
            it.separator ? <div class="menu-sep" key={i} /> : it.heading ? <div class="menu-label" key={i}>{it.label}</div> : (
              <button class="menu-item" role="menuitem" key={i} disabled={it.disabled} onClick={() => {
                setOpen(false);
                // async items show a spinner on the menu's button until they finish
                const r = (() => { try { return it.run?.(); } catch (e) { return Promise.reject(e); } })();
                if (r && typeof (r as Promise<unknown>).then === "function") runBusy(() => r, setBusy, alive);
              }}>
                {it.icon ? <span class="faint" style={{ marginTop: 1 }}>{it.icon}</span> : null}
                <span class="grow">
                  <div>{it.label}</div>
                  {it.sub ? <div class="mi-sub">{it.sub}</div> : null}
                </span>
              </button>
            ),
          )}
        </div>
      , document.body) : null}
    </div>
  );
}

export function DialogHost() {
  const d = useStore((s) => s.dialog);
  const ref = useRef<HTMLDivElement>(null);
  const [showDetails, setShowDetails] = useState(false);
  useEffect(() => {
    setShowDetails(false);
    if (!d) return;
    const input = ref.current?.querySelector<HTMLInputElement>("input");
    const primary = ref.current?.querySelector<HTMLButtonElement>(".btn-primary");
    setTimeout(() => (input ? (input.focus(), input.select()) : primary?.focus()), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const cancel = d.actions.find((a) => a.kind === "ghost" && /cancel/i.test(a.label)) ?? d.actions[0];
        cancel?.run?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [d]);
  if (!d) return null;
  const store = getStore();
  const body = Array.isArray(d.body) ? d.body : d.body ? [d.body] : [];
  return (
    <div class="overlay" role="presentation">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title" ref={ref}>
        <div class="dialog-body">
          <div class="dialog-title" id="dlg-title">{d.title}</div>
          {body.map((b, i) => <div class="muted" key={i}>{b}</div>)}
          {d.input ? (
            <div class="field">
              <label for="dlg-input">{d.input.label}</label>
              <input id="dlg-input" class="input" value={d.input.value} maxLength={60}
                onInput={(e) => store.setDialogInput((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === "Enter") d.actions.find((a) => a.kind === "primary")?.run?.(); }} />
            </div>
          ) : null}
          {d.details ? (
            <div>
              <button type="button" class="btn btn-ghost" style={{ paddingLeft: 0 }} aria-expanded={showDetails} onClick={() => setShowDetails(!showDetails)}>
                {showDetails ? "Hide" : "View"} technical details
              </button>
              {showDetails ? (
                <div class="details">
                  <div>{d.details}</div>
                  <AsyncButton class="btn btn-ghost sm-btn" icon={Icon.folder({ size: 12 })} onClick={() => store.f.reveal(store.logsDir())}>Open logs</AsyncButton>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div class="dialog-actions">
          {d.actions.map((a) => (
            <button key={a.label} class={`btn ${a.kind === "primary" ? "btn-primary" : a.kind === "danger" ? "btn-danger" : "btn-ghost"}`} onClick={() => a.run?.()}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const store = getStore();
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div class={`toast ${t.kind}`} key={t.id}>
          <span class="ico">{t.kind === "ok" ? Icon.check() : t.kind === "err" ? Icon.alert() : t.kind === "warn" ? Icon.alert() : Icon.info()}</span>
          <span class="grow">{t.text}</span>
          {t.action ? <AsyncButton class="btn btn-ghost" onClick={async () => { await t.action!.run(); store.dismissToast(t.id); }}>{t.action.label}</AsyncButton> : null}
          <button class="btn btn-ghost icon-btn sm" aria-label="Dismiss" onClick={() => store.dismissToast(t.id)}>{Icon.x({ size: 12 })}</button>
        </div>
      ))}
    </div>
  );
}

const ACTION_LABEL: Record<ErrorAction, string> = {
  verify: "Check Engine", retry: "Try Again", locate: "Choose Engine Folder", start: "Start Engine",
  language: "Choose Language", select: "OK", details: "View technical details", cpu: "Use Processor",
  openfolder: "Open Engine Folder",
};

export function ErrorCard(props: { error: FriendlyError; onAction: (a: ErrorAction) => unknown; onClose?: () => void }) {
  const [details, setDetails] = useState(false);
  const e = props.error;
  const store = getStore();
  return (
    <div class="notice err" role="alert">
      <span class="ico">{Icon.alert()}</span>
      <div class="grow stack" style={{ gap: 6 }}>
        <div>
          <div class="notice-title">{e.title}</div>
          {e.causes.length > 1 ? (
            <>
              <div class="muted small">Possible causes:</div>
              <ul class="small">{e.causes.map((c) => <li key={c}>{c}</li>)}</ul>
            </>
          ) : e.causes.length ? <div class="muted">{e.causes[0]}</div> : null}
        </div>
        <div class="row row-wrap" style={{ gap: 6 }}>
          {e.actions.filter((a) => a !== "details").map((a, i) => (
            <AsyncButton key={a} class={i === 0 ? "btn btn-primary" : "btn"}
              onClick={() => (a === "openfolder" && store.state.config.backendDir ? store.f.reveal(store.state.config.backendDir) : props.onAction(a))}>{ACTION_LABEL[a]}</AsyncButton>
          ))}
          {e.actions.includes("details") ? (
            <button type="button" class="btn btn-ghost" aria-expanded={details} onClick={() => setDetails(!details)}>{details ? "Hide details" : ACTION_LABEL.details}</button>
          ) : null}
          {props.onClose ? <button type="button" class="btn btn-ghost" style={{ marginLeft: "auto" }} onClick={props.onClose}>Dismiss</button> : null}
        </div>
        {details ? (
          <div class="details">
            <div>{e.detail || "No further details."}</div>
            <AsyncButton class="btn btn-ghost sm-btn" icon={Icon.folder({ size: 12 })} onClick={() => store.f.reveal(store.logsDir())}>Open logs</AsyncButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Notice(props: { kind: "warn" | "info" | "err"; title?: string; children: ComponentChildren; onClose?: () => void }) {
  return (
    <div class={`notice ${props.kind}`}>
      <span class="ico">{props.kind === "info" ? Icon.info() : Icon.alert()}</span>
      <div class="grow">
        {props.title ? <div class="notice-title">{props.title}</div> : null}
        <div class={props.title ? "muted" : ""}>{props.children}</div>
      </div>
      {props.onClose ? <button class="btn btn-ghost icon-btn sm" aria-label="Dismiss" onClick={props.onClose}>{Icon.x({ size: 12 })}</button> : null}
    </div>
  );
}

export function copyText(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
