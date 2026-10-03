// Browser-side test platform (development only). Mirrors src/host/cep.ts, but
// routes Node/AE calls through the harness server's /rpc endpoint.
(function () {
  async function rpc(fn, args) {
    const r = await fetch("/rpc", { method: "POST", body: JSON.stringify({ fn, args }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    return j.out;
  }
  let paths = null;
  let running = false;
  const exitHandlers = [];
  const join = (...p) => p.join("/").replace(/\/+/g, "/");
  const files = {
    sep: "/",
    join,
    dirname: (p) => p.replace(/\/[^/]*$/, ""),
    readText: (p) => rpc("readText", { p }),
    writeText: (p, data) => rpc("writeText", { p, data }),
    exists: (p) => rpc("exists", { p }),
    isDir: (p) => rpc("isDir", { p }),
    mkdir: (p) => rpc("mkdir", { p }),
    remove: (p) => rpc("remove", { p }),
    list: (p) => rpc("list", { p }),
    size: (p) => rpc("size", { p }),
    freeBytes: (p) => rpc("freeBytes", { p }),
    appDataDir: () => paths.appData,
    localDataDir: () => paths.localData,
    tempDir: () => paths.temp,
    reveal: async () => undefined,
    chooseFolder: () => rpc("chooseFolder", {}),
    chooseOpenFile: () => rpc("chooseOpenFile", {}),
    chooseSaveFile: (title, defaultName) => rpc("chooseSaveFile", { defaultName }),
  };
  const host = {
    getSelection: () => rpc("getSelection"),
    layerState: () => rpc("layerState"),
    renderAudio: (compId, idx, outDir) => rpc("renderAudio", { outDir }),
    cleanupTemp: async () => ({ ok: true, removed: 0 }),
    existingCaptions: () => rpc("existingCaptions"),
    createLayers: (plan, opts) => rpc("createLayers", { plan, opts }),
    jumpTo: (compId, t) => rpc("jumpTo", { t }),
    getFonts: async () => ({ ok: true, fonts: [] }),
    info: async () => ({ ok: true, aeVersion: "25.0 (simulated)", build: "" }),
    theme: () => null,
  };
  const backend = {
    executable: (dir) => rpc("backendExe", { dir }),
    async start() { const r = await rpc("backendStart"); running = true; return r; },
    running: () => running,
    async stop() { running = false; await rpc("backendStop"); exitHandlers.forEach((h) => h(0)); },
    async selfTest(dir, onRow, quick) {
      const lines = await rpc("selfTest", { quick });
      let summary = { ok: false, failed: [] };
      for (const l of lines) { if (l.summary) summary = l.summary; else if (l.check) onRow(l); }
      return summary;
    },
    onExit: (cb) => exitHandlers.push(cb),
  };
  // the app reads paths synchronously; fetch them before it boots
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/rpc", false);
  xhr.send(JSON.stringify({ fn: "paths", args: {} }));
  paths = JSON.parse(xhr.responseText).out;
  window.__AUTOCAPTION_PLATFORM__ = { kind: "browser", host, files, backend, extensionVersion: "1.0.0" };
  window.__harnessRpc = rpc;
})();
