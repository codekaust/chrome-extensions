// Pure-Node PNG icon generator for TabLoop.
// A dark squircle with a cyan refresh-loop arc (open ring + arrowhead). No
// dependencies — PNGs are encoded by hand via node:zlib.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");

const TOP = [47, 49, 56]; // #2F3138 slate
const BOT = [24, 25, 29]; // #18191D near-black
const ACCENT = [34, 211, 238]; // #22D3EE cyan

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function inSquircle(u, v) {
  const x = Math.abs(u - 0.5) / 0.46;
  const y = Math.abs(v - 0.5) / 0.46;
  return Math.pow(x, 4) + Math.pow(y, 4) <= 1;
}

// Ring geometry: an open circular arc (a gap near the bottom-right) with an
// arrowhead at the tip, read as a stylized "reload/loop" glyph.
const RING_IN = 0.22;
const RING_OUT = 0.32;
const RING_MID = (RING_IN + RING_OUT) / 2;
const GAP_START_DEG = 0;
const GAP_END_DEG = 80;

const TIP_PHI = 0; // radians — where the arc ends and the arrowhead sits
const tangent = [-Math.sin(TIP_PHI), Math.cos(TIP_PHI)];
const normal = [Math.cos(TIP_PHI), Math.sin(TIP_PHI)];
const tipBase = [0.5 + normal[0] * RING_MID, 0.5 + normal[1] * RING_MID];
const ARROW_LEN = 0.16;
const ARROW_BACK = 0.05;
const ARROW_WIDTH = 0.09;

const arrowTip = [tipBase[0] + tangent[0] * ARROW_LEN, tipBase[1] + tangent[1] * ARROW_LEN];
const arrowBaseCenter = [tipBase[0] - tangent[0] * ARROW_BACK, tipBase[1] - tangent[1] * ARROW_BACK];
const arrowLeft = [arrowBaseCenter[0] + normal[0] * ARROW_WIDTH, arrowBaseCenter[1] + normal[1] * ARROW_WIDTH];
const arrowRight = [arrowBaseCenter[0] - normal[0] * ARROW_WIDTH, arrowBaseCenter[1] - normal[1] * ARROW_WIDTH];

function sign(p1, p2, p3) {
  return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
}
function pointInTriangle(pt, v1, v2, v3) {
  const d1 = sign(pt, v1, v2), d2 = sign(pt, v2, v3), d3 = sign(pt, v3, v1);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function sample(u, v) {
  if (!inSquircle(u, v)) return { a: 0, color: [0, 0, 0] };
  let color = mix(TOP, BOT, v);

  const dx = u - 0.5, dy = v - 0.5;
  const r = Math.hypot(dx, dy);
  let phiDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (phiDeg < 0) phiDeg += 360;

  const inRing = r >= RING_IN && r <= RING_OUT;
  const inGap = phiDeg > GAP_START_DEG && phiDeg < GAP_END_DEG;
  if (inRing && !inGap) color = ACCENT;
  if (pointInTriangle([u, v], arrowTip, arrowLeft, arrowRight)) color = ACCENT;

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
