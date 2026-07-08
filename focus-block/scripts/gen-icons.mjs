// Pure-Node PNG icon generator for FocusBlock.
// Draws a white bullseye/target on a rounded indigo→blue squircle.
// No external dependencies — encodes PNG via zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const TOP = [79, 70, 229];    // #4F46E5  indigo
const BOT = [37, 99, 235];    // #2563EB  blue
const WHITE = [255, 255, 255];

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

// Rounded-square (squircle) mask via superellipse.
function inSquircle(u, v) {
  const x = Math.abs(u - 0.5) / 0.46;
  const y = Math.abs(v - 0.5) / 0.46;
  return Math.pow(x, 4) + Math.pow(y, 4) <= 1;
}

// Bullseye: two white rings + a solid center dot.
function inTarget(r) {
  const outer = r <= 0.37 && r >= 0.295;
  const inner = r <= 0.215 && r >= 0.14;
  const dot = r <= 0.075;
  return outer || inner || dot;
}

function sample(u, v) {
  if (!inSquircle(u, v)) return { a: 0, color: [0, 0, 0] };
  let color = mix(TOP, BOT, v);
  const r = Math.hypot(u - 0.5, v - 0.5);
  if (inTarget(r)) color = WHITE;
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
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
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
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(size, render(size));
  writeFileSync(join(OUT, `icon${size}.png`), png);
  console.log(`wrote icon${size}.png (${png.length} bytes)`);
}
