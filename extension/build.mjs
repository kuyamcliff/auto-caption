// Builds the CEP extension folder: dist/extension (no Node/npm needed at runtime).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const out = process.argv[2] || "dist/extension";
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/js`, { recursive: true });

await build({
  entryPoints: ["src/ui/main.tsx"],
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ["chrome88"],
  format: "iife",
  jsx: "automatic",
  jsxImportSource: "preact",
  outfile: `${out}/js/app.js`,
  legalComments: "eof",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});

cpSync("index.html", `${out}/index.html`);
cpSync("CSXS", `${out}/CSXS`, { recursive: true });
cpSync("host", `${out}/host`, { recursive: true });

// 23x23 panel icon: rounded accent square with caption lines, drawn as RGBA PNG.
function png(size, draw) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const v of buf) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
mkdirSync(`${out}/icons`, { recursive: true });
writeFileSync(`${out}/icons/icon.png`, png(23, (x, y) => {
  const inside = x >= 2 && x <= 20 && y >= 2 && y <= 20 && !((x < 4 || x > 18) && (y < 4 || y > 18));
  if (!inside) return [0, 0, 0, 0];
  const line = (y === 8 && x >= 6 && x <= 13) || (y === 11 && x >= 6 && x <= 17) || (y === 14 && x >= 6 && x <= 14);
  return line ? [255, 255, 255, 255] : [59, 142, 234, 255];
}));

const size = readFileSync(`${out}/js/app.js`).length;
console.log(`extension built: ${out} (app.js ${(size / 1024).toFixed(1)} KB)`);
