import { chromium } from "/home/user/auto-caption/extension/node_modules/playwright/index.mjs";
import { routeFonts } from "./fontroute.mjs";
const times = process.argv.slice(2).map(Number);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, ignoreHTTPSErrors: false });
await routeFonts(page);
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
await page.goto("file://" + process.cwd() + "/autocaption-spot.html?render=1");
await page.evaluate(() => document.fonts.ready);
console.log("fit:", await page.evaluate(() => { window.__fit(); return [...document.querySelectorAll("[data-fit]")].map(e => (e.id || e.className) + "=" + e.dataset.fit).join(" "); }));
console.log("fonts:", await page.evaluate(() => [...document.fonts].filter(f => f.status === "loaded").map(f => f.family + " " + f.weight).join(", ")));
for (const t of times) {
  await page.evaluate((tt) => window.__render(tt), t);
  await page.screenshot({ path: `frame-${t.toFixed(2)}.png` });
}
console.log("errors:", errs);
await browser.close();
