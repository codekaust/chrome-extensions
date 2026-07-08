// Core logic for PopIt, kept separate from the service worker so it can be
// unit-tested in plain Node.

export const DEFAULTS = {
  width: 480,
  height: 640,
  position: "center", // center | top-right | top-left | remember
  focus: true,
};

// Given the settings, the screen bounds, the source window bounds and the last
// remembered geometry, compute the {left, top, width, height} for the popup.
export function computeGeometry(settings, screen, source, remembered) {
  const width = clampDim(settings.width, 200, screen.width);
  const height = clampDim(settings.height, 200, screen.height);

  let left;
  let top;
  const sx = screen.left ?? 0;
  const sy = screen.top ?? 0;

  if (settings.position === "remember" && remembered) {
    left = remembered.left;
    top = remembered.top;
  } else if (settings.position === "top-right") {
    left = sx + screen.width - width - 24;
    top = sy + 24;
  } else if (settings.position === "top-left") {
    left = sx + 24;
    top = sy + 24;
  } else {
    // center over the source window when we know it, else over the screen.
    const base = source || { left: sx, top: sy, width: screen.width, height: screen.height };
    left = Math.round(base.left + (base.width - width) / 2);
    top = Math.round(base.top + (base.height - height) / 2);
  }

  // Keep the window on-screen.
  left = Math.round(Math.min(Math.max(left, sx), sx + screen.width - width));
  top = Math.round(Math.min(Math.max(top, sy), sy + screen.height - height));

  return { left, top, width, height };
}

function clampDim(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.round(Math.min(Math.max(n, min), max));
}
