import { DEFAULTS, computeGeometry } from "./popper.js";

async function getSettings() {
  const stored = await chrome.storage.sync.get(["settings", "remembered"]);
  return {
    settings: { ...DEFAULTS, ...(stored.settings || {}) },
    remembered: stored.remembered || null,
  };
}

async function getScreen() {
  // display info is the most reliable; fall back to a sane default.
  try {
    const displays = await chrome.system.display.getInfo();
    const primary = displays.find((d) => d.isPrimary) || displays[0];
    if (primary) {
      return {
        left: primary.workArea.left,
        top: primary.workArea.top,
        width: primary.workArea.width,
        height: primary.workArea.height,
      };
    }
  } catch {
    // system.display not available (permission not granted) — use current window.
  }
  return null;
}

async function popCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const { settings, remembered } = await getSettings();
  const sourceWin = await chrome.windows.get(tab.windowId).catch(() => null);
  const screen =
    (await getScreen()) ||
    (sourceWin
      ? { left: sourceWin.left, top: sourceWin.top, width: sourceWin.width, height: sourceWin.height }
      : { left: 0, top: 0, width: 1440, height: 900 });

  const geom = computeGeometry(settings, screen, sourceWin, remembered);

  const win = await chrome.windows.create({
    tabId: tab.id,
    type: "popup",
    focused: settings.focus,
    ...geom,
  });

  if (settings.position === "remember" && win) {
    // Persist wherever the user ends up dragging it.
    chrome.storage.sync.set({ remembered: { left: win.left, top: win.top } });
  }
}

chrome.action.onClicked.addListener(() => {
  popCurrentTab();
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "pop-tab") popCurrentTab();
});

// Remember the position of PopIt-created popups as they move.
chrome.windows.onBoundsChanged?.addListener(async (win) => {
  if (win.type !== "popup") return;
  const { settings } = await getSettings();
  if (settings.position === "remember") {
    chrome.storage.sync.set({ remembered: { left: win.left, top: win.top } });
  }
});
