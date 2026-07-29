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
import { log, describeText, installDebugHandle } from "../src/log.js";

const editor = document.getElementById("editor");
const savedIndicator = document.getElementById("saved");
const countEl = document.getElementById("count");

const SAVE_DEBOUNCE_MS = 300;
const SAVED_FLASH_MS = 1200;
const BLOCK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "PRE", "BLOCKQUOTE"]);
const ZERO_WIDTH_SPACE = "\u200B";

let saveTimer = null;
let savedFlashTimer = null;
// Timestamp of the note version currently reflected in this tab's editor —
// used to tell "a remote tab just saved something new" apart from "this is
// just chrome.storage.onChanged echoing our own write back to us".
let lastSyncedAt = 0;
// Edits absorbed by the current debounce window. Logged with each flush so a
// dropped save shows up as "12 edits pending" rather than as silence.
let pendingEdits = 0;
// Length of the note this tab last wrote or accepted — the baseline for the
// "this save is suspiciously much shorter than the last one" check.
let lastSavedLength = 0;

document.execCommand("defaultParagraphSeparator", false, "p");

// --- Diagnostics ---

installDebugHandle({
  // Live view of this tab's persistence state, for cross-checking against
  // what storage holds (`__paperTab.peek()`).
  state: () => ({
    lastSyncedAt,
    lastSyncedAtISO: lastSyncedAt ? new Date(lastSyncedAt).toISOString() : null,
    saveScheduled: Boolean(saveTimer),
    pendingEdits,
    blocks: editor.children.length,
    ...describeText(serializeMarkdown(editor)),
  }),
});

log("page:load", {
  visibility: document.visibilityState,
  hasFocus: document.hasFocus(),
  url: location.href,
  version: chrome.runtime.getManifest?.().version,
  // A missing storage API is the one failure that makes every save a no-op.
  storageApi: Boolean(chrome?.storage?.local),
  // Both differ per browser profile, and both change where writes land.
  incognito: chrome.extension?.inIncognitoContext,
  browser: navigator.userAgent,
});

// A thrown error anywhere in this module aborts the rest of it — including the
// top-level init that hydrates the note — which presents to the user exactly as
// "my text is gone". Surface those instead of letting them scroll past.
window.addEventListener("error", (e) => {
  log.error("js:error", { message: e.message, source: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack });
});
window.addEventListener("unhandledrejection", (e) => {
  log.error("js:unhandled-rejection", { reason: String(e.reason), stack: e.reason?.stack });
});

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

// Everything this editor is expected to contain. Anything else inside the
// editor came from somewhere we don't control — most often another extension
// that rewrites contenteditable regions (Grammarly, LanguageTool, …), which is
// also the most likely reason the same note behaves differently in two
// browser profiles.
const KNOWN_TAGS = new Set([
  ...BLOCK_TAGS,
  "UL", "OL", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "HR", "BR",
  "STRONG", "EM", "DEL", "CODE", "A", "INPUT",
  "DIV", "BUTTON", "KBD", // .table-controls bar
]);
const KNOWN_ATTRS = new Set(["class", "href", "target", "rel", "type", "checked", "data-lang", "contenteditable"]);
const KNOWN_EDITOR_ATTRS = new Set(["id", "class", "contenteditable", "spellcheck"]);

function uniqueTags(nodes, pick) {
  return [...new Set(nodes.flatMap(pick))];
}

// serializeMarkdown walks editor.children — *elements* only — so text sitting
// directly in the editor root is invisible to it and is dropped on every save.
// That is precisely the "I typed it, then it wasn't there" signature.
function describeEditorAnomalies() {
  const elements = Array.from(editor.querySelectorAll("*"));
  const anomalies = {};

  const strays = Array.from(editor.childNodes).filter(
    (n) => n.nodeType === Node.TEXT_NODE && n.textContent.replace(new RegExp(ZERO_WIDTH_SPACE, "g"), "").trim() !== ""
  );
  if (strays.length) anomalies.strayText = strays.map((n) => describeText(n.textContent));

  const unknownTags = uniqueTags(elements, (el) => (KNOWN_TAGS.has(el.tagName) ? [] : [el.tagName]));
  if (unknownTags.length) anomalies.unknownTags = unknownTags;

  const foreignAttrs = uniqueTags(elements, (el) =>
    Array.from(el.attributes).map((a) => a.name).filter((name) => !KNOWN_ATTRS.has(name))
  );
  if (foreignAttrs.length) anomalies.foreignAttrs = foreignAttrs;

  const editorAttrs = Array.from(editor.attributes).map((a) => a.name).filter((name) => !KNOWN_EDITOR_ATTRS.has(name));
  if (editorAttrs.length) anomalies.editorAttrs = editorAttrs;

  return Object.keys(anomalies).length ? anomalies : null;
}

function saveNow(reason = "debounce") {
  clearTimeout(saveTimer);
  saveTimer = null;
  const updatedAt = Date.now();
  const previousSyncedAt = lastSyncedAt;
  lastSyncedAt = updatedAt;

  let text;
  try {
    text = serializeMarkdown(editor);
  } catch (err) {
    // Never let a serialization bug take the save down silently — that would
    // leave the user typing into a tab that has stopped persisting anything.
    log.error("save:serialize-failed", { reason, message: err?.message, stack: err?.stack, blocks: editor.children.length });
    throw err;
  }

  const anomalies = describeEditorAnomalies();
  const detail = {
    reason,
    edits: pendingEdits,
    updatedAt,
    updatedAtISO: new Date(updatedAt).toISOString(),
    previousSyncedAt,
    blocks: editor.children.length,
    domChars: editor.textContent.length,
    ...describeText(text),
  };
  if (anomalies) detail.anomalies = anomalies;
  pendingEdits = 0;

  // serializeNode now rescues root-level text into its own paragraph, so this
  // is no longer data loss — but the caret still ended up somewhere it
  // shouldn't, which is worth knowing about.
  if (anomalies?.strayText)
    log.warn("save:stray-text-recovered", {
      ...detail,
      hint: "text sat in the editor root, outside any block; saved as its own paragraph",
    });

  // The data-loss signatures worth shouting about: publishing an empty note
  // over something that had content, or publishing a drastically shorter one
  // (the "only the last few words survived" report).
  if (!text.trim() && editor.textContent.trim())
    log.warn("save:empty-serialization", { ...detail, hint: "editor has visible text but serialized to nothing" });
  else if (lastSavedLength > 40 && text.length < lastSavedLength / 2)
    log.warn("save:shrink", { ...detail, previousLen: lastSavedLength });
  else log("save:write", detail);
  lastSavedLength = text.length;

  chrome.storage.local.set({ note: { text, updatedAt } }, () => {
    // storage.local writes fail silently unless lastError is read here — quota
    // exhaustion and a corrupted/locked profile store both land in this branch.
    const err = chrome.runtime.lastError;
    if (err) {
      log.error("save:failed", { reason, updatedAt, error: err.message });
      return;
    }
    // Read straight back: proves the profile actually persisted the write, and
    // catches the case where another tab's write landed in between.
    chrome.storage.local.get("note", (items) => {
      const readBackErr = chrome.runtime.lastError;
      if (readBackErr) {
        log.error("save:verify-failed", { updatedAt, error: readBackErr.message });
        return;
      }
      const note = items?.note;
      const matches = note?.updatedAt === updatedAt;
      const entry = { updatedAt, storedUpdatedAt: note?.updatedAt, ...describeText(note?.text) };
      if (matches) log("save:ok", entry);
      else log.warn("save:overwritten-by-other-tab", entry);
    });
  });
  flashSaved();
}

function scheduleSave() {
  updateCount();
  pendingEdits++;
  if (!saveTimer) log("save:scheduled", { in: SAVE_DEBOUNCE_MS, lastSyncedAt });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow("debounce"), SAVE_DEBOUNCE_MS);
}

// A tab going hidden (e.g. the user opens another new tab) backgrounds this
// page without firing beforeunload, so a save still sitting in the debounce
// window would otherwise be silently dropped — flush it immediately instead.
// That's also what lets *other* open PaperTab tabs pick this edit up quickly,
// since it's what fires chrome.storage.onChanged for them.
document.addEventListener("visibilitychange", () => {
  log("page:visibility", { state: document.visibilityState, saveScheduled: Boolean(saveTimer), pendingEdits });
  if (document.hidden) {
    if (saveTimer) saveNow("hidden-flush");
  } else {
    syncFromStorageIfIdle("visible");
  }
});

// Purely diagnostic: a tab torn down (or discarded by Chrome to reclaim memory)
// with a save still inside the debounce window loses that edit, and pagehide is
// the last moment we can observe it happening.
window.addEventListener("pagehide", (e) => {
  const detail = { persisted: e.persisted, saveScheduled: Boolean(saveTimer), pendingEdits };
  if (saveTimer) log.warn("page:hide-with-pending-save", detail);
  else log("page:hide", detail);
});

// This is a single note shared by every open PaperTab tab, but each tab is
// its own independent page with its own in-memory editor — without this,
// a tab left open in the background never learns another tab saved, so
// switching back to it and typing overwrites the newer content with its own
// stale copy (silent data loss, the "only a few words got saved" bug).
// Only ever apply a remote update when it's actually safe to blow away this
// tab's DOM: no local edit pending, i.e. this tab hasn't been typed into in
// the last SAVE_DEBOUNCE_MS (its own save is already about to win anyway).
// The editor auto-focuses on every load, so "has focus" is not a usable
// signal for "user is actively typing here right now" — most idle tabs are
// still focused.
function canAcceptRemoteUpdate() {
  return !saveTimer;
}

function applyRemoteNote(text, updatedAt, source) {
  const hadFocus = editor.contains(document.activeElement);
  log("sync:apply", {
    source,
    hadFocus,
    fromUpdatedAt: lastSyncedAt,
    toUpdatedAt: updatedAt,
    ageMs: Date.now() - updatedAt,
    ...describeText(text),
  });
  hydrate(text);
  updateCount();
  lastSyncedAt = updatedAt;
  lastSavedLength = text?.length ?? 0;
  // Keep the caret usable if the user was (or is about to start) typing
  // here — otherwise the next keystroke after a remote sync lands nowhere.
  if (hadFocus) {
    editor.focus();
    placeCaretAtStart(editor.lastChild ?? editor);
  }
}

function syncFromStorageIfIdle(source) {
  if (!canAcceptRemoteUpdate()) {
    log("sync:skip", { source, why: "local-edit-pending", pendingEdits });
    return;
  }
  chrome.storage.local.get("note").then(({ note }) => {
    if (!note) {
      log.warn("sync:skip", { source, why: "no-note-in-storage" });
      return;
    }
    if (note.updatedAt === lastSyncedAt) {
      log("sync:skip", { source, why: "already-current", updatedAt: note.updatedAt });
      return;
    }
    if (!canAcceptRemoteUpdate()) {
      log("sync:skip", { source, why: "local-edit-started-during-read", storedUpdatedAt: note.updatedAt, lastSyncedAt });
      return;
    }
    // A *stale* remote value here is the dangerous case: this tab would be
    // replacing its content with an older note than it already had.
    if (note.updatedAt < lastSyncedAt)
      log.warn("sync:stale-storage", { source, storedUpdatedAt: note.updatedAt, lastSyncedAt, ...describeText(note.text) });
    applyRemoteNote(note.text, note.updatedAt, source ?? "poll");
  }, (err) => log.error("sync:read-failed", { source, message: err?.message }));
}

// Chrome keeps background-tab timers running for extension pages, so this
// normally fires within the SAVE_DEBOUNCE_MS of another tab saving; the
// visibilitychange handler above is a backstop for when it doesn't.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.note) {
    log("storage:changed-other", { area, keys: Object.keys(changes) });
    return;
  }
  const incoming = changes.note.newValue;
  log("storage:changed", {
    incomingUpdatedAt: incoming?.updatedAt,
    previousUpdatedAt: changes.note.oldValue?.updatedAt,
    lastSyncedAt,
    isOwnEcho: incoming?.updatedAt === lastSyncedAt,
    saveScheduled: Boolean(saveTimer),
    ...describeText(incoming?.text),
  });
  if (!incoming) {
    log.warn("sync:skip", { source: "onChanged", why: "note-removed-from-storage" });
    return;
  }
  if (incoming.updatedAt === lastSyncedAt) return;
  if (!canAcceptRemoteUpdate()) {
    // This tab keeps its own newer edit and will publish it on the next flush —
    // whatever the other tab just wrote is about to be superseded.
    log.warn("sync:skip", {
      source: "onChanged",
      why: "local-edit-pending",
      pendingEdits,
      incomingUpdatedAt: incoming.updatedAt,
      lastSyncedAt,
    });
    return;
  }
  applyRemoteNote(incoming.text, incoming.updatedAt, "onChanged");
});

// --- DOM -> Markdown (for storage) ---

function serializeInline(node) {
  // Chrome's contenteditable silently swaps a plain space for U+00A0 (NBSP)
  // at the end of a text run (see normalizeSpaces in live-markdown.js) — left
  // unnormalized here, that NBSP gets persisted verbatim and reappears as a
  // visibly wider gap once the note is re-hydrated.
  if (node.nodeType === Node.TEXT_NODE)
    return node.textContent.replace(new RegExp(ZERO_WIDTH_SPACE, "g"), "").replace(/ /g, " ");
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

// Text can end up as a direct child of the editor root rather than inside a
// block (Chrome does this when the caret has no valid position inside the
// current block — see fillEmptyBlocks). Walking children (elements only) would
// silently drop it on every save, which is unrecoverable data loss, so walk
// childNodes and serialize stray text as its own paragraph instead.
function serializeNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = serializeInline(node).trim();
    return text === "" ? null : text;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  return serializeBlock(node);
}

function serializeMarkdown(root) {
  return Array.from(root.childNodes)
    .map(serializeNode)
    .filter((s) => s !== null)
    .join("\n\n");
}

// --- Markdown -> DOM (hydration on load) ---

// A block the renderer emits with no children at all — `<h1></h1>` from a note
// containing just "# ", an empty `<li>` from "- " — has no caret position
// inside it. Chrome then puts typed text in the nearest place it *can* edit,
// the editor root, where it is not part of any block. Before serializeNode
// existed that text was dropped on every save, so a note that once held an
// empty heading became permanently unwritable: every keystroke landed at the
// root and every save rewrote the same "# ". A `<br>` placeholder is what
// Chrome itself uses for an empty block (see emptyParagraph) and it is what
// typing replaces, so the caret always has somewhere to land.
function fillEmptyBlocks() {
  editor.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li").forEach((el) => {
    if (!el.firstChild) el.appendChild(document.createElement("br"));
  });
}

function hydrate(text) {
  if (!text) {
    log("hydrate:empty", describeText(text));
    editor.innerHTML = "";
    editor.appendChild(emptyParagraph());
    return;
  }
  let html;
  try {
    html = renderMarkdown(text);
  } catch (err) {
    // Rendering is the one step between "storage has the note" and "the user
    // sees the note" — if it throws, the note is intact on disk but invisible,
    // and the next keystroke would save the blank editor over it.
    log.error("hydrate:render-failed", { message: err?.message, stack: err?.stack, ...describeText(text) });
    throw err;
  }
  editor.innerHTML = html;
  fillEmptyBlocks();
  editor.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.removeAttribute("disabled"));
  const tables = editor.querySelectorAll("table");
  tables.forEach(attachTableControls);
  const lastTable = tables[tables.length - 1];
  if (lastTable) ensureTrailingParagraph(lastTable.nextElementSibling);
  log("hydrate:done", { blocks: editor.children.length, htmlChars: html.length, domChars: editor.textContent.length });
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
  const p = emptyParagraph();
  editor.appendChild(p);
  placeCaretAtStart(p);
}

// document.execCommand() synchronously fires its own nested "input" events
// (e.g. deleteBlockPrefix's execCommand("delete") re-enters this handler
// mid-conversion) — ignore those re-entrant calls so normalizeEmptyEditor
// and friends don't run against transient intermediate DOM states.
let isHandlingInput = false;

// Diagnostic only: catches the keystroke *as it happens* when the caret is
// sitting in the editor root rather than inside a block. Chrome usually
// absorbs such a keystroke into a neighbouring block, but when it doesn't the
// character becomes a bare text node that serializeMarkdown drops (see
// describeEditorAnomalies) — so this pairs with save:dropping-stray-text to
// show both where the caret was and whether content was actually lost.
editor.addEventListener("beforeinput", (e) => {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const node = sel.getRangeAt(0).startContainer;
  const atRoot = node === editor || (node.nodeType === Node.TEXT_NODE && node.parentElement === editor);
  if (!atRoot) return;
  log.warn("caret:at-editor-root", {
    inputType: e.inputType,
    chars: e.data?.length ?? null,
    container: node === editor ? "editor" : "text-node-in-editor",
    blocks: editor.children.length,
    lastBlock: editor.lastElementChild?.tagName,
  });
});

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

log("init:read-start");
let stored;
const readStartedAt = performance.now();
try {
  stored = await chrome.storage.local.get(["note", "themePreference", "fontPreference", "fontSizePreference"]);
} catch (err) {
  log.error("init:read-failed", { message: err?.message, stack: err?.stack });
  throw err;
}

log("init:read-done", {
  readMs: Math.round(performance.now() - readStartedAt),
  keys: Object.keys(stored),
  hasNote: Boolean(stored.note),
  updatedAt: stored.note?.updatedAt,
  updatedAtISO: stored.note?.updatedAt ? new Date(stored.note.updatedAt).toISOString() : null,
  ageMs: stored.note?.updatedAt ? Date.now() - stored.note.updatedAt : null,
  ...describeText(stored.note?.text),
});

// Quota exhaustion is silent until a write fails, and it differs per profile —
// worth knowing whether this profile's store is near the 5 MB local cap.
chrome.storage.local.getBytesInUse(null, (bytes) =>
  log("init:storage-usage", { bytes, quota: chrome.storage.local.QUOTA_BYTES, error: chrome.runtime.lastError?.message })
);

// The onChanged listener is live before this read resolves, so another tab's
// write can be applied first and then be replaced by this (older) read result —
// which is exactly how a fresh tab can come up showing pre-edit content.
if (lastSyncedAt && (stored.note?.updatedAt ?? 0) < lastSyncedAt)
  log.warn("init:read-older-than-applied", {
    storedUpdatedAt: stored.note?.updatedAt ?? null,
    alreadyAppliedUpdatedAt: lastSyncedAt,
  });

hydrate(stored.note?.text ?? "");
lastSyncedAt = stored.note?.updatedAt ?? 0;
lastSavedLength = stored.note?.text?.length ?? 0;
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
log("init:done", {
  lastSyncedAt,
  blocks: editor.children.length,
  themePreference,
  fontPreference,
  fontSizePreference,
  // A round-trip mismatch here means hydrate+serialize is not lossless for this
  // note — i.e. the very next save would silently rewrite the user's content.
  roundTrip: describeText(serializeMarkdown(editor)),
});
