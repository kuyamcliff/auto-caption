import { useMemo, useState } from "preact/hooks";
import { ANIMATION_PRESETS } from "../../core/defaults";
import { FALLBACK_FONTS } from "../../core/presets";
import type { AnimationSettings, StyleSettings } from "../../core/types";
import { Icon } from "../icons";
import { MenuButton, Section, Seg } from "./common";
import { getStore, useStore } from "../store";

/** Tiny looping demo per animation tile (CSS only, no timers). */
const DEMO: Record<AnimationSettings["preset"], string> = {
  none: "", fade: "demo-fade", pop: "demo-pop", slideUp: "demo-up", slideDown: "demo-down", bounce: "demo-bounce",
  wordPop: "demo-wordpop", karaoke: "demo-karaoke", typewriter: "demo-type", highlight: "demo-hl",
};

function Num(props: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <div class="field">
      <label>{props.label}</label>
      <div class="row" style={{ gap: 6 }}>
        <input type="range" min={props.min} max={props.max} step={props.step ?? 1} value={props.value} aria-label={props.label}
          onInput={(e) => props.onChange(parseFloat((e.target as HTMLInputElement).value))} />
        <input class="input num" type="number" min={props.min} max={props.max} step={props.step ?? 1} value={props.value} aria-label={`${props.label} value`}
          onChange={(e) => { const v = parseFloat((e.target as HTMLInputElement).value); if (Number.isFinite(v)) props.onChange(Math.min(props.max, Math.max(props.min, v))); }} />
      </div>
    </div>
  );
}

function Color(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label class="row" style={{ gap: 6 }} title={props.label}>
      <input type="color" value={props.value} aria-label={props.label} onInput={(e) => props.onChange((e.target as HTMLInputElement).value.toUpperCase())} />
      <span class="small muted">{props.label}</span>
    </label>
  );
}

export function AnimationPicker() {
  const store = getStore();
  const a = useStore((s) => s.project!.animation);
  const set = (patch: Partial<AnimationSettings>, label?: string) => store.setAnimation(patch, label);
  const perWord = ["wordPop", "karaoke", "highlight", "typewriter"].includes(a.preset);
  return (
    <div class="stack">
      <div class="anim-grid" role="group" aria-label="Animation">
        {ANIMATION_PRESETS.map((p) => (
          <button class="anim-tile" key={p.id} aria-pressed={a.preset === p.id} onClick={() => set({ preset: p.id }, `Animation: ${p.label}`)} title={p.perWord ? "Uses the aligned word timing" : undefined}>
            <div class={`demo ${DEMO[p.id]}`} aria-hidden="true">
              {p.perWord ? <><span>Aa</span>&nbsp;<span>Bb</span>&nbsp;<span>Cc</span></> : <span>Aa Bb</span>}
            </div>
            <div class="nm">{p.label}</div>
          </button>
        ))}
      </div>
      {a.preset !== "none" ? (
        <div class="grid2">
          <Num label="Speed (s)" value={a.duration} min={0.05} max={1} step={0.01} onChange={(v) => set({ duration: v }, "Animation speed")} />
          <div class="field">
            <label>{perWord && a.preset !== "typewriter" && a.preset !== "wordPop" ? "Highlight" : "Out animation"}</label>
            {perWord && a.preset !== "typewriter" && a.preset !== "wordPop" ? (
              <Color label="Highlight colour" value={a.highlightColor} onChange={(v) => set({ highlightColor: v }, "Highlight colour")} />
            ) : (
              <label class="check" style={{ height: 28 }}><input type="checkbox" checked={a.animateOut} onChange={(e) => set({ animateOut: (e.target as HTMLInputElement).checked }, "Out animation")} /> Fade out</label>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function StylePanel() {
  const store = getStore();
  const s = useStore((st) => st.project!.style);
  const presets = useStore((st) => st.presets);
  const presetId = useStore((st) => st.presetId);
  const fonts = useStore((st) => st.fonts);
  const [open, setOpen] = useState({ style: false, anim: true });
  const set = (patch: Partial<StyleSettings>, label?: string) => store.setStyle(patch, label);

  const fontOptions = useMemo(() => {
    if (!fonts.length) return FALLBACK_FONTS.map((f) => ({ ps: f.ps, family: f.family, label: f.label }));
    return fonts.slice(0, 2500).map((f) => ({ ps: f.ps, family: f.family, label: `${f.family} ${f.style}`.trim() }));
  }, [fonts]);
  const current = presets.find((p) => p.id === presetId);
  const mine = presets.filter((p) => !p.builtIn);

  return (
    <>
      <Section title="Animation" icon={Icon.sparkle()} open={open.anim} onToggle={() => setOpen({ ...open, anim: !open.anim })}>
        <AnimationPicker />
      </Section>
      <Section title="Style" icon={Icon.text()} open={open.style} onToggle={() => setOpen({ ...open, style: !open.style })} right={current?.name ?? "Custom"}>
        <div class="row">
          <select class="select grow" aria-label="Style preset" value={presetId ?? ""} onChange={(e) => store.applyPreset((e.target as HTMLSelectElement).value)}>
            {!presetId ? <option value="">Custom</option> : null}
            <optgroup label="Built-in">{presets.filter((p) => p.builtIn).map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}</optgroup>
            {mine.length ? <optgroup label="My Presets">{mine.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}</optgroup> : null}
          </select>
          <button class="btn" onClick={() => store.savePreset()} title="Save the current style and animation as a preset">{Icon.save({ size: 14 })} Save</button>
          {current && !current.builtIn ? (
            <MenuButton right button={(o, t) => <button class="btn btn-ghost icon-btn" aria-label="Preset options" aria-expanded={o} onClick={t}>{Icon.more()}</button>}
              items={[{ label: `Delete “${current.name}”`, icon: Icon.trash({ size: 14 }), run: () => store.deletePreset(current.id) }]} />
          ) : null}
        </div>

        <div class="grid2">
          <div class="field">
            <label for="font">Font</label>
            <select id="font" class="select" value={s.font} onChange={(e) => {
              const ps = (e.target as HTMLSelectElement).value;
              const f = fontOptions.find((x) => x.ps === ps);
              set({ font: ps, fontFamily: f?.family ?? s.fontFamily }, "Font");
            }}>
              {!fontOptions.some((f) => f.ps === s.font) ? <option value={s.font}>{s.fontFamily}</option> : null}
              {fontOptions.map((f) => <option value={f.ps} key={f.ps}>{f.label}</option>)}
            </select>
          </div>
          <Num label="Size" value={s.fontSize} min={12} max={300} onChange={(v) => set({ fontSize: v }, "Font size")} />
        </div>

        <div class="row row-wrap" style={{ gap: 14 }}>
          <Color label="Fill" value={s.fill} onChange={(v) => set({ fill: v }, "Fill colour")} />
          <label class="check"><input type="checkbox" checked={s.allCaps} onChange={(e) => set({ allCaps: (e.target as HTMLInputElement).checked }, "All caps")} /> ALL CAPS</label>
        </div>

        <div class="stack" style={{ gap: 6 }}>
          <label class="check"><input type="checkbox" checked={s.strokeEnabled} onChange={(e) => set({ strokeEnabled: (e.target as HTMLInputElement).checked }, "Stroke")} /> Stroke</label>
          {s.strokeEnabled ? (
            <div class="row" style={{ gap: 10 }}>
              <Color label="Colour" value={s.stroke} onChange={(v) => set({ stroke: v }, "Stroke colour")} />
              <div class="grow"><Num label="Width" value={s.strokeWidth} min={0} max={40} step={0.5} onChange={(v) => set({ strokeWidth: v }, "Stroke width")} /></div>
            </div>
          ) : null}
        </div>

        <div class="stack" style={{ gap: 6 }}>
          <label class="check"><input type="checkbox" checked={s.shadowEnabled} onChange={(e) => set({ shadowEnabled: (e.target as HTMLInputElement).checked }, "Shadow")} /> Shadow</label>
          {s.shadowEnabled ? (
            <div class="grid2">
              <Num label="Distance" value={s.shadowDistance} min={0} max={50} onChange={(v) => set({ shadowDistance: v }, "Shadow distance")} />
              <Num label="Softness" value={s.shadowSoftness} min={0} max={80} onChange={(v) => set({ shadowSoftness: v }, "Shadow softness")} />
            </div>
          ) : null}
        </div>

        <div class="stack" style={{ gap: 6 }}>
          <label class="check"><input type="checkbox" checked={s.backgroundEnabled} onChange={(e) => set({ backgroundEnabled: (e.target as HTMLInputElement).checked }, "Background")} /> Background box</label>
          {s.backgroundEnabled ? (
            <div class="row" style={{ gap: 10 }}>
              <Color label="Colour" value={s.background} onChange={(v) => set({ background: v }, "Background colour")} />
              <div class="grow"><Num label="Opacity %" value={Math.round(s.backgroundOpacity * 100)} min={0} max={100} onChange={(v) => set({ backgroundOpacity: v / 100 }, "Background opacity")} /></div>
            </div>
          ) : null}
        </div>

        <div class="field">
          <label>Alignment</label>
          <Seg label="Alignment" full value={s.align} onChange={(v) => set({ align: v }, "Alignment")}
            options={[{ value: "left", label: "Left" }, { value: "center", label: "Center" }, { value: "right", label: "Right" }]} />
        </div>
        <div class="field">
          <label>Position</label>
          <Seg label="Position preset" full value={s.positionY >= 0.7 ? "bottom" : s.positionY <= 0.3 ? "top" : "middle"}
            onChange={(v) => set({ positionY: v === "bottom" ? 0.78 : v === "top" ? 0.18 : 0.5 }, "Position")}
            options={[{ value: "top", label: "Top" }, { value: "middle", label: "Middle" }, { value: "bottom", label: "Bottom" }]} />
          <Num label="Height %" value={Math.round(s.positionY * 100)} min={0} max={100} onChange={(v) => set({ positionY: v / 100 }, "Position")} />
        </div>
        <div class="grid2">
          <Num label="Tracking" value={s.tracking} min={-100} max={300} onChange={(v) => set({ tracking: v }, "Tracking")} />
          <Num label="Scale %" value={s.scale} min={10} max={300} onChange={(v) => set({ scale: v }, "Scale")} />
        </div>
      </Section>
    </>
  );
}
