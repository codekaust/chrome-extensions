// Pure-Node PNG icon generator for PaperTab.
// A warm squircle backdrop holding two stacked sheets of paper — the front
// sheet has a folded dog-ear corner and a few "written" ink lines. No deps.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");

const ROOM_TOP = [232, 178, 128]; // #E8B280 warm terracotta top
const ROOM_BOT = [193, 96, 58]; // #C1603A accent bottom
const PAGE_BACK = [232, 220, 192]; // #E8DCC0
const PAGE_FRONT = [251, 247, 238]; // #FBF7EE
const FLAP = [222, 208, 178]; // #DED0B2
const INK = [138, 122, 99]; // #8A7A63

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

// Triangular corner cut for the folded dog-ear at the top-right of a rect.
function inNotch(u, v, x1, y0, s) {
  const dx = x1 - u;
  const dy = v - y0;
  return dx >= 0 && dy >= 0 && dx + dy <= s;
}

const PAGE_BACK_RECT = [0.24, 0.22, 0.8, 0.82];
const PAGE_FRONT_RECT = [0.18, 0.14, 0.74, 0.76];
const RR = 0.035;
const NOTCH = 0.1;

// Handwritten-note ink strokes: [y, xStart, xEnd]
const LINES = [
  [0.34, 0.26, 0.62],
  [0.45, 0.26, 0.58],
  [0.56, 0.26, 0.44],
];
const LINE_W = 0.022;

function sample(u, v) {
  if (!inSquircle(u, v)) return { a: 0, color: [0, 0, 0] };
  let color = mix(ROOM_TOP, ROOM_BOT, v);

  if (inRoundRect(u, v, ...PAGE_BACK_RECT, RR)) color = PAGE_BACK;

  const [fx0, fy0, fx1, fy1] = PAGE_FRONT_RECT;
  const inFront = inRoundRect(u, v, fx0, fy0, fx1, fy1, RR);
  const inFrontNotch = inNotch(u, v, fx1, fy0, NOTCH);
  if (inFront && !inFrontNotch) color = PAGE_FRONT;
  if (inFrontNotch && u <= fx1 && v >= fy0) color = FLAP;

  if (inFront && !inFrontNotch) {
    for (const [ly, lx0, lx1] of LINES) {
      if (u >= lx0 && u <= lx1 && Math.abs(v - ly) <= LINE_W / 2) color = INK;
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
