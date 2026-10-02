// Runs host.jsx against a mock After Effects object model. This checks the
// script's logic and API usage paths; it is not a substitute for testing in
// After Effects itself.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { buildPlan } from "../src/core/aeplan";
import { DEFAULT_ANIMATION } from "../src/core/defaults";
import { projectFromResult } from "../src/core/project";
import * as acorn from "acorn";

const SRC = readFileSync(new URL("../host/host.jsx", import.meta.url), "utf8");

class Prop {
  value: unknown;
  expression = "";
  keys: [number, unknown][] = [];
  children = new Map<string, Prop>();
  added: Prop[] = [];
  name = "";
  propertyValueType: number;
  constructor(public matchName: string, value: unknown = 0, pvt = 1) {
    this.value = value;
    this.propertyValueType = pvt;
  }
  property(n: string | number) {
    const key = String(n);
    if (!this.children.has(key)) this.children.set(key, new Prop(key, defaultValue(key), pvtFor(key)));
    return this.children.get(key)!;
  }
  addProperty(n: string) {
    const p = new Prop(n, defaultValue(n), pvtFor(n));
    this.added.push(p);
    return p;
  }
  setValue(v: unknown) { this.value = v; }
  setValueAtTime(t: number, v: unknown) { this.keys.push([t, v]); }
  get numKeys() { return this.keys.length; }
  setTemporalEaseAtKey() { /* recorded implicitly */ }
}
function defaultValue(n: string) {
  if (n === "ADBE Text Document") return { text: "", resetCharStyle() {}, resetParagraphStyle() {} };
  return 0;
}
function pvtFor(n: string) {
  return n === "ADBE Scale" ? 2 : 1;
}

class Layer extends Prop {
  comment = "";
  label = 0;
  locked = false;
  selected = false;
  inPoint = 0;
  outPoint = 10;
  startTime = 0;
  stretch = 100;
  enabled = true;
  solo = false;
  parent: Layer | null = null;
  index = 0;
  removed = false;
  constructor(public comp: Comp, name: string) {
    super("layer");
    this.name = name;
    this.outPoint = comp.duration;
  }
  remove() { this.removed = true; this.comp.layersArr = this.comp.layersArr.filter((l) => l !== this); this.comp.reindex(); }
  moveAfter() {}
  moveToBeginning() {}
  sourceRectAtTime() { return { left: -100, top: -40, width: 200, height: 50 }; }
}
class AVLayer extends Layer {
  hasAudio = false;
  audioEnabled = false;
  timeRemapEnabled = false;
  source: unknown = null;
}
class TextLayer extends AVLayer {}

class Comp {
  layersArr: Layer[] = [];
  name: string;
  comment = "";
  frameRate = 29.97;
  frameDuration = 1001 / 30000;
  displayStartTime = 0;
  width = 1920;
  height = 1080;
  time = 0;
  workAreaStart = 0;
  workAreaDuration = 0;
  removed = false;
  constructor(public id: number, name: string, public duration = 60) { this.name = name; }
  get numLayers() { return this.layersArr.length; }
  layer(i: number) { return this.layersArr[i - 1]; }
  get selectedLayers() { return this.layersArr.filter((l) => l.selected); }
  reindex() { this.layersArr.forEach((l, i) => (l.index = i + 1)); }
  get layers() {
    const add = <T extends Layer>(l: T) => { this.layersArr.unshift(l); this.reindex(); return l; };
    return {
      addText: (t: string) => { const l = add(new TextLayer(this, t)); l.property("ADBE Text Properties").property("ADBE Text Document").value = { text: t, resetCharStyle() {}, resetParagraphStyle() {} }; return l; },
      addNull: () => add(new AVLayer(this, "Null")),
      addShape: () => add(new AVLayer(this, "Shape")),
    };
  }
  duplicate() {
    const c = new Comp(this.id + 1000, `${this.name} copy`, this.duration);
    c.layersArr = this.layersArr.map((l) => Object.assign(Object.create(Object.getPrototypeOf(l)), l, { comp: c }));
    c.reindex();
    env.items.push(c);
    return c;
  }
  remove() { this.removed = true; env.items = env.items.filter((x) => x !== this); }
  openInViewer() {}
}

const env = { items: [] as Comp[], rq: [] as Record<string, unknown>[], files: new Map<string, number>(), renders: 0 };

function makeContext(active: Comp) {
  const outputModule = {
    templates: ["Lossless", "AIFF 48kHz", "High Quality"],
    applied: "",
    file: null as unknown,
    applyTemplate(t: string) { this.applied = t; },
    setSettings() {},
  };
  const rqItems: Record<string, unknown>[] = [{ status: 3015, render: true }];
  const ctx: Record<string, unknown> = {
    CompItem: Comp, AVLayer, TextLayer, FootageItem: class {},
    RQItemStatus: { QUEUED: 3015 },
    PropertyValueType: { TwoD: 2, ThreeD: 3 },
    KeyframeEase: class { constructor(public speed: number, public influence: number) {} },
    ParagraphJustification: { LEFT_JUSTIFY: 1, RIGHT_JUSTIFY: 2, CENTER_JUSTIFY: 3 },
    Folder: class { exists = true; constructor(public fsName: string) {} create() { return true; }
      getFiles() { return [...env.files.keys()].filter((k) => k.startsWith(this.fsName)).map((k) => Object.assign(new (ctx.File as any)(k), { length: env.files.get(k) })); } },
    File: class { length = 0; constructor(public fsName: string) {} },
    app: {
      version: "25.0", project: {
        numItems: 0, activeItem: active,
        itemByID: (id: number) => env.items.find((c) => c.id === id) ?? null,
        item: (i: number) => env.items[i - 1],
        renderQueue: {
          rendering: false,
          get numItems() { return rqItems.length; },
          item: (i: number) => rqItems[i - 1],
          items: { add: (comp: Comp) => {
            const item = { status: 3015, render: true, comp, timeSpanStart: 0, timeSpanDuration: 0, outputModule: () => outputModule,
              remove() { rqItems.splice(rqItems.indexOf(item), 1); } };
            rqItems.push(item);
            return item;
          } },
          render() {
            env.renders++;
            const f = outputModule.file as { fsName: string };
            env.files.set(f.fsName.replace(/\.wav$/, ".aif"), 1234);
          },
        },
      },
      beginUndoGroup() {}, endUndoGroup() {}, beginSuppressDialogs() {}, endSuppressDialogs() {},
    },
  };
  Object.defineProperty((ctx.app as any).project, "numItems", { get: () => env.items.length });
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, rqItems, outputModule, call: (code: string) => JSON.parse(vm.runInContext(code, ctx)) };
}

function setup() {
  env.items = [];
  env.files = new Map();
  const comp = new Comp(1, "Main");
  env.items.push(comp);
  const music = new AVLayer(comp, "Music");
  music.hasAudio = true; music.audioEnabled = true;
  const vo = new AVLayer(comp, "VO");
  vo.hasAudio = true; vo.audioEnabled = false; vo.inPoint = 15; vo.outPoint = 25; vo.startTime = 15; vo.selected = true;
  vo.source = new (class FootageItem {})();
  comp.layersArr = [vo, music];
  comp.reindex();
  return { comp, vo, music, ...makeContext(comp) };
}

describe("host.jsx", () => {
  it("is valid ES3 (ExtendScript)", () => {
    expect(() => acorn.parse(SRC, { ecmaVersion: 3 })).not.toThrow();
  });

  it("reports the selection", () => {
    const { call } = setup();
    const r = call("AutoCaption.getSelection()");
    expect(r.ok).toBe(true);
    expect(r.comp.name).toBe("Main");
    expect(r.layers[0]).toMatchObject({ name: "VO", inPoint: 15, hasAudio: true, audioEnabled: false });
  });

  it("renders audio from a temp duplicate without touching the original", () => {
    const { call, comp, vo, music, rqItems, outputModule } = setup();
    const r = call(`AutoCaption.renderAudio({compId:1, layerIndices:[1], outDir:"/tmp/r1"})`);
    expect(r.ok).toBe(true);
    expect(r.audioOffset).toBe(15); // comp time of audio t=0 = layer in-point
    expect(r.duration).toBe(10);
    expect(r.path).toBe("/tmp/r1/input.aif");
    expect(outputModule.applied).toBe("AIFF 48kHz");
    // originals untouched, temp comp removed, user's queued item restored
    expect(vo.audioEnabled).toBe(false);
    expect(music.audioEnabled).toBe(true);
    expect(env.items).toEqual([comp]);
    expect(rqItems).toHaveLength(1);
    expect(rqItems[0].render).toBe(true);
  });

  it("refuses a missing layer", () => {
    const { call } = setup();
    expect(call(`AutoCaption.renderAudio({compId:1, layerIndices:[9], outDir:"/tmp/r2"})`).code).toBe("LAYER_GONE");
  });

  it("creates frame-accurate caption layers and only replaces its own layers", () => {
    const { call, comp } = setup();
    const words = "one two three four five six".split(" ").map((t, i) => ({ id: `w${i}`, text: t, start: 1 + i * 0.4, end: 1.3 + i * 0.4, timingSource: "aligned" as const }));
    const p = projectFromResult({ schemaVersion: 1, language: "en", aligned: true, durationSec: 5, words, segments: [], warnings: [] },
      { composition: "Main", compId: 1, layers: [], layerType: "audio", fps: 29.97, frameDuration: 1001 / 30000, compStartTime: 0, compDuration: 60, width: 1920, height: 1080, audioOffset: 15, audioDuration: 10, mapping: "render" });
    const plan = buildPlan({ ...p, animation: { ...DEFAULT_ANIMATION, preset: "wordPop" }, style: { ...p.style, shadowEnabled: true, backgroundEnabled: true } }, 1001 / 30000);
    const r = call(`AutoCaption.createLayers(${JSON.stringify(plan)}, {compId:1, mode:"add"})`);
    expect(r.ok).toBe(true);
    expect(r.created).toBe(plan.layers.length);
    const caps = comp.layersArr.filter((l) => l.name.startsWith("Caption") && !l.name.endsWith("BG"));
    expect(caps).toHaveLength(plan.layers.length);
    for (const l of caps) {
      const pl = plan.layers.find((x) => x.name === l.name)!;
      expect(l.inPoint).toBe(pl.inPoint);
      expect(l.outPoint).toBe(pl.outPoint);
      expect(l.comment).toMatch(/^AutoCaptionAE:/);
      const anim = l.property("ADBE Text Properties").property("ADBE Text Animators").added[0];
      const sel = anim.property("ADBE Text Selectors").added[0];
      expect(sel.matchName).toBe("ADBE Text Expressible Selector");
      expect(sel.property("ADBE Text Expressible Amount").expression).toBe(pl.wordExpression);
    }
    expect(comp.layersArr.some((l) => l.name === "AUTO CAPTIONS")).toBe(true);
    const existing = call("AutoCaption.existingCaptions(1)");
    expect(existing.count).toBeGreaterThan(0);
    // replace removes only tagged layers
    const r2 = call(`AutoCaption.createLayers(${JSON.stringify(plan)}, {compId:1, mode:"replace"})`);
    expect(r2.ok).toBe(true);
    expect(comp.layersArr.filter((l) => l.name === "VO" || l.name === "Music")).toHaveLength(2);
    expect(comp.layersArr.filter((l) => l.name === "AUTO CAPTIONS")).toHaveLength(1);
  });

  it("serialises strings safely", () => {
    const { call } = setup();
    const out = call(`AutoCaption._stringify({a:"quote\\" \\u2028 line\\n"}) .length ? '{"ok":true}' : ''`);
    expect(out.ok).toBe(true);
  });
});
