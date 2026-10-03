// Render the spot frame by frame (exact timeline, no realtime capture) and encode MP4.
import { chromium } from "/home/user/auto-caption/extension/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { routeFonts } from "./fontroute.mjs";
const FPS = 30, out = process.argv[2] || "AutoCaptionAE_Spot_1080x1920.mp4";
const audio = process.argv[3] || "audio/mix.wav";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
await routeFonts(page);
await page.goto("file://" + process.cwd() + "/autocaption-spot.html?render=1");
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => window.__fit());
const DUR = await page.evaluate(() => window.__dur);
const ff = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-", "-i", audio,
  "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart",
  "-metadata", "title=AutoCaption AE", out], { stdio: ["pipe", "inherit", "inherit"] });
const total = Math.round(FPS * DUR);
for (let f = 0; f < total; f++) {
  await page.evaluate((t) => window.__render(t), f / FPS);
  const buf = await page.screenshot({ type: "png" });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if (f % 120 === 0) console.log(`frame ${f}/${total}`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
await browser.close();
console.log("wrote", out);
