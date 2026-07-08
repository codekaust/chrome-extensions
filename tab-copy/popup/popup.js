import { FORMATS, formatGroups } from "./formats.js";

const DEFAULT_FORMAT = "Markdown";

const els = {
  scopes: document.getElementById("scopes"),
  formats: document.getElementById("formats"),
  currentFormat: document.getElementById("current-format"),
  toggleFormats: document.getElementById("toggle-formats"),
  toast: document.getElementById("toast"),
  openOptions: document.getElementById("open-options"),
  showInfo: document.getElementById("show-info"),
  infoPanel: document.getElementById("info-panel"),
  closeInfo: document.getElementById("close-info"),
};

let selectedFormat = DEFAULT_FORMAT;

// --- format picker ----------------------------------------------------------

function renderFormats() {
  els.formats.innerHTML = "";
  for (const fmt of FORMATS) {
    const btn = document.createElement("button");
    btn.className = "format-chip";
    btn.textContent = fmt;
    btn.dataset.format = fmt;
    if (fmt === selectedFormat) btn.classList.add("active");
    btn.addEventListener("click", () => setFormat(fmt));
    els.formats.appendChild(btn);
  }
  els.currentFormat.textContent = selectedFormat;
}

function setFormat(fmt) {
  selectedFormat = fmt;
  chrome.storage.sync.set({ defaultFormat: fmt });
  renderFormats();
}

els.toggleFormats.addEventListener("click", () => {
  const collapsed = els.formats.classList.toggle("collapsed");
  els.toggleFormats.setAttribute("aria-expanded", String(!collapsed));
});

// --- gathering tabs ---------------------------------------------------------

function pick(tab) {
  return { title: tab.title || tab.url, url: tab.url || "" };
}

async function gather(scope) {
  if (scope === "tab") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return [{ name: "Tab", tabs: [pick(tab)] }];
  }
  if (scope === "selected") {
    const tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
    return [{ name: "Selected", tabs: tabs.map(pick) }];
  }
  if (scope === "window") {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return [{ name: "Window", tabs: tabs.map(pick) }];
  }
  if (scope === "all") {
    const tabs = await chrome.tabs.query({});
    return [{ name: "All", tabs: tabs.map(pick) }];
  }
  if (scope === "all-by-window") {
    const wins = await chrome.windows.getAll({ populate: true });
    return wins.map((w, i) => ({
      name: `Window ${i + 1}`,
      tabs: (w.tabs || []).map(pick),
    }));
  }
  return [];
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for restricted contexts.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

let toastTimer;
function toast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle("error", isError);
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1600);
}

async function doCopy(scope) {
  const groups = (await gather(scope)).filter((g) => g.tabs.length);
  const total = groups.reduce((n, g) => n + g.tabs.length, 0);
  if (!total) {
    toast("No tabs to copy", true);
    return;
  }
  const text = formatGroups(selectedFormat, groups);
  const ok = await copyToClipboard(text);
  if (ok) {
    toast(`Copied ${total} tab${total === 1 ? "" : "s"} as ${selectedFormat}`);
    setTimeout(() => window.close(), 700);
  } else {
    toast("Copy failed", true);
  }
}

els.scopes.addEventListener("click", (e) => {
  const btn = e.target.closest(".scope-btn");
  if (btn) doCopy(btn.dataset.scope);
});

// --- chrome / misc ----------------------------------------------------------

els.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
els.showInfo.addEventListener("click", () => (els.infoPanel.hidden = false));
els.closeInfo.addEventListener("click", () => (els.infoPanel.hidden = true));

(async function init() {
  const { defaultFormat } = await chrome.storage.sync.get("defaultFormat");
  if (defaultFormat && FORMATS.includes(defaultFormat)) selectedFormat = defaultFormat;
  renderFormats();
})();
