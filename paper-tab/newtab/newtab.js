import { renderMarkdown, escapeHtml } from "../src/markdown.js";
import { THEMES, resolveTheme } from "../src/themes.js";
import { FONTS, resolveFont } from "../src/fonts.js";
import { FONT_SIZES, resolveFontSize } from "../src/font-sizes.js";
import {
  matchBlockTrigger,
  matchEnterTrigger,
  matchInlineTrigger,
  matchTaskBracket,
  matchSlashCommand,
} from "../src/live-markdown.js";

const editor = document.getElementById("editor");
const savedIndicator = document.getElementById("saved");
const countEl = document.getElementById("count");

const SAVE_DEBOUNCE_MS = 300;
const SAVED_FLASH_MS = 1200;
const BLOCK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "PRE", "BLOCKQUOTE"]);
const ZERO_WIDTH_SPACE = "\u200B";

let saveTimer = null;
let savedFlashTimer = null;

document.execCommand("defaultParagraphSeparator", false, "p");

// --- Selection / DOM helpers ---

function placeCaretAtStart(el) {
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function getCurrentBlock() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  while (node && node !== editor && !BLOCK_TAGS.has(node.tagName)) node = node.parentElement;
  return node === editor ? null : node;
}

// Block-level triggers are strictly ^...$ anchored, so a leftover
// ZERO_WIDTH_SPACE anchor from an earlier inline-format/checkbox insertion
// (see applyInlineFormat/insertCheckboxInto) silently breaks every match.
function blockText(el) {
  return el.textContent.replace(new RegExp(ZERO_WIDTH_SPACE, "g"), "");
}

function emptyParagraph() {
  const p = document.createElement("p");
  p.appendChild(document.createElement("br"));
  return p;
}

// --- Word count + autosave ---

function updateCount() {
  // textContent concatenates across block boundaries with no separator
  // ("one" + "two" -> "onetwo"), so join each visible line's own text with
  // a space instead of reading editor.textContent directly.
  const lines = Array.from(editor.children).flatMap((block) => {
    if (block.classList.contains("table-controls")) return [];
    if (block.tagName === "UL" || block.tagName === "OL") return Array.from(block.children).map((li) => li.textContent);
    if (block.tagName === "TABLE") return Array.from(block.querySelectorAll("th, td")).map((cell) => cell.textContent);
    return [block.textContent];
  });
  const text = lines.join(" ").trim();
  const words = text ? text.split(/\s+/).length : 0;
  countEl.textContent = words ? `${words} word${words === 1 ? "" : "s"}` : "";
}

function flashSaved() {
  savedIndicator.classList.add("show");
  clearTimeout(savedFlashTimer);
  savedFlashTimer = setTimeout(() => savedIndicator.classList.remove("show"), SAVED_FLASH_MS);
}

function scheduleSave() {
  updateCount();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ note: { text: serializeMarkdown(editor), updatedAt: Date.now() } });
    flashSaved();
  }, SAVE_DEBOUNCE_MS);
}

// --- DOM -> Markdown (for storage) ---

function serializeInline(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(new RegExp(ZERO_WIDTH_SPACE, "g"), "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  switch (node.tagName) {
    case "BR":
      return "\n";
    case "INPUT":
      return "";
    case "STRONG":
      return `**${serializeChildren(node)}**`;
    case "EM":
      return `*${serializeChildren(node)}*`;
    case "DEL":
      return `~~${serializeChildren(node)}~~`;
    case "CODE":
      return `\`${node.textContent}\``;
    case "A":
      return `[${serializeChildren(node)}](${node.getAttribute("href")})`;
    default:
      return serializeChildren(node);
  }
}

function serializeChildren(el) {
  return Array.from(el.childNodes).map(serializeInline).join("");
}

function serializeListItem(li, ordered, index) {
  if (li.classList.contains("task-item")) {
    const checked = li.querySelector("input[type=checkbox]")?.checked;
    // The user's own typed space after "]" (from "- [ ] label") is often
    // still there in the label text — strip one so it isn't doubled up with
    // the space this template already adds.
    const label = serializeChildren(li).replace(/^ /, "");
    return `- [${checked ? "x" : " "}] ${label}`;
  }
  return ordered ? `${index + 1}. ${serializeChildren(li)}` : `- ${serializeChildren(li)}`;
}

function serializeBlock(block) {
  if (block.classList.contains("table-controls")) return null;
  switch (block.tagName) {
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return `${"#".repeat(Number(block.tagName[1]))} ${serializeChildren(block)}`;
    case "UL":
    case "OL": {
      const ordered = block.tagName === "OL";
      return Array.from(block.children)
        .map((li, i) => serializeListItem(li, ordered, i))
        .join("\n");
    }
    case "BLOCKQUOTE": {
      const inner = block.querySelector("p") || block;
      return serializeChildren(inner)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    }
    case "PRE": {
      const code = block.querySelector("code");
      const lang = code?.className.replace("language-", "") ?? block.dataset.lang ?? "";
      return `\`\`\`${lang}\n${(code ?? block).textContent}\n\`\`\``;
    }
    case "HR":
      return "---";
    case "TABLE": {
      const headerCells = Array.from(block.querySelectorAll(":scope > thead > tr > th")).map((th) =>
        serializeChildren(th).trim()
      );
      const bodyRows = Array.from(block.querySelectorAll(":scope > tbody > tr")).map((tr) =>
        Array.from(tr.children).map((td) => serializeChildren(td).trim())
      );
      const headerLine = `| ${headerCells.join(" | ")} |`;
      const sepLine = `| ${headerCells.map(() => "---").join(" | ")} |`;
      const bodyLines = bodyRows.map((cells) => `| ${cells.join(" | ")} |`);
      return [headerLine, sepLine, ...bodyLines].join("\n");
    }
    default:
      return serializeChildren(block);
  }
}

function serializeMarkdown(root) {
  return Array.from(root.children)
    .map(serializeBlock)
    .filter((s) => s !== null)
    .join("\n\n");
}

// --- Markdown -> DOM (hydration on load) ---

function hydrate(text) {
  if (!text) {
    editor.innerHTML = "";
    editor.appendChild(document.createElement("p"));
    return;
  }
  editor.innerHTML = renderMarkdown(text);
  editor.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.removeAttribute("disabled"));
  const tables = editor.querySelectorAll("table");
  tables.forEach(attachTableControls);
  const lastTable = tables[tables.length - 1];
  if (lastTable) ensureTrailingParagraph(lastTable.nextElementSibling);
}

// --- Block conversion (Notion-style "type a marker + space") ---

// Manually replacing the focused block (createElement + replaceWith) while
// the browser is mid-keystroke desyncs its native typing/caret state, so the
// next character lands outside the new element. execCommand is the native,
// caret-safe way to convert the current block without that desync.
function deleteBlockPrefix(block) {
  const sel = window.getSelection();
  const current = sel.getRangeAt(0);
  const range = document.createRange();
  range.setStart(block, 0);
  range.setEnd(current.endContainer, current.endOffset);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand("delete");
}

function mergeIntoAdjacentList(tag, extraClass) {
  const li = getCurrentBlock();
  if (!li || li.tagName !== "LI") return li;
  let list = li.parentElement;

  // Chrome's insertOrderedList/insertUnorderedList sometimes nests the new
  // list inside the original paragraph instead of replacing it — hoist it
  // back out to be a direct child of the editor, like every other block.
  const wrapper = list.parentElement;
  if (wrapper !== editor) {
    wrapper.replaceWith(list);
  }

  const prev = list.previousElementSibling;
  if (list.children.length === 1 && prev && prev.tagName === tag && (!extraClass || prev.classList.contains(extraClass))) {
    prev.appendChild(li);
    list.remove();
  }
  return li;
}

function convertBlock(block, match) {
  deleteBlockPrefix(block);

  if (match.block === "heading") {
    document.execCommand("formatBlock", false, `<h${match.level}>`);
    return;
  }
  if (match.block === "bullet") {
    document.execCommand("insertUnorderedList");
    mergeIntoAdjacentList("UL");
    return;
  }
  if (match.block === "ordered") {
    document.execCommand("insertOrderedList");
    mergeIntoAdjacentList("OL");
    return;
  }
  if (match.block === "task") {
    document.execCommand("insertUnorderedList");
    const li = mergeIntoAdjacentList("UL", "task-list");
    if (!li) return;
    li.parentElement.classList.add("task-list");
    li.classList.add("task-item");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = match.checked;
    li.insertBefore(checkbox, li.firstChild);
    return;
  }
  if (match.block === "quote") {
    document.execCommand("formatBlock", false, "<blockquote>");
  }
}

// "- " always converts to a bullet before "[" can be typed as part of the
// same block match, so a task can't be detected atomically like the other
// block triggers. Instead, mirror Notion: convert to a bullet immediately,
// then retroactively upgrade it to a task the instant its content becomes
// exactly "[ ]"/"[x]"/"[]" (see matchTaskBracket in live-markdown.js).
//
// execCommand("insertHTML") on an <li> containing only a native <br> is
// unreliable — it can collapse/drop the <li> wrapper entirely (verified
// empirically). It's reliable once the <li> has *real* selected text to
// replace, which is exactly the case here: the caller always has actual
// bracket text ("[ ]"/"[x]"/"[]") selected and deleted first.
function insertCheckboxInto(li, checked) {
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(li);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand("delete");
  li.classList.add("task-item");
  li.parentElement.classList.add("task-list");
  document.execCommand("insertHTML", false, `<input type="checkbox"${checked ? " checked" : ""}>` + ZERO_WIDTH_SPACE);
}

function convertBlockOnEnter(block, match) {
  if (match.block === "code") {
    deleteBlockPrefix(block);
    document.execCommand("formatBlock", false, "<pre>");
    // Setting an attribute (not touching Selection/child nodes) is safe here
    // — see deleteBlockPrefix's comment on why DOM surgery on the focused
    // node itself is what desyncs the caret, not attribute changes.
    if (match.lang) getCurrentBlock()?.setAttribute("data-lang", match.lang);
    return;
  }
  if (match.block === "hr") {
    deleteBlockPrefix(block);
    document.execCommand("insertHorizontalRule");
    const hr = editor.querySelector("hr:last-of-type");
    const p = emptyParagraph();
    hr.after(p);
    placeCaretAtStart(p);
  }
}

// --- Tables ("/table" slash command) ---

function ensureTrailingParagraph(el) {
  if (!el.nextElementSibling) el.after(emptyParagraph());
}

function createTableControls() {
  const bar = document.createElement("div");
  bar.className = "table-controls";
  bar.contentEditable = "false";
  bar.innerHTML =
    '<button type="button" class="table-control" data-action="add-row">+ Row <kbd>⌃N</kbd></button>' +
    '<button type="button" class="table-control" data-action="add-column">+ Column <kbd>⌃⇧N</kbd></button>';
  return bar;
}

function attachTableControls(table) {
  if (table.nextElementSibling?.classList.contains("table-controls")) return;
  table.after(createTableControls());
}

function addTableRow(table) {
  let tbody = table.querySelector("tbody");
  if (!tbody) {
    tbody = document.createElement("tbody");
    table.appendChild(tbody);
  }
  const columnCount = table.querySelector("tr")?.children.length ?? 1;
  const row = document.createElement("tr");
  for (let i = 0; i < columnCount; i++) row.appendChild(document.createElement("td"));
  tbody.appendChild(row);
  placeCaretAtStart(row.children[0]);
  scheduleSave();
}

function addTableColumn(table) {
  const headerRow = table.querySelector("thead tr");
  headerRow?.appendChild(document.createElement("th"));
  table.querySelectorAll("tbody tr").forEach((row) => row.appendChild(document.createElement("td")));
  const lastCell = headerRow?.lastElementChild;
  if (lastCell) placeCaretAtStart(lastCell);
  scheduleSave();
}

function insertTable(block) {
  deleteBlockPrefix(block);
  document.execCommand(
    "insertHTML",
    false,
    "<table><thead><tr><th></th><th></th></tr></thead><tbody><tr><td></td><td></td></tr></tbody></table>"
  );
  const tables = editor.querySelectorAll("table");
  const table = tables[tables.length - 1];
  if (!table) return;
  attachTableControls(table);
  ensureTrailingParagraph(table.nextElementSibling);
  const firstCell = table.querySelector("th, td");
  if (firstCell) placeCaretAtStart(firstCell);
}

function closestCell(node) {
  const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return el?.closest("td, th") ?? null;
}

function currentTable() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  return closestCell(sel.getRangeAt(0).startContainer)?.closest("table") ?? null;
}

// Tab inside a contenteditable region normally moves focus out of the editor
// entirely — intercept it within a table to move between cells instead,
// adding a new row when tabbing past the last cell (like a spreadsheet).
// Enter always exits the table to the paragraph after it (creating one if
// needed) rather than leaving the user stuck inside — Tab, the buttons, or
// the Ctrl+N/Ctrl+Shift+N shortcuts are how rows/columns get added.
function handleTableTab(shiftKey) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  const cell = closestCell(sel.getRangeAt(0).startContainer);
  if (!cell) return false;

  const row = cell.parentElement;
  const cells = Array.from(row.children);
  const index = cells.indexOf(cell);

  if (!shiftKey) {
    if (index < cells.length - 1) {
      placeCaretAtStart(cells[index + 1]);
    } else if (row.nextElementSibling) {
      placeCaretAtStart(row.nextElementSibling.children[0]);
    } else {
      addTableRow(row.closest("table"));
    }
  } else if (index > 0) {
    placeCaretAtStart(cells[index - 1]);
  } else if (row.previousElementSibling) {
    const prevCells = row.previousElementSibling.children;
    placeCaretAtStart(prevCells[prevCells.length - 1]);
  }
  return true;
}

function handleTableEnter(shiftKey) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  const cell = closestCell(sel.getRangeAt(0).startContainer);
  if (!cell) return false;

  if (shiftKey) {
    document.execCommand("insertLineBreak");
    return true;
  }

  const table = cell.closest("table");
  ensureTrailingParagraph(table.nextElementSibling?.classList.contains("table-controls") ? table.nextElementSibling : table);
  const after = table.nextElementSibling?.classList.contains("table-controls")
    ? table.nextElementSibling.nextElementSibling
    : table.nextElementSibling;
  placeCaretAtStart(after);
  return true;
}

editor.addEventListener("click", (e) => {
  const button = e.target.closest(".table-control");
  if (!button) return;
  const table = button.closest(".table-controls").previousElementSibling;
  if (button.dataset.action === "add-row") addTableRow(table);
  else if (button.dataset.action === "add-column") addTableColumn(table);
});

// Toggling the same list command back off is the native, caret-safe way to
// turn a list item back into a plain paragraph (see convertBlock's comment).
function exitListItem(li) {
  li.querySelector("input[type=checkbox]")?.remove();
  const ordered = li.parentElement.tagName === "OL";
  document.execCommand(ordered ? "insertOrderedList" : "insertUnorderedList");
  // Toggling a list off sometimes leaves a bare <br>/text node behind
  // instead of a proper <p> — normalize it natively.
  document.execCommand("formatBlock", false, "<p>");
}

function unwrapBlock(block) {
  if (block.tagName === "BLOCKQUOTE") {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(block);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  document.execCommand("formatBlock", false, "<p>");
}

// --- Inline conversion (Notion-style "type the closing delimiter") ---

// Building new element nodes and manually placing the caret (as convertBlock
// used to) desyncs Chrome's native typing pipeline for the next keystroke —
// see the comment above deleteBlockPrefix. insertHTML is the native,
// caret-safe way to replace a text range and land the caret right after it.
function applyInlineFormat(textNode, match) {
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(textNode, match.start);
  range.setEnd(textNode, match.end);
  sel.removeAllRanges();
  sel.addRange(range);

  let html = escapeHtml(match.content);
  for (let i = match.tags.length - 1; i >= 0; i--) {
    const tag = match.tags[i];
    html =
      tag === "a"
        ? `<a href="${escapeHtml(match.href)}" target="_blank" rel="noopener noreferrer">${html}</a>`
        : `<${tag}>${html}</${tag}>`;
  }
  // Without a plain trailing anchor, the caret lands inside the just-closed
  // tag and the next keystroke gets absorbed into it. ZERO_WIDTH_SPACE gives
  // typing somewhere plain to land after the tag; serialization strips it.
  document.execCommand("insertHTML", false, html + ZERO_WIDTH_SPACE);
}

// --- Input handling ---

// Structural blocks (tables, hr, empty headings mid-typing, ...) can have
// empty textContent while still being meaningful content — never let the
// text-emptiness check below treat them as "nothing here, wipe it".
const STRUCTURAL_TAGS = new Set(["TABLE", "HR", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "BLOCKQUOTE"]);

function normalizeEmptyEditor() {
  const hasStructuralBlock = Array.from(editor.children).some(
    (c) => STRUCTURAL_TAGS.has(c.tagName) || c.classList.contains("table-controls")
  );
  if (hasStructuralBlock) return;
  if (editor.textContent.trim() !== "") return;
  if (editor.children.length === 1 && editor.firstElementChild.tagName === "P") return;
  editor.innerHTML = "";
  const p = document.createElement("p");
  editor.appendChild(p);
  placeCaretAtStart(p);
}

// document.execCommand() synchronously fires its own nested "input" events
// (e.g. deleteBlockPrefix's execCommand("delete") re-enters this handler
// mid-conversion) — ignore those re-entrant calls so normalizeEmptyEditor
// and friends don't run against transient intermediate DOM states.
let isHandlingInput = false;

editor.addEventListener("input", () => {
  if (isHandlingInput) return;
  isHandlingInput = true;
  try {
    handleInput();
  } finally {
    isHandlingInput = false;
  }
});

function handleInput() {
  const block = getCurrentBlock();
  if (block && block.tagName === "P" && block.parentElement === editor) {
    const blockMatch = matchBlockTrigger(blockText(block));
    if (blockMatch) {
      convertBlock(block, blockMatch);
      scheduleSave();
      return;
    }
  }

  if (block && block.tagName === "LI") {
    // Enter inside a task item natively copies the "task-item" class to the
    // new sibling <li> but not the checkbox child — add the missing one, the
    // way Notion auto-continues a checklist without retyping "[ ] " per line.
    if (block.classList.contains("task-item") && !block.querySelector("input[type=checkbox]")) {
      document.execCommand("insertHTML", false, "<input type=\"checkbox\">" + ZERO_WIDTH_SPACE);
      scheduleSave();
      return;
    }

    if (!block.classList.contains("task-item") && block.parentElement.tagName === "UL") {
      const taskMatch = matchTaskBracket(blockText(block));
      if (taskMatch) {
        insertCheckboxInto(block, taskMatch.checked);
        scheduleSave();
        return;
      }
    }
  }

  const sel = window.getSelection();
  if (sel.rangeCount && sel.isCollapsed) {
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE && node.parentElement && !node.parentElement.closest("pre")) {
      const inlineMatch = matchInlineTrigger(node.textContent.slice(0, range.startOffset));
      if (inlineMatch) applyInlineFormat(node, inlineMatch);
    }
  }

  normalizeEmptyEditor();
  scheduleSave();
}

editor.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
    const table = currentTable();
    if (table) {
      e.preventDefault();
      if (e.shiftKey) addTableColumn(table);
      else addTableRow(table);
    }
    return;
  }

  if (e.key === "Tab") {
    if (handleTableTab(e.shiftKey)) e.preventDefault();
    return;
  }

  if (e.key === "Enter" && handleTableEnter(e.shiftKey)) {
    e.preventDefault();
    scheduleSave();
    return;
  }

  if (e.key !== "Enter" && e.key !== "Backspace" && e.key !== "Escape") return;
  const block = getCurrentBlock();
  if (!block) return;

  if (e.key === "Escape") {
    if (block.tagName === "PRE") {
      e.preventDefault();
      const p = emptyParagraph();
      block.after(p);
      placeCaretAtStart(p);
      scheduleSave();
    }
    return;
  }

  if (e.key === "Enter") {
    if (block.tagName === "PRE") {
      // A code block's newlines become <br> elements, not "\n" characters in
      // textContent, so there's no reliable way to detect "an empty trailing
      // line" to auto-exit on a second Enter. Keep Enter unambiguous (always
      // inserts a newline); Escape explicitly exits the block instead.
      e.preventDefault();
      document.execCommand("insertText", false, "\n");
      return;
    }

    if (block.tagName === "P" && block.parentElement === editor) {
      const enterMatch = matchEnterTrigger(blockText(block));
      if (enterMatch) {
        e.preventDefault();
        convertBlockOnEnter(block, enterMatch);
        scheduleSave();
        return;
      }

      const slashMatch = matchSlashCommand(blockText(block));
      if (slashMatch?.command === "table") {
        e.preventDefault();
        insertTable(block);
        scheduleSave();
        return;
      }
    }

    if (block.tagName === "LI" && blockText(block).trim() === "") {
      e.preventDefault();
      exitListItem(block);
      scheduleSave();
      return;
    }

    if (["H1", "H2", "H3", "H4", "H5", "H6"].includes(block.tagName) || block.closest("blockquote")) {
      if (e.shiftKey) {
        e.preventDefault();
        document.execCommand("insertLineBreak");
        return;
      }
      e.preventDefault();
      const p = emptyParagraph();
      const top = block.closest("blockquote") || block;
      top.after(p);
      placeCaretAtStart(p);
      scheduleSave();
    }
    return;
  }

  // Backspace at the very start of a special block unwraps it to a plain paragraph.
  const sel = window.getSelection();
  if (!sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const atStart = range.startOffset === 0 && (range.startContainer === block || range.startContainer === block.firstChild);
  if (!atStart) return;

  if (block.tagName === "LI") {
    e.preventDefault();
    exitListItem(block);
    scheduleSave();
  } else if (["H1", "H2", "H3", "H4", "H5", "H6", "PRE"].includes(block.tagName) || block.closest("blockquote")) {
    e.preventDefault();
    unwrapBlock(block.closest("blockquote") || block);
    scheduleSave();
  }
});

editor.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (a && !(e.metaKey || e.ctrlKey)) e.preventDefault();
});

// --- Popover menus (Theme, Font) ---

const customizeToggle = document.getElementById("customize-toggle");
const customizePanel = document.getElementById("customize-panel");
const themeRow = document.getElementById("theme-row");
const fontRow = document.getElementById("font-row");
const sizeRow = document.getElementById("size-row");

function chipButton(id, label, checked, extraClass, style, text) {
  return `<button type="button" class="chip ${extraClass}" style="${style}" role="menuitemradio" aria-checked="${checked}" title="${label}" data-id="${id}">${text}</button>`;
}

function renderThemeRow() {
  themeRow.innerHTML = [{ id: "system", label: "System", paper: null }, ...THEMES]
    .map((opt) => {
      const bg = opt.paper ?? "linear-gradient(135deg, #fbf7ee 50%, #1c1913 50%)";
      return chipButton(opt.id, opt.label, themePreference === opt.id, "chip-theme", `background:${bg}`, "");
    })
    .join("");
}

function renderFontRow() {
  fontRow.innerHTML = FONTS.map((opt) =>
    chipButton(opt.id, opt.label, fontPreference === opt.id, "chip-font", `font-family:${opt.family}`, "Aa")
  ).join("");
}

function renderSizeRow() {
  sizeRow.innerHTML = FONT_SIZES.map((opt) =>
    chipButton(opt.id, opt.label, fontSizePreference === opt.id, "chip-size", `font-size:${opt.size}`, opt.label)
  ).join("");
}

function openCustomizePanel() {
  renderThemeRow();
  renderFontRow();
  renderSizeRow();
  customizePanel.hidden = false;
  customizeToggle.setAttribute("aria-expanded", "true");
}

function closeCustomizePanel() {
  customizePanel.hidden = true;
  customizeToggle.setAttribute("aria-expanded", "false");
}

customizeToggle.addEventListener("click", () => (customizePanel.hidden ? openCustomizePanel() : closeCustomizePanel()));

customizePanel.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  if (chip.closest("#theme-row")) {
    setThemePreference(chip.dataset.id);
    renderThemeRow();
  } else if (chip.closest("#font-row")) {
    setFontPreference(chip.dataset.id);
    renderFontRow();
  } else if (chip.closest("#size-row")) {
    setFontSizePreference(chip.dataset.id);
    renderSizeRow();
  }
});

document.addEventListener("click", (e) => {
  if (!customizePanel.hidden && !e.target.closest("#customize-toggle, #customize-panel")) closeCustomizePanel();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !customizePanel.hidden) closeCustomizePanel();
});

// --- Theme ---

let themePreference = "system";
const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");

function applyEffectiveTheme() {
  const effective = resolveTheme(themePreference, darkMedia.matches);
  if (effective === "light") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = effective;
}

function setThemePreference(pref) {
  themePreference = pref;
  applyEffectiveTheme();
  chrome.storage.local.set({ themePreference });
  localStorage.setItem("themePreference", pref);
}

darkMedia.addEventListener("change", () => {
  if (themePreference === "system") applyEffectiveTheme();
});

// --- Font ---

let fontPreference = "serif";

function applyEffectiveFont() {
  const effective = resolveFont(fontPreference);
  if (effective === "serif") delete document.documentElement.dataset.font;
  else document.documentElement.dataset.font = effective;
}

function setFontPreference(pref) {
  fontPreference = pref;
  applyEffectiveFont();
  chrome.storage.local.set({ fontPreference });
  localStorage.setItem("fontPreference", pref);
}

// --- Font size ---

let fontSizePreference = "medium";

function applyEffectiveFontSize() {
  const effective = resolveFontSize(fontSizePreference);
  if (effective === "medium") delete document.documentElement.dataset.size;
  else document.documentElement.dataset.size = effective;
}

function setFontSizePreference(pref) {
  fontSizePreference = pref;
  applyEffectiveFontSize();
  chrome.storage.local.set({ fontSizePreference });
  localStorage.setItem("fontSizePreference", pref);
}

// --- Init ---

const stored = await chrome.storage.local.get(["note", "themePreference", "fontPreference", "fontSizePreference"]);
hydrate(stored.note?.text ?? "");
themePreference = stored.themePreference ?? "system";
fontPreference = stored.fontPreference ?? "serif";
fontSizePreference = stored.fontSizePreference ?? "medium";
updateCount();
applyEffectiveTheme();
applyEffectiveFont();
applyEffectiveFontSize();
localStorage.setItem("themePreference", themePreference);
localStorage.setItem("fontPreference", fontPreference);
localStorage.setItem("fontSizePreference", fontSizePreference);
editor.focus();
placeCaretAtStart(editor.lastChild ?? editor);
