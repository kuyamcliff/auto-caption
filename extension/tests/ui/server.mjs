// UI test harness server (development only, never shipped).
// Serves the built panel and exposes the Node-side platform functions over a
// local RPC endpoint, emulating what CEP's embedded Node.js provides. The
// After Effects host is simulated: "rendering" a layer copies a fixture WAV,
// and created layer plans are recorded for assertions.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { promises as fsp, existsSync, statSync, readFileSync } from "node:fs";
import { join, dirname, extname, resolve } from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const root = resolve(process.argv[2] || "dist/extension");
const port = parseInt(process.argv[3] || "4877", 10);
const cfg = JSON.parse(process.env.HARNESS_CONFIG || "{}");
const state = { created: [], jumps: [], backend: null, dialogs: cfg.dialogs || {}, comp: cfg.comp, layer: cfg.layer, renderSource: cfg.renderSource };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };

// Same signed launch token the panel passes (src/host/cep.ts launchToken).
const KEY = "6163652d656e67696e652d33663961" + "07" + "6379726971766678" + "11" + "6175746f63617074696f6e";
function launchEnv() {
  const key = KEY.match(/../g).map((h) => String.fromCharCode(parseInt(h, 16))).join("");
  const nonce = crypto.randomBytes(16).toString("hex");
  const sig = crypto.createHmac("sha256", key).update(`${nonce}:autocaption-engine`).digest("hex");
  return { ...process.env, ...(cfg.backendEnv || {}), AUTOCAPTION_LAUNCH: `${nonce}.${sig}` };
}

function startBackend() {
  return new Promise((res, rej) => {
    const [cmd, ...args] = cfg.backendCmd;
    const p = spawn(cmd, args, { cwd: cfg.backendCwd, env: launchEnv(), stdio: ["pipe", "pipe", "pipe"] });
    state.backend = p;
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      const line = buf.split("\n").find((l) => l.startsWith("{"));
      if (line) {
        const m = JSON.parse(line);
        if (m.event === "ready") res({ port: m.port, token: m.token, pid: m.pid, version: m.version });
      }
    });
    p.stderr.on("data", () => undefined);
    p.on("exit", (c) => rej(new Error(`backend exited ${c}`)));
  });
}

function selfTest(quick) {
  return new Promise((res) => {
    const [cmd, ...args] = cfg.backendCmd;
    const a = [...args, "--self-test"];
    if (quick) a.push("--quick");
    const p = spawn(cmd, a, { cwd: cfg.backendCwd, env: launchEnv() });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", () => undefined);
    p.on("exit", () => res(out.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
  });
}

const rpc = {
  async readText({ p }) { try { return await fsp.readFile(p, "utf8"); } catch { return null; } },
  async writeText({ p, data }) { await fsp.mkdir(dirname(p), { recursive: true }); await fsp.writeFile(p, data); return true; },
  async exists({ p }) { return existsSync(p); },
  async isDir({ p }) { return existsSync(p) && statSync(p).isDirectory(); },
  async mkdir({ p }) { await fsp.mkdir(p, { recursive: true }); return true; },
  async remove({ p }) { await fsp.rm(p, { recursive: true, force: true }); return true; },
  async list({ p }) { try { return await fsp.readdir(p); } catch { return []; } },
  async size({ p }) { return statSync(p).size; },
  async freeBytes({ p }) { try { const s = await fsp.statfs(p); return s.bavail * s.bsize; } catch { return null; } },
  async paths() { return { appData: cfg.appData, localData: cfg.localData, temp: join(os.tmpdir(), "AutoCaptionAE") }; },
  async chooseFolder() { return state.dialogs.folder ?? null; },
  async chooseOpenFile() { return state.dialogs.open ?? null; },
  async chooseSaveFile({ defaultName }) { return state.dialogs.saveDir ? join(state.dialogs.saveDir, defaultName) : null; },
  async setDialogs(d) { Object.assign(state.dialogs, d); return true; },
  async backendExe({ dir }) { return existsSync(join(dir, "engine.pak")) ? join(dir, "AutoCaption Engine") : null; },
  async backendStart() { return startBackend(); },
  async backendStop() { state.backend?.stdin.end(); return true; },
  async selfTest({ quick }) { return selfTest(quick); },
  // ---- simulated After Effects
  async getSelection() {
    if (!state.layer) return { ok: true, comp: state.comp, layers: [], aeVersion: "25.0" };
    return { ok: true, comp: state.comp, layers: [state.layer], aeVersion: "25.0" };
  },
  async setLayer({ layer }) { state.layer = layer; return true; },
  async layerState() { return { ok: true, comp: state.comp, layers: [state.layer] }; },
  async renderAudio({ outDir }) {
    await fsp.mkdir(outDir, { recursive: true });
    const dest = join(outDir, "input.wav");
    await fsp.copyFile(state.renderSource, dest);
    return { ok: true, path: dest, audioOffset: state.layer.inPoint, duration: state.layer.outPoint - state.layer.inPoint };
  },
  async existingCaptions() { return { ok: true, count: state.created.reduce((a, c) => a + c.plan.layers.length, 0), sets: state.created.length }; },
  async createLayers({ plan, opts }) {
    if (opts.mode === "replace") state.created = [];
    state.created.push({ plan, opts });
    return { ok: true, created: plan.layers.length, setName: plan.setName };
  },
  async jumpTo({ t }) { state.jumps.push(t); return { ok: true }; },
  async created() { return state.created; },
  async jumps() { return state.jumps; },
};

createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/rpc") {
    let body = "";
    for await (const c of req) body += c;
    const { fn, args } = JSON.parse(body);
    try {
      const out = await rpc[fn](args || {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, out }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }
  const url = req.url.split("?")[0];
  const file = url === "/" ? join(root, "index.html") : url.startsWith("/harness/") ? join(dirname(new URL(import.meta.url).pathname), url.slice(9)) : join(root, url);
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  let data = readFileSync(file);
  if (file.endsWith("index.html")) {
    // inject the harness platform before the app bundle; relax CSP for the RPC endpoint
    data = Buffer.from(data.toString()
      .replace('<script src="./js/app.js"></script>', '<script src="/harness/harness.js"></script><script src="./js/app.js"></script>')
      .replace("connect-src http://127.0.0.1:*", `connect-src http://127.0.0.1:* http://localhost:${port}`));
  }
  res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
  res.end(data);
}).listen(port, "127.0.0.1", () => console.log(`harness on http://127.0.0.1:${port}`));

process.on("SIGTERM", () => { state.backend?.kill(); process.exit(0); });
