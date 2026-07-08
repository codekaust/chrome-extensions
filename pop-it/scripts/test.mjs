// Smoke tests for PopIt geometry. Run: node scripts/test.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const { DEFAULTS, computeGeometry } = await import(join(here, "..", "src", "popper.js"));

const screen = { left: 0, top: 0, width: 1920, height: 1080 };
const source = { left: 100, top: 60, width: 1200, height: 800 };
let pass = 0;

// center over source window
{
  const g = computeGeometry({ ...DEFAULTS, position: "center" }, screen, source, null);
  assert.strictEqual(g.width, 480);
  assert.strictEqual(g.height, 640);
  assert.strictEqual(g.left, Math.round(100 + (1200 - 480) / 2));
  assert.strictEqual(g.top, Math.round(60 + (800 - 640) / 2));
  pass++;
}

// top-right hugs the right edge with a margin
{
  const g = computeGeometry({ ...DEFAULTS, position: "top-right" }, screen, source, null);
  assert.strictEqual(g.left, 1920 - 480 - 24);
  assert.strictEqual(g.top, 24);
  pass++;
}

// remember uses stored coords
{
  const g = computeGeometry({ ...DEFAULTS, position: "remember" }, screen, source, { left: 700, top: 300 });
  assert.strictEqual(g.left, 700);
  assert.strictEqual(g.top, 300);
  pass++;
}

// remember with no stored geometry falls back to center
{
  const g = computeGeometry({ ...DEFAULTS, position: "remember" }, screen, source, null);
  assert.strictEqual(g.left, Math.round(100 + (1200 - 480) / 2));
  pass++;
}

// oversized dimensions clamp to the screen and stay on-screen
{
  const g = computeGeometry({ width: 5000, height: 5000, position: "top-left" }, screen, source, null);
  assert.ok(g.width <= screen.width && g.height <= screen.height, "clamped to screen");
  assert.ok(g.left >= 0 && g.top >= 0, "on-screen");
  pass++;
}

// a popup placed off the right edge gets pulled back on-screen
{
  const g = computeGeometry({ ...DEFAULTS, position: "remember" }, screen, source, { left: 9000, top: 9000 });
  assert.ok(g.left + g.width <= screen.width, "clamped right");
  assert.ok(g.top + g.height <= screen.height, "clamped bottom");
  pass++;
}

console.log(`✓ all ${pass} PopIt assertions passed`);
