// Generates the PWA icons (PNG) without any dependency: a yellow car on ink (the colours of the app, docs/DESIGN.md).
// Run `npm run icons` and commit the result; the output is deterministic.
//   icon-192.png / icon-512.png   rounded square, transparent corners ("any")
//   icon-maskable-512.png         full bleed, glyph inside the safe zone ("maskable")
//   apple-touch-icon.png (180)    full bleed and opaque (iOS adds its own rounding)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const BG = [29, 27, 23];
const FG = [242, 194, 48];
const SAMPLES = 3; // 3x3 supersampling for smooth edges

const circle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

function roundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return circle(x, y, cx, cy, r);
}

function polygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Colour of the car glyph at glyph coordinates, or null for "nothing here". */
function glyph(x, y) {
  let color = null;
  if (roundRect(x, y, 0.12, 0.5, 0.88, 0.7, 0.05)) color = FG; // body
  if (polygon(x, y, [[0.26, 0.5], [0.36, 0.33], [0.64, 0.33], [0.74, 0.5]])) color = FG; // cabin
  if (polygon(x, y, [[0.31, 0.48], [0.385, 0.37], [0.485, 0.37], [0.485, 0.48]])) color = BG; // windows
  if (polygon(x, y, [[0.515, 0.37], [0.615, 0.37], [0.69, 0.48], [0.515, 0.48]])) color = BG;
  for (const cx of [0.3, 0.7]) {
    if (circle(x, y, cx, 0.7, 0.115)) color = BG; // wheel arch
    if (circle(x, y, cx, 0.7, 0.09)) color = FG; // tyre
    if (circle(x, y, cx, 0.7, 0.05)) color = BG;
    if (circle(x, y, cx, 0.7, 0.02)) color = FG; // hub
  }
  return color;
}

/** RGBA of one sample at icon coordinates u, v in [0, 1]. */
function sample(u, v, { scale, rounded }) {
  if (rounded && !roundRect(u, v, 0, 0, 1, 1, 0.2)) return [0, 0, 0, 0];
  const color = glyph(0.5 + (u - 0.5) / scale, 0.54 + (v - 0.5) / scale) ?? BG;
  return [...color, 255];
}

function render(size, options) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let py = 0; py < size; py++) {
    raw[o++] = 0; // PNG filter type 0 (none)
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const [sr, sg, sb, sa] = sample((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size, options);
          r += sr * sa;
          g += sg * sa;
          b += sb * sa;
          a += sa;
        }
      }
      const n = SAMPLES * SAMPLES;
      raw[o++] = a === 0 ? 0 : Math.round(r / a);
      raw[o++] = a === 0 ? 0 : Math.round(g / a);
      raw[o++] = a === 0 ? 0 : Math.round(b / a);
      raw[o++] = Math.round(a / n);
    }
  }
  return raw;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body), body.length + 4);
  return out;
}

function png(size, options) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(render(size, options), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const icons = [
  ['icon-192.png', 192, { scale: 1, rounded: true }],
  ['icon-512.png', 512, { scale: 1, rounded: true }],
  ['icon-maskable-512.png', 512, { scale: 0.78, rounded: false }],
  ['apple-touch-icon.png', 180, { scale: 0.95, rounded: false }],
];
for (const [name, size, options] of icons) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, png(size, options));
  console.log(`wrote ${path.relative(process.cwd(), file)} (${size}x${size})`);
}
