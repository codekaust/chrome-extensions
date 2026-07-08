import { DEFAULTS } from "../src/popper.js";

const fields = {
  width: document.getElementById("width"),
  height: document.getElementById("height"),
  position: document.getElementById("position"),
  focus: document.getElementById("focus"),
};
const saved = document.getElementById("saved");

let savedTimer;
function flashSaved() {
  saved.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => saved.classList.remove("show"), 1200);
}

function readForm() {
  return {
    width: Number(fields.width.value) || DEFAULTS.width,
    height: Number(fields.height.value) || DEFAULTS.height,
    position: fields.position.value,
    focus: fields.focus.checked,
  };
}

function fill(settings) {
  fields.width.value = settings.width;
  fields.height.value = settings.height;
  fields.position.value = settings.position;
  fields.focus.checked = settings.focus;
}

chrome.storage.sync.get("settings").then(({ settings }) => {
  fill({ ...DEFAULTS, ...(settings || {}) });
});

for (const el of Object.values(fields)) {
  const evt = el.type === "checkbox" ? "change" : "input";
  el.addEventListener(evt, () => {
    chrome.storage.sync.set({ settings: readForm() });
    flashSaved();
  });
}
