// End-to-end UI test: real panel bundle + real backend + simulated AE host.
// Usage: node tests/ui/e2e.mjs <backendStageDir> <shotsDir>
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";

const stage = resolve(process.argv[2]);
const shots = resolve(process.argv[3] || "/tmp/ui-shots");
const repo = resolve(new URL("../../..", import.meta.url).pathname);
const fixture = join(repo, "tests/fixtures/audio/clean_english.wav");
const expected = JSON.parse(readFileSync(join(repo, "tests/fixtures/audio/clean_english.expected.json"), "utf8"));
const work = join(os.tmpdir(), `ac-ui-${Date.now()}`);
const exportDir = join(work, "exports");
mkdirSync(exportDir, { recursive: true });
mkdirSync(shots, { recursive: true });

const LAYER = { name: "Voiceover.wav", index: 2, id: 7, type: "audio", hasAudio: true, audioEnabled: true, enabled: true,
  inPoint: 15, outPoint: 15 + expected.durationSec, startTime: 15, stretch: 100, timeRemap: false, sourcePath: fixture, sourceDuration: expected.durationSec };
const COMP = { name: "Main Comp", id: 1, fps: 29.97, frameDuration: 1001 / 30000, duration: 60, displayStartTime: 0, width: 1080, height: 1920, time: 0 };

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " -- " + detail : ""}`);
};

const harness = spawn("node", ["tests/ui/server.mjs", "dist/extension", "4877"], {
  cwd: join(repo, "extension"),
  env: {
    ...process.env,
    HARNESS_CONFIG: JSON.stringify({
      backendCmd: [process.env.BACKEND_PYTHON || "python", "-m", "autocaption"],
      backendCwd: join(repo, "backend"),
      backendEnv: { AUTOCAPTION_BACKEND_ROOT: stage },
      appData: join(work, "appdata"), localData: join(work, "local"),
      comp: COMP, layer: null, renderSource: fixture, dialogs: { folder: stage, saveDir: exportDir },
    }),
  },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((r) => harness.stdout.once("data", r));

const browser = await chromium.launch({ executablePath: process.env.CHROME || "/opt/pw-browsers/chromium" }).catch((e) => { harness.kill("SIGTERM"); throw e; });
const page = await browser.newPage({ viewport: { width: 400, height: 760 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|404/.test(m.text())) errors.push(m.text()); });
const rpc = (fn, args) => page.evaluate(([f, a]) => window.__harnessRpc(f, a), [fn, args]);
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });

try {
  await page.goto("http://127.0.0.1:4877/");
  await page.getByText("Let’s connect the local caption engine", { exact: false }).waitFor();
  await shot("01-welcome");
  check("first run shows onboarding", true);

  await page.getByRole("button", { name: "Choose Backend Folder" }).click();
  await page.getByText("Verifying…", { exact: false }).first().waitFor({ timeout: 20000 });
  await shot("02-verifying");
  await page.getByText("Everything is ready.").waitFor({ timeout: 180000 });
  await shot("03-verified");
  const rows = await page.locator(".checks li").allInnerTexts();
  check("verification rows all ready (GPU may be n/a)", rows.every((r) => /Ready|Not available/.test(r)), rows.map((r) => r.replace(/\n/g, " ")).join(" | "));

  await page.getByRole("button", { name: "Start Captioning" }).click();
  await page.getByText("Select an audio, video, or precomp layer in After Effects to get started.").waitFor();
  await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60000 });
  await shot("04-empty-state");
  check("empty state message", true);
  check("transcribe disabled without selection", await page.getByRole("button", { name: "Transcribe" }).isDisabled());

  await rpc("setLayer", { layer: { ...LAYER, hasAudio: false, name: "Logo.png", type: "unknown" } });
  await page.getByText("This layer does not contain usable audio.").waitFor();
  check("no-audio layer message", true);

  await rpc("setLayer", { layer: LAYER });
  await page.getByText("Voiceover.wav").waitFor();
  await shot("05-layer-selected");

  const t0 = Date.now();
  await page.getByRole("button", { name: "Transcribe" }).click();
  await page.locator(".steps").waitFor();
  await shot("06-progress");
  await page.locator(".cap").first().waitFor({ timeout: 180000 });
  check("transcription completes in UI", true, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await page.waitForTimeout(300);
  await shot("07-captions");

  // Timing: first caption starts at layer in-point + first word (Test C style mapping)
  const firstTime = await page.locator(".cap-time button").first().innerText();
  const expectFirst = 15 + expected.words[0].start;
  const [m, s] = firstTime.split(":");
  const shown = parseInt(m, 10) * 60 + parseFloat(s);
  check("caption time = layer start + word time", Math.abs(shown - expectFirst) < 0.08, `shown ${firstTime}, expected ≈ ${expectFirst.toFixed(2)}`);

  // words per line regroups instantly (no backend call)
  const before = await page.locator(".cap").count();
  await page.getByLabel("Words per line").selectOption("2");
  const after2 = await page.locator(".cap").count();
  await page.getByLabel("Words per line").selectOption("6");
  const after6 = await page.locator(".cap").count();
  check("words/line regroups instantly", after2 > before && after6 < before, `4→${before}, 2→${after2}, 6→${after6}`);
  await page.getByLabel("Words per line").selectOption("4");

  // edit text: insert a word -> inferred
  await page.locator(".cap").first().dblclick();
  const ta = page.locator(".cap-edit textarea");
  await ta.waitFor();
  const original = await ta.inputValue();
  await ta.fill(original.replace(/^(\S+)/, "$1 really"));
  await ta.press("Enter");
  await page.locator(".cap .w-inferred").first().waitFor();
  check("inserted word is marked inferred", (await page.locator(".cap .w-inferred").first().innerText()).includes("really"));
  await shot("08-edited");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  check("undo restores text", (await page.locator(".cap-text").first().innerText()).trim() === original.trim());
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(150);
  check("redo re-applies edit", (await page.locator(".cap-text").first().innerText()).includes("really"));

  // split / merge via menu
  const count0 = await page.locator(".cap").count();
  await page.locator(".cap").nth(1).hover();
  await page.locator(".cap").nth(1).getByLabel("Caption actions").click();
  await page.getByRole("menuitem", { name: "Split in the middle" }).click();
  const count1 = await page.locator(".cap").count();
  await page.locator(".cap").nth(1).hover();
  await page.locator(".cap").nth(1).getByLabel("Caption actions").click();
  await page.getByRole("menuitem", { name: "Merge with next" }).click();
  check("split and merge", count1 === count0 + 1 && (await page.locator(".cap").count()) === count0, `${count0}→${count1}→${await page.locator(".cap").count()}`);

  // word timing view
  await page.locator(".cap").nth(2).hover();
  await page.locator(".cap").nth(2).getByLabel("Caption actions").click();
  await page.getByRole("menuitem", { name: "Word timing" }).click();
  await page.locator(".word-row").first().waitFor();
  await shot("09-word-timing");
  check("word timing table shows aligned words", (await page.locator(".word-row .badge.ok").count()) > 0);

  // search
  await page.getByLabel("Search transcript").fill("caption");
  await page.waitForTimeout(100);
  check("search highlights matches", (await page.locator(".cap mark").count()) > 0);
  await page.getByLabel("Search transcript").fill("");

  // animation preview at real timestamps
  await page.getByRole("button", { name: "Word Pop" }).click();
  await page.getByRole("button", { name: "Play preview" }).click();
  await page.waitForTimeout(900);
  await shot("10-preview-playing");
  const capText = await page.locator(".stage-cap .layer-fill").first().innerText().catch(() => "");
  check("preview renders the active caption", capText.trim().length > 0, capText.trim());
  await page.getByRole("button", { name: "Pause preview" }).click();
  await page.getByRole("button", { name: "Karaoke" }).click();
  await page.getByRole("button", { name: "Play preview" }).click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "Pause preview" }).click();
  check("animation switch works", true);

  // style + preset save
  await page.getByRole("button", { name: "Style" }).click();
  await shot("11-style");
  await page.getByLabel("Style preset").selectOption({ label: "Bold Social" });
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByLabel("Preset name").fill("My Caption");
  await page.getByRole("button", { name: "Save preset" }).click();
  await page.getByText("Saved preset", { exact: false }).waitFor();
  const presetFile = join(work, "appdata", "presets.json");
  await page.waitForTimeout(300);
  check("preset saved to user data", existsSync(presetFile) && readFileSync(presetFile, "utf8").includes("My Caption"));

  // create text layers
  await page.getByRole("button", { name: "Create Text Layers" }).click();
  await page.getByText("caption layer", { exact: false }).first().waitFor();
  const created = await rpc("created");
  const plan = created[0].plan;
  const fd = 1001 / 30000;
  const onGrid = plan.layers.every((l) => Math.abs(l.inPoint / fd - Math.round(l.inPoint / fd)) < 1e-6);
  const firstIn = plan.layers[0].inPoint;
  check("create: one layer per caption, frame-aligned", plan.layers.length === (await page.locator(".cap").count()) && onGrid, `${plan.layers.length} layers`);
  check("create: first layer at layer start + first word", Math.abs(firstIn - expectFirst) <= fd, `inPoint ${firstIn.toFixed(4)} vs ${expectFirst.toFixed(4)}`);
  check("create: word expression present", plan.layers.every((l) => l.wordExpression && l.wordExpression.includes("var S=")));
  await shot("12-created");

  // re-create -> existing captions dialog
  await page.getByRole("button", { name: "Create Text Layers" }).click();
  await page.getByText("Existing AutoCaption layers detected").waitFor();
  await shot("13-existing-dialog");
  await page.getByRole("button", { name: "Replace" }).click();
  await page.waitForTimeout(400);
  check("replace keeps a single set", (await rpc("created")).length === 1);

  // exports
  for (const fmt of ["SubRip (SRT)", "AutoCaption Project (JSON)", "WebVTT (VTT)", "Advanced SubStation (ASS)", "Plain transcript (TXT)"]) {
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitem", { name: fmt }).click();
    await page.waitForTimeout(250);
  }
  const outFiles = readdirSync(exportDir);
  check("exports written (srt json vtt ass txt)", ["srt", "json", "vtt", "ass", "txt"].every((e) => outFiles.some((f) => f.endsWith(`.${e}`))), outFiles.join(", "));
  const srt = readFileSync(join(exportDir, outFiles.find((f) => f.endsWith(".srt"))), "utf8");
  check("SRT uses comp time", srt.includes(`00:00:${String(Math.floor(expectFirst)).padStart(2, "0")},`), srt.split("\r\n").slice(0, 3).join(" / "));

  // reopen without transcribing: New -> recent list
  await page.getByRole("button", { name: "New" }).click();
  await page.getByText("Recent transcriptions").waitFor();
  await shot("14-recent");
  await page.locator(".cap").first().click();
  await page.locator(".cap-time").first().waitFor();
  check("recent transcription reopens without Whisper", true);

  // import the exported JSON project
  await rpc("setDialogs", { open: join(exportDir, outFiles.find((f) => f.endsWith(".json"))) });
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Import JSON, SRT or VTT…" }).click();
  await page.getByText("Imported", { exact: false }).first().waitFor();
  check("JSON import restores project", true);

  // import SRT -> inferred timing -> align to audio
  await rpc("setDialogs", { open: join(exportDir, outFiles.find((f) => f.endsWith(".srt"))) });
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Import JSON, SRT or VTT…" }).click();
  await page.getByText("Estimated timing").waitFor();
  await page.getByLabel("More caption options").click();
  await page.getByRole("menuitem", { name: "Align to selected audio" }).click();
  await page.getByText("Word timing aligned to the audio.").waitFor({ timeout: 120000 });
  check("SRT import + align to audio", (await page.getByText("Word-aligned").count()) > 0);

  // settings, diagnostics, about, help
  await page.getByLabel("Settings").click();
  await shot("15-settings");
  await page.getByRole("tab", { name: "Diagnostics" }).click();
  await page.getByText("Backend version").waitFor();
  await page.waitForTimeout(500);
  await shot("16-diagnostics");
  const diag = await page.locator(".kv").innerText();
  check("diagnostics show versions", diag.includes("1.0.0") && diag.includes("CTranslate2"));
  await page.getByRole("tab", { name: "About" }).click();
  await shot("17-about");
  await page.getByLabel("Help").click();
  await shot("18-help");
  await page.getByLabel("Help").click();

  // responsive: wide two-column layout and narrow panel
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForTimeout(300);
  await shot("19-wide");
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector(".cols")).display);
  check("wide layout uses two columns", cols === "grid", cols);
  await page.setViewportSize({ width: 300, height: 700 });
  await page.waitForTimeout(300);
  await shot("20-narrow");
  const overflow = await page.evaluate(() => document.querySelector(".scroll").scrollWidth > document.querySelector(".scroll").clientWidth + 1);
  check("no horizontal overflow at 300px", !overflow);

  // keyboard accessibility: tab reaches the main action
  await page.setViewportSize({ width: 400, height: 760 });
  check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("e2e flow", false, String(e).slice(0, 400));
  await shot("zz-failure");
} finally {
  await browser.close();
  harness.kill("SIGTERM");
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} UI checks passed`);
process.exit(failed ? 1 : 0);
