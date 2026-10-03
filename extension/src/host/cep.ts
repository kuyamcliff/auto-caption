// CEP implementation of the platform: ExtendScript bridge + CEP's bundled
// Node.js (enabled by --enable-nodejs; the user never installs Node).

import type { BackendProcess, Files, HostBridge, HostResult, Platform, SelfTestRow } from "./platform";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const window: any;

function nodeRequire(name: string): any {
  const r = window.require || (window.cep_node && window.cep_node.require);
  if (!r) throw new Error("Node.js integration is not enabled for this panel.");
  return r(name);
}

/** Serialise for ExtendScript (ES3): U+2028/2029 are line terminators there. */
function lit(v: unknown): string {
  return JSON.stringify(v).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function evalScript<T>(code: string): Promise<HostResult<T>> {
  return new Promise((resolve) => {
    window.__adobe_cep__.evalScript(code, (res: string) => {
      if (!res || res === "EvalScript error.") {
        resolve({ ok: false, code: "HOST_SCRIPT", message: "After Effects could not run the AutoCaption host script." });
        return;
      }
      try {
        resolve(JSON.parse(res));
      } catch {
        resolve({ ok: false, code: "HOST_SCRIPT", message: "Unexpected reply from After Effects.", detail: String(res).slice(0, 300) });
      }
    });
  });
}

let hostScriptLoaded = false;
async function call<T>(fn: string, ...args: unknown[]): Promise<HostResult<T>> {
  if (!hostScriptLoaded) {
    // ScriptPath in the manifest loads host.jsx; reload explicitly if AE dropped it.
    const probe = await evalScript<object>("typeof AutoCaption === 'object' ? '{\"ok\":true}' : '{\"ok\":false,\"code\":\"x\",\"message\":\"\"}'");
    if (!probe.ok) {
      const path = window.__adobe_cep__.getSystemPath("extension") + "/host/host.jsx";
      await evalScript<object>(`$.evalFile(${lit(path)}); '{"ok":true}'`);
    }
    hostScriptLoaded = true;
  }
  return evalScript<T>(`AutoCaption.${fn}(${args.map(lit).join(",")})`);
}

const host: HostBridge = {
  getSelection: () => call("getSelection"),
  layerState: (compId, indices) => call("layerState", compId, indices),
  renderAudio: (compId, idx, outDir) => call("renderAudio", { compId, layerIndices: idx, outDir }),
  cleanupTemp: () => call("cleanupTemp"),
  existingCaptions: (compId) => call("existingCaptions", compId),
  createLayers: (plan, opts) => call("createLayers", plan, opts),
  jumpTo: (compId, t) => call("jumpTo", compId, t),
  getFonts: () => call("getFonts"),
  info: () => call("info"),
  theme: () => {
    try {
      const env = JSON.parse(window.__adobe_cep__.getHostEnvironment());
      const c = env.appSkinInfo.panelBackgroundColor.color;
      const h = (n: number) => Math.round(n).toString(16).padStart(2, "0");
      return { background: `#${h(c.red)}${h(c.green)}${h(c.blue)}` };
    } catch {
      return null;
    }
  },
};

function makeFiles(): Files {
  const fs = nodeRequire("fs");
  const path = nodeRequire("path");
  const os = nodeRequire("os");
  const cp = nodeRequire("child_process");
  const fsp = fs.promises;
  const win = process.platform === "win32";
  const dialogs = window.cep && window.cep.fs;
  return {
    sep: path.sep,
    join: (...p) => path.join(...p),
    dirname: (p) => path.dirname(p),
    async readText(p) {
      try {
        return await fsp.readFile(p, "utf8");
      } catch {
        return null;
      }
    },
    async writeText(p, data) {
      await fsp.mkdir(path.dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, data, "utf8");
      await fsp.rename(tmp, p);
    },
    async exists(p) {
      try {
        await fsp.access(p);
        return true;
      } catch {
        return false;
      }
    },
    async isDir(p) {
      try {
        return (await fsp.stat(p)).isDirectory();
      } catch {
        return false;
      }
    },
    mkdir: async (p) => void (await fsp.mkdir(p, { recursive: true })),
    remove: async (p) => {
      try {
        await fsp.rm(p, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    },
    list: async (p) => {
      try {
        return await fsp.readdir(p);
      } catch {
        return [];
      }
    },
    size: async (p) => (await fsp.stat(p)).size,
    async freeBytes(p) {
      try {
        if (fsp.statfs) {
          const s = await fsp.statfs(p);
          return s.bavail * s.bsize;
        }
      } catch {
        /* unsupported */
      }
      return null;
    },
    appDataDir: () => path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "AutoCaptionAE"),
    localDataDir: () => path.join(process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), ".local", "state"), "AutoCaptionAE"),
    tempDir: () => path.join(os.tmpdir(), "AutoCaptionAE"),
    async reveal(p) {
      if (win) cp.spawn("explorer.exe", [p], { detached: true, stdio: "ignore" }).unref();
      else cp.spawn("open", [p], { detached: true, stdio: "ignore" }).unref();
    },
    async chooseFolder(title, initial) {
      if (dialogs?.showOpenDialogEx) {
        const r = dialogs.showOpenDialogEx(false, true, title, initial || "", []);
        return r && r.err === 0 && r.data && r.data.length ? r.data[0] : null;
      }
      const r = await call<{ path: string | null }>("chooseFolder", title);
      return r.ok ? r.path : null;
    },
    async chooseOpenFile(title, exts) {
      const r = dialogs.showOpenDialogEx(false, false, title, "", exts);
      return r && r.err === 0 && r.data && r.data.length ? r.data[0] : null;
    },
    async chooseSaveFile(title, defaultName, ext) {
      const r = dialogs.showSaveDialogEx(title, "", [ext], defaultName, "");
      if (!r || r.err !== 0 || !r.data) return null;
      const out = String(r.data);
      return out.toLowerCase().endsWith(`.${ext}`) ? out : `${out}.${ext}`;
    },
  };
}

// The engine only starts when this panel starts it: every launch carries a
// fresh signed token (see the engine's launchkey.py; same key bytes).
const LAUNCH_KEY_HEX = "6163652d656e67696e652d33663961" + "07" + "6379726971766678" + "11" + "6175746f63617074696f6e";

export function launchToken(crypto: any): string {
  // the key is plain ASCII, so a string key gives the same bytes in every context
  const key = (LAUNCH_KEY_HEX.match(/../g) as string[]).map((h) => String.fromCharCode(parseInt(h, 16))).join("");
  const nonce: string = crypto.randomBytes(16).toString("hex");
  const sig: string = crypto.createHmac("sha256", key).update(`${nonce}:autocaption-engine`).digest("hex");
  return `${nonce}.${sig}`;
}

function makeBackend(files: Files): BackendProcess {
  const cp = nodeRequire("child_process");
  const path = nodeRequire("path");
  const crypto = nodeRequire("crypto");
  let child: any = null;
  const exitHandlers: ((code: number | null) => void)[] = [];
  const exeName = process.platform === "win32" ? "AutoCaption Engine.exe" : "AutoCaption Engine";

  async function executable(dir: string): Promise<string | null> {
    const exe = path.join(dir, exeName);
    return (await files.exists(exe)) && (await files.exists(path.join(dir, "engine.pak"))) ? exe : null;
  }

  function spawnEngine(exe: string, dir: string, args: string[], stdin: "pipe" | "ignore") {
    const env = { ...process.env, AUTOCAPTION_LAUNCH: launchToken(crypto) };
    return cp.spawn(exe, ["--panel", ...args], { cwd: dir, env, windowsHide: true, stdio: [stdin, "pipe", "pipe"] });
  }

  function readLines(stream: any, onLine: (line: string) => void) {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
  }

  return {
    executable,
    running: () => !!child && child.exitCode === null,
    onExit: (cb) => void exitHandlers.push(cb),
    async start(dir) {
      const exe = await executable(dir);
      if (!exe) throw Object.assign(new Error("Engine not found."), { code: "ENGINE_MISSING" });
      if (child && child.exitCode === null) child.kill();
      return new Promise((resolve, reject) => {
        const proc = spawnEngine(exe, dir, [], "pipe");
        child = proc;
        let settled = false;
        let stderr = "";
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            proc.kill();
            reject(Object.assign(new Error("The engine did not start within 60 seconds."), { code: "ENGINE_TIMEOUT", detail: stderr.slice(-2000) }));
          }
        }, 60000);
        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (d: string) => {
          stderr = (stderr + d).slice(-8000);
        });
        readLines(proc.stdout, (line) => {
          if (settled) return;
          try {
            const msg = JSON.parse(line);
            if (msg.event === "ready") {
              settled = true;
              clearTimeout(timer);
              resolve({ port: msg.port, token: msg.token, pid: msg.pid, version: msg.version });
            }
          } catch {
            /* not a protocol line */
          }
        });
        proc.on("error", (e: Error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(Object.assign(e, { code: "ENGINE_SPAWN", detail: e.message }));
          }
        });
        proc.on("exit", (code: number | null) => {
          if (child === proc) child = null;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(Object.assign(new Error("The engine stopped while starting."), { code: "ENGINE_EXIT", detail: stderr.slice(-2000) }));
          }
          exitHandlers.forEach((h) => h(code));
        });
      });
    },
    async stop() {
      if (child && child.exitCode === null) {
        try {
          child.stdin.end(); // the engine also shuts down when its stdin closes
        } catch {
          /* ignore */
        }
        const c = child;
        setTimeout(() => {
          if (c.exitCode === null) c.kill();
        }, 3000);
      }
    },
    selfTest(dir, onRow, quick) {
      return new Promise(async (resolve, reject) => {
        const exe = await executable(dir);
        if (!exe) {
          reject(Object.assign(new Error("Engine not found."), { code: "ENGINE_MISSING" }));
          return;
        }
        const args = ["--self-test"];
        if (quick) args.push("--quick");
        const proc = spawnEngine(exe, dir, args, "ignore");
        let summary: { ok: boolean; failed: string[] } | null = null;
        let stderr = "";
        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (d: string) => {
          stderr = (stderr + d).slice(-8000);
        });
        readLines(proc.stdout, (line) => {
          try {
            const msg = JSON.parse(line);
            if (msg.summary) summary = msg.summary;
            else if (msg.check) onRow(msg as SelfTestRow);
          } catch {
            /* ignore */
          }
        });
        proc.on("error", (e: Error) => reject(Object.assign(e, { code: "ENGINE_SPAWN", detail: e.message })));
        proc.on("exit", (code: number | null) => {
          if (summary) resolve(summary);
          else reject(Object.assign(new Error(`The engine check stopped unexpectedly (exit ${code}).`), { code: "SELFTEST_CRASH", detail: stderr.slice(-3000) }));
        });
      });
    },
  };
}

export function createCepPlatform(version: string): Platform {
  const files = makeFiles();
  return { kind: "cep", host, files, backend: makeBackend(files), extensionVersion: version };
}
