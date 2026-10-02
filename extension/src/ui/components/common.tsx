import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../icons";
import type { ErrorAction, FriendlyError } from "../errors";
import { getStore, useStore } from "../store";

export function Seg<T extends string | number>(props: { value: T; options: { value: T; label: string; title?: string }[]; onChange: (v: T) => void; full?: boolean; label: string }) {
  return (
    <div class={`seg${props.full ? " full" : ""}`} role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button type="button" key={String(o.value)} aria-pressed={o.value === props.value} title={o.title} onClick={() => props.onChange(o.value)}>
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

export interface MenuItem {
  label: string;
  sub?: string;
  icon?: JSX.Element;
  run?: () => void;
  separator?: boolean;
  heading?: boolean;
  disabled?: boolean;
}

/** Button with a popover menu. Closes on outside click / Escape; arrow keys move focus. */
export function MenuButton(props: { button: (open: boolean, toggle: () => void) => JSX.Element; items: MenuItem[]; up?: boolean; right?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)") ?? []);
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
        next?.focus();
        e.preventDefault();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    setTimeout(() => ref.current?.querySelector<HTMLButtonElement>(".menu-item")?.focus(), 0);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div class="menu-wrap" ref={ref}>
      {props.button(open, () => setOpen(!open))}
      {open ? (
        <div class={`menu ${props.up ? "up" : "down"}${props.right ? " right" : ""}`} role="menu">
          {props.items.map((it, i) =>
            it.separator ? <div class="menu-sep" key={i} /> : it.heading ? <div class="menu-label" key={i}>{it.label}</div> : (
              <button class="menu-item" role="menuitem" key={i} disabled={it.disabled} onClick={() => { setOpen(false); it.run?.(); }}>
                {it.icon ? <span class="faint" style={{ marginTop: 1 }}>{it.icon}</span> : null}
                <span class="grow">
                  <div>{it.label}</div>
                  {it.sub ? <div class="mi-sub">{it.sub}</div> : null}
                </span>
              </button>
            ),
          )}
        </div>
      ) : null}
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
              <button class="btn btn-ghost" style={{ paddingLeft: 0 }} onClick={() => setShowDetails(!showDetails)}>
                {showDetails ? "Hide" : "View"} technical details
              </button>
              {showDetails ? <div class="details">{d.details}</div> : null}
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
          {t.action ? <button class="btn btn-ghost" onClick={() => { t.action!.run(); store.dismissToast(t.id); }}>{t.action.label}</button> : null}
          <button class="btn btn-ghost icon-btn sm" aria-label="Dismiss" onClick={() => store.dismissToast(t.id)}>{Icon.x({ size: 12 })}</button>
        </div>
      ))}
    </div>
  );
}

const ACTION_LABEL: Record<ErrorAction, string> = {
  verify: "Verify Backend", retry: "Retry", locate: "Locate Backend", start: "Start Backend",
  language: "Choose Language", select: "OK", details: "View Technical Details", cpu: "Use CPU",
};

export function ErrorCard(props: { error: FriendlyError; onAction: (a: ErrorAction) => void; onClose?: () => void }) {
  const [details, setDetails] = useState(false);
  const e = props.error;
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
          {e.actions.filter((a) => a !== "details").map((a) => (
            <button key={a} class="btn" onClick={() => props.onAction(a)}>{ACTION_LABEL[a]}</button>
          ))}
          {e.detail && e.actions.includes("details") ? (
            <button class="btn btn-ghost" onClick={() => setDetails(!details)}>{details ? "Hide details" : ACTION_LABEL.details}</button>
          ) : null}
          {props.onClose ? <button class="btn btn-ghost" style={{ marginLeft: "auto" }} onClick={props.onClose}>Dismiss</button> : null}
        </div>
        {details && e.detail ? <div class="details">{e.detail}</div> : null}
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
