// Pure-Node PNG icon generator for TabCopy.
// Draws a layered "copy" glyph (back frame + front sheet) in white on a
// rounded teal->emerald squircle. No external dependencies.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");

const TOP = [45, 212, 191]; // #2DD4BF teal
const BOT = [16, 152, 118]; // #109876 emerald
const WHITE = [255, 255, 255];

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function inSquircle(u, v) {
  const x = Math.abs(u - 0.5) / 0.46;
  const y = Math.abs(v - 0.5) / 0.46;
  return Math.pow(x, 4) + Math.pow(y, 4) <= 1;
}

// Rounded rect membership (corner radius rr in normalized units).
function inRoundRect(u, v, x0, y0, x1, y1, rr) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + rr), x1 - rr);
  const cy = Math.min(Math.max(v, y0 + rr), y1 - rr);
  return Math.hypot(u - cx, v - cy) <= rr || (u >= x0 + rr && u <= x1 - rr) || (v >= y0 + rr && v <= y1 - rr);
}

// Back sheet (top-left) and front sheet (bottom-right), offset diagonally.
const BACK = [0.28, 0.22, 0.62, 0.66];
const FRONT = [0.4, 0.36, 0.74, 0.8];
const RR = 0.06;
const TW = 0.055; // frame thickness

function inFront(u, v) {
  return inRoundRect(u, v, FRONT[0], FRONT[1], FRONT[2], FRONT[3], RR);
}
function inFrontInner(u, v) {
  return inRoundRect(u, v, FRONT[0] + TW, FRONT[1] + TW, FRONT[2] - TW, FRONT[3] - TW, RR * 0.6);
}
function inBack(u, v) {
  return inRoundRect(u, v, BACK[0], BACK[1], BACK[2], BACK[3], RR);
}
function inBackInner(u, v) {
  return inRoundRect(u, v, BACK[0] + TW, BACK[1] + TW, BACK[2] - TW, BACK[3] - TW, RR * 0.6);
}

function sample(u, v) {
  if (!inSquircle(u, v)) return { a: 0, color: [0, 0, 0] };
  let color = mix(TOP, BOT, v);

  // Back frame: white outline, but only where the front sheet doesn't cover it.
  const backFrame = inBack(u, v) && !inBackInner(u, v);
  if (backFrame && !inFront(u, v)) color = WHITE;

  // Front sheet: solid white with a couple of faint "lines" (gaps) for a page feel.
  if (inFront(u, v)) {
    color = WHITE;
    if (inFrontInner(u, v)) {
      // draw two accent lines inside the front page
      const rel = (v - (FRONT[1] + TW)) / (FRONT[3] - FRONT[1] - 2 * TW);
      const nearLine = Math.abs(rel - 0.35) < 0.06 || Math.abs(rel - 0.62) < 0.06;
      color = nearLine ? mix(TOP, BOT, v) : WHITE;
    }
  }
  return { a: 1, color };
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const s = sample(u, v);
          r += s.color[0] * s.a; g += s.color[1] * s.a; b += s.color[2] * s.a; a += s.a;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const idx = (y * size + x) * 4;
      if (alpha > 0) {
        buf[idx] = Math.round(r / a);
        buf[idx + 1] = Math.round(g / a);
        buf[idx + 2] = Math.round(b / a);
        buf[idx + 3] = Math.round(alpha * 255);
      } else buf[idx + 3] = 0;
    }
  }
  return buf;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(size, render(size));
  writeFileSync(join(OUT, `icon${size}.png`), png);
  console.log(`wrote icon${size}.png (${png.length} bytes)`);
}
