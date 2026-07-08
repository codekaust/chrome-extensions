import { FORMATS } from "../popup/formats.js";

const select = document.getElementById("default-format");
const saved = document.getElementById("saved");

for (const fmt of FORMATS) {
  const opt = document.createElement("option");
  opt.value = fmt;
  opt.textContent = fmt;
  select.appendChild(opt);
}

let savedTimer;
function flashSaved() {
  saved.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => saved.classList.remove("show"), 1200);
}

chrome.storage.sync.get("defaultFormat").then(({ defaultFormat }) => {
  select.value = defaultFormat && FORMATS.includes(defaultFormat) ? defaultFormat : "Markdown";
});

select.addEventListener("change", () => {
  chrome.storage.sync.set({ defaultFormat: select.value });
  flashSaved();
});
