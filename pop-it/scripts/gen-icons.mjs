// Pure-Node PNG icon generator for PopIt.
// A dark squircle with a white "source" window (lower-left) and a pink popup
// window (upper-right) carrying a white pop-out arrow. No dependencies.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");

const TOP = [47, 49, 56]; // #2F3138 slate
const BOT = [24, 25, 29]; // #18191D near-black
const PINK = [244, 114, 182]; // #F472B6
const WHITE = [255, 255, 255];

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function inSquircle(u, v) {
  const x = Math.abs(u - 0.5) / 0.46;
  const y = Math.abs(v - 0.5) / 0.46;
  return Math.pow(x, 4) + Math.pow(y, 4) <= 1;
}

function inRoundRect(u, v, x0, y0, x1, y1, rr) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + rr), x1 - rr);
  const cy = Math.min(Math.max(v, y0 + rr), y1 - rr);
  return (
    Math.hypot(u - cx, v - cy) <= rr ||
    (u >= x0 + rr && u <= x1 - rr) ||
    (v >= y0 + rr && v <= y1 - rr)
  );
}

const BACK = [0.16, 0.36, 0.58, 0.8]; // source window (lower-left)
const FRONT = [0.42, 0.18, 0.84, 0.6]; // popup (upper-right)
const RR = 0.055;
const TW = 0.05;

function frame(u, v, r) {
  const out = inRoundRect(u, v, r[0], r[1], r[2], r[3], RR);
  const inn = inRoundRect(u, v, r[0] + TW, r[1] + TW, r[2] - TW, r[3] - TW, RR * 0.5);
  return out && !inn;
}

// distance from point to segment (a->b)
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Pop-out arrow inside the popup: shaft from lower-left to upper-right + head.
const A0 = [0.53, 0.49];
const A1 = [0.73, 0.29];
const ARROW_W = 0.032;
function onArrow(u, v) {
  if (segDist(u, v, A0[0], A0[1], A1[0], A1[1]) <= ARROW_W) return true;
  // two head flanges from the tip
  if (segDist(u, v, A1[0], A1[1], A1[0] - 0.13, A1[1]) <= ARROW_W) return true;
  if (segDist(u, v, A1[0], A1[1], A1[0], A1[1] + 0.13) <= ARROW_W) return true;
  return false;
}

function sample(u, v) {
  if (!inSquircle(u, v)) return { a: 0, color: [0, 0, 0] };
  let color = mix(TOP, BOT, v);

  // back window frame (white) where the popup doesn't overlap
  const inFront = inRoundRect(u, v, FRONT[0], FRONT[1], FRONT[2], FRONT[3], RR);
  if (frame(u, v, BACK) && !inFront) color = WHITE;

  // popup: solid pink, with a white arrow cut into it
  if (inFront) {
    color = onArrow(u, v) ? WHITE : PINK;
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
