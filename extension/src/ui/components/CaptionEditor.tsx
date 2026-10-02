import { memo } from "preact/compat";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import * as E from "../../core/edit";
import type { CaptionView } from "../../core/segment";
import { formatShort, parseTime } from "../../core/timing";
import type { Project, Word } from "../../core/types";
import { Icon } from "../icons";
import { MenuButton } from "./common";
import { getStore, useStore } from "../store";

const SOURCE_LABEL: Record<Word["timingSource"], string> = {
  aligned: "Aligned", inferred: "Inferred", fallback: "Estimated", manual: "Manual",
};

function wordClass(w: Word) {
  return w.timingSource === "inferred" ? "w-inferred" : w.timingSource === "manual" ? "w-manual" : w.timingSource === "fallback" ? "w-fallback" : undefined;
}

function highlight(text: string, q: string) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

function TimeInput(props: { value: number; label: string; onCommit: (v: number) => void }) {
  const [txt, setTxt] = useState(formatShort(props.value));
  useEffect(() => setTxt(formatShort(props.value)), [props.value]);
  const commit = () => {
    const v = parseTime(txt);
    if (Number.isFinite(v) && Math.abs(v - props.value) > 0.0005) props.onCommit(v);
    else setTxt(formatShort(props.value));
  };
  return (
    <input class="input time" aria-label={props.label} value={txt} onInput={(e) => setTxt((e.target as HTMLInputElement).value)}
      onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setTxt(formatShort(props.value)); (e.target as HTMLInputElement).blur(); } }} />
  );
}

function WordTable({ v }: { v: CaptionView }) {
  const store = getStore();
  return (
    <div class="cap-words" onClick={(e) => e.stopPropagation()}>
      {v.words.map((w) => (
        <div class="word-row" key={w.id}>
          <span class={`wt ${wordClass(w) ?? ""}`} title={w.text}>{w.text}</span>
          <TimeInput value={w.start} label={`${w.text} start`} onCommit={(s) => store.apply("Word timing", (p) => E.setWordTiming(p, w.id, s, Math.max(s, w.end)))} />
          <TimeInput value={w.end} label={`${w.text} end`} onCommit={(e2) => store.apply("Word timing", (p) => E.setWordTiming(p, w.id, w.start, e2))} />
          <span class={`badge ${w.timingSource === "aligned" ? "ok" : w.timingSource === "manual" ? "accent" : w.timingSource === "inferred" ? "inferred" : "warn"}`}
            title={w.score !== undefined ? `Alignment confidence ${Math.round(w.score * 100)}%` : undefined}>
            {SOURCE_LABEL[w.timingSource]}
          </span>
        </div>
      ))}
    </div>
  );
}

const CaptionRow = memo(function CaptionRow(props: { v: CaptionView; selected: boolean; playing: boolean; editing: boolean; expanded: boolean; query: string; dim: boolean; last: boolean; compStart: number; noSpaces: boolean; onToggleWords: (id: string) => void }) {
  const { v } = props;
  const store = getStore();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(v.text);

  useEffect(() => {
    if (props.editing) {
      setDraft(v.text);
      setTimeout(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
          ta.style.height = `${ta.scrollHeight}px`;
        }
      }, 0);
    }
  }, [props.editing]);

  const commit = () => {
    if (draft.trim() !== v.text.trim()) store.apply("Edit text", (p) => E.editCaptionText(p, v.id, draft));
    store.set({ editingId: null });
  };
  const splitAtCaret = () => {
    const ta = taRef.current;
    let at = Math.max(1, Math.round(v.words.length / 2));
    if (ta && props.editing) {
      const before = ta.value.slice(0, ta.selectionStart).trim();
      at = before ? E.tokenize(before, props.noSpaces).length : 0;
      if (draft.trim() !== v.text.trim()) store.apply("Edit text", (p) => E.editCaptionText(p, v.id, draft));
    }
    store.apply("Split caption", (p) => E.splitCaption(p, v.id, at));
    store.set({ editingId: null });
  };

  return (
    <div class={`cap${props.selected ? " selected" : ""}${props.playing ? " playing" : ""}${props.dim ? " dim" : ""}`}
      data-cap={v.id} role="listitem" aria-selected={props.selected} tabIndex={props.selected ? 0 : -1}
      onClick={() => { store.set({ selectedId: v.id, previewTime: v.start, playing: false }); }}
      onDblClick={() => store.set({ editingId: v.id, selectedId: v.id })}
      onKeyDown={(e) => {
        if (props.editing) return;
        if (e.key === "Enter") { store.set({ editingId: v.id }); e.preventDefault(); }
        if (e.key === "Delete" || e.key === "Backspace") { store.apply("Delete caption", (p) => E.deleteCaption(p, v.id)); e.preventDefault(); }
      }}>
      <div class="cap-time">
        <button title="Jump to this time in After Effects" onClick={(e) => { e.stopPropagation(); store.jumpTo(v.start); store.set({ selectedId: v.id }); }}>
          {formatShort(v.start + props.compStart)}
        </button>
        <div class="end">{formatShort(v.end + props.compStart)}</div>
      </div>
      {props.editing ? (
        <div class="cap-edit" onClick={(e) => e.stopPropagation()}>
          <textarea ref={taRef} class="input" rows={1} value={draft} aria-label={`Caption ${v.index + 1} text`}
            onInput={(e) => { const ta = e.target as HTMLTextAreaElement; setDraft(ta.value); ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight}px`; }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); commit(); }
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); splitAtCaret(); }
              if (e.key === "Escape") { e.preventDefault(); store.set({ editingId: null }); }
            }}
            onBlur={(e) => { const rt = (e as FocusEvent).relatedTarget as HTMLElement | null; if (!rt?.closest?.(".cap-edit")) commit(); }} />
          <div class="row" style={{ marginTop: 6, gap: 6 }}>
            <span class="faint small grow">Enter to save · Ctrl+Enter splits at the cursor · Esc cancels</span>
            <button class="btn" onMouseDown={(e) => e.preventDefault()} onClick={splitAtCaret} disabled={v.words.length < 2}>{Icon.split({ size: 14 })} Split here</button>
            <button class="btn btn-primary" onMouseDown={(e) => e.preventDefault()} onClick={commit}>Save</button>
          </div>
        </div>
      ) : (
        <>
          <div class="cap-text">
            {v.lines.map((line, li) => (
              <span class="line" key={li}>
                {line.map((w, wi) => (
                  <span key={w.id}>
                    <span class={wordClass(w)} title={w.timingSource !== "aligned" ? `${SOURCE_LABEL[w.timingSource]} timing` : undefined}>
                      {highlight(w.text, props.query)}
                    </span>
                    {wi < line.length - 1 && !props.noSpaces ? " " : ""}
                  </span>
                ))}
              </span>
            ))}
          </div>
          <div class="cap-actions" onClick={(e) => e.stopPropagation()}>
            <button class="btn btn-ghost icon-btn sm" title="Edit text (Enter)" aria-label="Edit text" onClick={() => store.set({ editingId: v.id, selectedId: v.id })}>{Icon.text({ size: 14 })}</button>
            <MenuButton right button={(open, toggle) => (
              <button class="btn btn-ghost icon-btn sm" aria-label="Caption actions" aria-expanded={open} onClick={toggle}>{Icon.more({ size: 14 })}</button>
            )} items={[
              { label: "Split in the middle", icon: Icon.split({ size: 14 }), disabled: v.words.length < 2, run: () => store.apply("Split caption", (p) => E.splitCaption(p, v.id, Math.max(1, Math.round(v.words.length / 2)))) },
              { label: "Merge with next", icon: Icon.merge({ size: 14 }), disabled: props.last, run: () => store.apply("Merge captions", (p) => E.mergeWithNext(p, v.id)) },
              { label: props.expanded ? "Hide word timing" : "Word timing", icon: Icon.clock({ size: 14 }), run: () => props.onToggleWords(v.id) },
              { separator: true, label: "" },
              { label: "Delete caption", icon: Icon.trash({ size: 14 }), run: () => store.apply("Delete caption", (p) => E.deleteCaption(p, v.id)) },
            ]} />
          </div>
        </>
      )}
      {props.expanded && !props.editing ? (
        <div style={{ gridColumn: "1 / 4" }} onClick={(e) => e.stopPropagation()}>
          <div class="row" style={{ gap: 6, margin: "6px 0 0" }}>
            <span class="faint small grow">Caption timing</span>
            <TimeInput value={v.start} label="Caption start" onCommit={(s) => store.apply("Caption timing", (p) => E.setCaptionTiming(p, v.id, s, Math.max(s + 0.05, v.end)))} />
            <TimeInput value={v.end} label="Caption end" onCommit={(en) => store.apply("Caption timing", (p) => E.setCaptionTiming(p, v.id, v.start, en))} />
          </div>
          <WordTable v={v} />
        </div>
      ) : null}
    </div>
  );
});

export function CaptionEditor() {
  const store = getStore();
  const p = useStore((s) => s.project) as Project;
  const selectedId = useStore((s) => s.selectedId);
  const editingId = useStore((s) => s.editingId);
  const search = useStore((s) => s.search);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const t = useStore((s) => (s.playing ? s.previewTime : -1));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => E.views(p), [p]);
  const q = search.trim();
  const matches = useMemo(() => (q ? all.filter((v) => v.text.toLowerCase().includes(q.toLowerCase())) : []), [all, q]);
  const playingId = t >= 0 ? all.find((v) => t >= v.start && t < v.end)?.id : undefined;
  const inferredCount = useMemo(() => p.words.filter((w) => w.timingSource === "inferred" || w.timingSource === "fallback").length, [p.words]);

  // keep the selected caption visible
  useEffect(() => {
    if (!selectedId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cap="${selectedId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const toggleWords = (id: string) => {
    const n = new Set(expanded);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setExpanded(n);
  };

  const goMatch = (dir: 1 | -1) => {
    if (!matches.length) return;
    const i = matches.findIndex((m) => m.id === selectedId);
    const next = matches[(i + dir + matches.length) % matches.length];
    store.set({ selectedId: next.id, previewTime: next.start });
  };

  const onListKey = (e: KeyboardEvent) => {
    if (editingId) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const i = all.findIndex((v) => v.id === selectedId);
    const next = all[Math.max(0, Math.min(all.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      store.set({ selectedId: next.id, previewTime: next.start, playing: false });
      setTimeout(() => listRef.current?.querySelector<HTMLElement>(`[data-cap="${next.id}"]`)?.focus(), 0);
    }
    e.preventDefault();
  };

  const wpl = p.segment.maxWords;
  const custom = ![2, 3, 4, 5, 6].includes(wpl);

  return (
    <div class="card">
      <div class="card-head">
        <span class="card-title">Captions</span>
        <span class="badge">{all.length}</span>
        {p.transcription.aligned ? <span class="badge ok" title="Word timing from forced alignment">Word-aligned</span>
          : <span class="badge warn" title="Forced alignment was not available; word timing is estimated">Estimated timing</span>}
        <span class="grow" />
        <button class="btn btn-ghost icon-btn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo} onClick={() => store.undo()}>{Icon.undo()}</button>
        <button class="btn btn-ghost icon-btn" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!canRedo} onClick={() => store.redo()}>{Icon.redo()}</button>
        <MenuButton right button={(open, toggle) => <button class="btn btn-ghost icon-btn" aria-label="More caption options" aria-expanded={open} onClick={toggle}>{Icon.more()}</button>}
          items={[
            { label: expanded.size ? "Collapse word timing" : "Show word timing for all", icon: Icon.clock({ size: 14 }), run: () => setExpanded(expanded.size ? new Set() : new Set(all.map((v) => v.id))) },
            { label: p.segment.maxLines === 2 ? "Single-line captions" : "Allow two lines", icon: Icon.list({ size: 14 }), run: () => store.setLines(p.segment.maxLines === 2 ? 1 : 2) },
            { label: "Regroup all captions", sub: "Clears manual splits and merges", icon: Icon.refresh({ size: 14 }), run: () => store.apply("Regroup captions", (pp) => E.setGrouping(pp, {}, false)) },
            { separator: true, label: "" },
            { label: "Reset transcription edits", sub: "Restore the original transcript", icon: Icon.undo({ size: 14 }), run: async () => {
              const c = await store.ask("Reset transcription edits?", "All text and timing edits are replaced by the original transcription. You can undo this.", [{ label: "Cancel", kind: "ghost" }, { label: "Reset", kind: "primary" }]);
              if (c === "Reset") store.apply("Reset edits", (pp) => E.resetEdits(pp));
            } },
            ...(!p.transcription.aligned ? [{ label: "Align to selected audio", sub: "Replace estimated timing with real alignment", icon: Icon.wave({ size: 14 }), run: () => store.alignToAudio() }] : []),
          ]} />
      </div>
      <div class="toolbar">
        <div class="search">
          {Icon.search({ size: 14 })}
          <input class="input" placeholder="Search transcript" value={search} aria-label="Search transcript"
            onInput={(e) => store.set({ search: (e.target as HTMLInputElement).value })}
            onKeyDown={(e) => { if (e.key === "Enter") goMatch(e.shiftKey ? -1 : 1); if (e.key === "Escape") store.set({ search: "" }); }} />
          {q ? <span class="count">{matches.length ? `${Math.max(1, matches.findIndex((m) => m.id === selectedId) + 1)}/${matches.length}` : "0"}</span> : null}
        </div>
        <label class="row small muted" style={{ gap: 6, marginLeft: 4 }}>
          <span>Words / line</span>
          <select class="select" style={{ width: 82 }} value={custom ? "custom" : String(wpl)} aria-label="Words per line"
            onChange={async (e) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v === "custom") {
                const n = await store.prompt("Custom words per line", "Maximum words per caption (1–20)", String(wpl), "Apply");
                const k = n ? parseInt(n, 10) : NaN;
                if (k >= 1 && k <= 20) store.setWordsPerLine(k);
              } else store.setWordsPerLine(parseInt(v, 10));
            }}>
            {[2, 3, 4, 5, 6].map((n) => <option value={String(n)} key={n}>{n}</option>)}
            <option value="custom">{custom ? `${wpl} (custom)` : "Custom…"}</option>
          </select>
        </label>
      </div>
      {inferredCount ? (
        <div class="faint small" style={{ padding: "6px 12px 0" }}>
          <span class="w-inferred">Underlined</span> words have estimated timing ({inferredCount}).
        </div>
      ) : null}
      <div class="cap-list" ref={listRef} role="list" aria-label="Captions" onKeyDown={onListKey}>
        {all.length === 0 ? <div class="empty-list">No captions. Undo to restore deleted captions.</div> : all.map((v, i) => (
          <CaptionRow key={v.id} v={v} selected={v.id === selectedId} playing={v.id === playingId} editing={v.id === editingId}
            expanded={expanded.has(v.id)} query={q} dim={!!q && !v.text.toLowerCase().includes(q.toLowerCase())} last={i === all.length - 1}
            compStart={p.source.compStartTime} noSpaces={!!p.transcription.noSpaces} onToggleWords={toggleWords} />
        ))}
      </div>
    </div>
  );
}
