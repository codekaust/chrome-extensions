import { PRESETS, MIN_SECONDS, MAX_SECONDS, clampSeconds, formatInterval, formatCountdown } from "../src/schedule.js";

const presetsEl = document.getElementById("presets");
const customValueEl = document.getElementById("custom-value");
const customUnitEl = document.getElementById("custom-unit");
const toggleEl = document.getElementById("toggle");
const stateEl = document.getElementById("status-state");
const detailEl = document.getElementById("status-detail");

customValueEl.min = MIN_SECONDS;

let tabId = null;
let selectedSeconds = 30;
let active = false;
let nextAt = 0;
let tickTimer = null;

function secondsToValueUnit(seconds) {
  if (seconds % 3600 === 0) return { value: seconds / 3600, unit: 3600 };
  if (seconds % 60 === 0) return { value: seconds / 60, unit: 60 };
  return { value: seconds, unit: 1 };
}

function renderPresets() {
  presetsEl.innerHTML = "";
  for (const preset of PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-btn" + (preset.seconds === selectedSeconds ? " active" : "");
    btn.textContent = preset.label;
    btn.addEventListener("click", () => selectSeconds(preset.seconds));
    presetsEl.appendChild(btn);
  }
}

function selectSeconds(seconds, { syncCustomInputs = true } = {}) {
  selectedSeconds = clampSeconds(seconds);
  if (syncCustomInputs) {
    const { value, unit } = secondsToValueUnit(selectedSeconds);
    customValueEl.value = value;
    customUnitEl.value = String(unit);
  }
  renderPresets();
  if (active) sendMessage({ type: "start", tabId, seconds: selectedSeconds }).then(applyStatus);
}

function renderStatus() {
  if (!active) {
    stateEl.textContent = "Off";
    stateEl.classList.remove("on");
    detailEl.textContent = "Pick an interval and start";
    toggleEl.textContent = "Start";
    toggleEl.classList.remove("stop");
    stopTick();
    return;
  }
  stateEl.textContent = "On";
  stateEl.classList.add("on");
  toggleEl.textContent = "Stop";
  toggleEl.classList.add("stop");
  updateCountdown();
  startTick();
}

function updateCountdown() {
  const remaining = nextAt - Date.now();
  detailEl.textContent =
    remaining > 0
      ? `Refreshing every ${formatInterval(selectedSeconds)} — next in ${formatCountdown(remaining)}`
      : `Refreshing every ${formatInterval(selectedSeconds)} — reloading…`;
}

function startTick() {
  stopTick();
  tickTimer = setInterval(async () => {
    if (Date.now() > nextAt + 1500) {
      // The background alarm should have fired and pushed a new nextAt by now;
      // refresh from source of truth instead of showing a stuck countdown.
      applyStatus(await sendMessage({ type: "status", tabId }));
      return;
    }
    updateCountdown();
  }, 1000);
}

function stopTick() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

function applyStatus(status) {
  active = Boolean(status?.active);
  if (active) {
    selectedSeconds = status.seconds;
    nextAt = status.nextAt;
  }
  renderPresets();
  renderStatus();
}

function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

toggleEl.addEventListener("click", async () => {
  if (active) {
    applyStatus(await sendMessage({ type: "stop", tabId }));
  } else {
    applyStatus(await sendMessage({ type: "start", tabId, seconds: selectedSeconds }));
  }
});

function applyCustomInputs() {
  const value = Number(customValueEl.value);
  const unit = Number(customUnitEl.value);
  if (!Number.isFinite(value) || value <= 0) return;
  selectSeconds(Math.min(MAX_SECONDS, value * unit), { syncCustomInputs: false });
}

customValueEl.addEventListener("change", applyCustomInputs);
customUnitEl.addEventListener("change", applyCustomInputs);

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;
  selectSeconds(selectedSeconds);
  applyStatus(await sendMessage({ type: "status", tabId }));
})();
