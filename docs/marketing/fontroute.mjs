import { readFileSync } from "node:fs";
const map = Object.fromEntries(readFileSync("fonts/map.txt", "utf8").trim().split("\n").map((l) => l.split(" ")));
export async function routeFonts(page) {
  await page.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: readFileSync("fonts/fonts.css") }));
  await page.route("https://fonts.gstatic.com/**", (r) => {
    const f = map[r.request().url()];
    return f ? r.fulfill({ status: 200, contentType: "font/woff2", body: readFileSync(f), headers: { "access-control-allow-origin": "*" } }) : r.abort();
  });
}
