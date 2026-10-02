// Animation preview. Renders the caption at composition resolution (scaled to
// fit) and evaluates the same keyframes / word formulas the AE layers use, at
// the real word timestamps.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { captionTracks, charMaps, evalTrack, WORD_PRESETS, wordAmount, wordAnimatorProps } from "../../core/anim";
import { views } from "../../core/edit";
import { joinWords, type CaptionView } from "../../core/segment";
import { formatTimecode } from "../../core/timing";
import type { Project } from "../../core/types";
import { Icon } from "../icons";
import { getStore, useStore } from "../store";

function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const x = p(a);
  const y = p(b);
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * Math.max(0, Math.min(1, t))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function CaptionRender({ p, v, t }: { p: Project; v: CaptionView; t: number }) {
  const s = p.style;
  const a = p.animation;
  const dur = v.end - v.start;
  const lt = t - v.start;
  const tracks = useMemo(() => captionTracks(a, s.fontSize), [a, s.fontSize]);
  const opacity = evalTrack(tracks.opacity, lt, dur, 100) / 100;
  const scale = (evalTrack(tracks.scale, lt, dur, 100) / 100) * (s.scale / 100);
  const dy = evalTrack(tracks.offsetY, lt, dur, 0);
  const perWord = WORD_PRESETS.has(a.preset);
  const props = perWord ? wordAnimatorProps(a) : {};
  const noSpaces = !!p.transcription.noSpaces;
  const caps = (x: string) => (s.allCaps ? x.toLocaleUpperCase() : x);

  // char maps over the exact layer text, like the AE expression selector
  const text = v.lines.map((l) => caps(joinWords(l, noSpaces))).join("\r");
  const words = v.lines.flat();
  const wt = { starts: words.map((w) => w.start - v.start), ends: words.map((w) => w.end - v.start) };
  const maps = perWord ? charMaps(text, words.map((w) => caps(w.text)), wt) : null;

  let ci = 0;
  const renderLine = (line: typeof words, li: number, layer: "stroke" | "fill") => {
    const parts: preact.JSX.Element[] = [];
    line.forEach((w, wi) => {
      const chars = Array.from(caps(w.text));
      const spans = chars.map((ch, k) => {
        const idx = ci + k;
        let style: Record<string, string | number> | undefined;
        if (maps) {
          const amt = wordAmount(a.preset, a.duration, lt, maps.charWord[idx], maps.charTime[idx], wt) / 100;
          const o = props.opacity !== undefined ? 1 + (props.opacity / 100 - 1) * amt : 1;
          style = { opacity: Math.max(0, Math.min(1, o)) };
          if (props.fill && layer === "fill") style.color = mix(s.fill, props.fill, amt);
        }
        return <span key={k} style={style}>{ch}</span>;
      });
      // word-level scale (anchor grouping = word in AE)
      let wstyle: Record<string, string> | undefined;
      if (maps && props.scale !== undefined) {
        const amt = wordAmount(a.preset, a.duration, lt, maps.charWord[ci], maps.charTime[ci], wt) / 100;
        wstyle = { transform: `scale(${1 + (props.scale / 100 - 1) * amt})` };
      }
      ci += chars.length;
      parts.push(<span class="wd" key={`w${wi}`} style={wstyle}>{spans}</span>);
      if (wi < line.length - 1 && !noSpaces) {
        parts.push(<span key={`s${wi}`}> </span>);
        ci += 1;
      }
    });
    if (li < v.lines.length - 1) ci += 1; // "\r"
    return parts;
  };

  const lineEls = (layer: "stroke" | "fill") => {
    ci = 0;
    return v.lines.map((l, li) => <span class="ln" key={li}>{renderLine(l, li, layer)}</span>);
  };

  const font = { fontFamily: `"${s.fontFamily}", Arial, sans-serif`, fontSize: `${s.fontSize}px`, fontWeight: /bold|black|heavy|impact/i.test(s.font) ? 700 : 400,
    letterSpacing: `${(s.tracking / 1000) * s.fontSize}px`, lineHeight: s.leading > 0 ? `${s.leading}px` : "1.2", textAlign: s.align };
  const shadow = s.shadowEnabled ? `drop-shadow(${s.shadowDistance * 0.7}px ${s.shadowDistance * 0.7}px ${s.shadowSoftness / 2}px ${rgba(s.shadowColor, s.shadowOpacity)})` : "none";
  return (
    <div class="stage-cap" style={{
      left: `${s.positionX * 100}%`, top: `${s.positionY * 100}%`,
      transform: `translate(-50%, -50%) translateY(${dy}px) scale(${scale})`, opacity, filter: shadow,
      background: s.backgroundEnabled ? rgba(s.background, s.backgroundOpacity) : "transparent",
      padding: s.backgroundEnabled ? `${s.padding}px` : 0, borderRadius: s.backgroundEnabled ? `${Math.round(s.padding * 0.6)}px` : 0,
      ...font,
    }}>
      <div style={{ position: "relative" }}>
        {s.strokeEnabled && s.strokeWidth > 0 ? (
          <div class="layer-stroke" aria-hidden="true" style={{ color: s.stroke, WebkitTextStroke: `${s.strokeWidth}px ${s.stroke}` }}>{lineEls("stroke")}</div>
        ) : null}
        <div class="layer-fill" style={{ color: s.fill, position: "relative" }}>{lineEls("fill")}</div>
      </div>
    </div>
  );
}

export function Preview() {
  const store = getStore();
  const p = useStore((s) => s.project)!;
  const t = useStore((s) => s.previewTime);
  const playing = useStore((s) => s.playing);
  const all = useMemo(() => views(p), [p]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const first = all[0]?.start ?? 0;
  const last = all.length ? all[all.length - 1].end : 1;
  const span = Math.max(0.01, last - first);

  // real-time playback driven by the clock, so timing matches the timestamps
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const t0 = performance.now();
    const start = store.state.previewTime >= last ? first : store.state.previewTime;
    const tick = () => {
      const now = start + (performance.now() - t0) / 1000;
      if (now >= last + 0.4) {
        store.set({ previewTime: last, playing: false });
        return;
      }
      store.set({ previewTime: now });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // keep the selected caption in sync with the playhead
  const active = all.find((v) => t >= v.start && t < v.end) ?? null;
  useEffect(() => {
    if (playing && active && store.state.selectedId !== active.id) store.set({ selectedId: active.id });
  }, [active?.id, playing]);

  const W = p.source.width || 1920;
  const H = p.source.height || 1080;
  const k = width / W;
  const scrub = (e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      store.set({ previewTime: first + x * span, playing: false });
    };
    move(e);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div class="card">
      <div class="card-head">
        <span class="card-title">Preview</span>
        <span class="faint small" style={{ marginLeft: "auto" }}>{W}×{H}</span>
      </div>
      <div class="stage-wrap" ref={wrapRef}>
        <div class="stage" style={{ height: `${Math.round(H * k)}px` }} aria-label="Caption animation preview">
          <div class="stage-inner" style={{ width: `${W}px`, height: `${H}px`, transform: `scale(${k})` }}>
            {active ? <CaptionRender p={p} v={active} t={t} /> : null}
          </div>
          <div class="stage-safe" />
          <div class="stage-time">{formatTimecode(t, p.source.compStartTime)}</div>
        </div>
      </div>
      <div class="transport">
        <button class="btn btn-primary icon-btn" aria-label={playing ? "Pause preview" : "Play preview"} title="Play / pause (Space)"
          onClick={() => {
            if (!playing) {
              const sel = all.find((v) => v.id === store.state.selectedId);
              const cur = store.state.previewTime;
              if (sel && (cur < sel.start || cur >= sel.end)) store.set({ previewTime: sel.start });
            }
            store.set({ playing: !playing });
          }}>
          {playing ? Icon.pause() : Icon.play()}
        </button>
        <div class="scrub" onMouseDown={scrub} role="slider" aria-label="Preview position" aria-valuemin={first} aria-valuemax={last} aria-valuenow={t} tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") store.set({ previewTime: Math.min(last, t + 0.1) });
            if (e.key === "ArrowLeft") store.set({ previewTime: Math.max(first, t - 0.1) });
          }}>
          <div class="scrub-track" />
          <div class="scrub-caps">
            {all.length < 2000 ? all.map((v) => (
              <i key={v.id} style={{ left: `${((v.start - first) / span) * 100}%`, width: `${Math.max(0.2, ((v.end - v.start) / span) * 100)}%`, background: v.id === active?.id ? "var(--accent)" : undefined }} />
            )) : null}
          </div>
          <div class="scrub-head" style={{ left: `${((Math.min(Math.max(t, first), last) - first) / span) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
