// Diagnostic logging for the note persistence path.
//
// PaperTab is one note shared by every open tab, so every "my text vanished"
// report is really a question about ordering: which tab saved, which tab read,
// and which tab decided its own copy should win. Every line therefore carries
// a per-page TAB id plus a monotonic timestamp, so logs collected from several
// tabs can be interleaved and reconstructed after the fact.
//
// Note text is never logged verbatim (a note is private) — only its length, a
// cheap fingerprint, and a short head/tail preview, which is enough to tell
// "the same content" from "different content" and to spot a truncated save.
//
// Console output is on by default; silence it with
//   localStorage.setItem("paperTabLog", "off")
// The in-memory ring buffer keeps recording either way, so a full session can
// still be recovered from any tab via `__paperTab.copy()`.

const MAX_ENTRIES = 600;
const PREVIEW_CHARS = 60;

const TAB = Math.random().toString(36).slice(2, 6);
const STARTED_AT = new Date().toISOString();
const entries = [];

let consoleEnabled = true;
try {
  consoleEnabled = localStorage.getItem("paperTabLog") !== "off";
} catch {
  // localStorage can throw in locked-down profiles — keep logging anyway.
}

function elapsed() {
  return (performance.now() / 1000).toFixed(3);
}

// Cheap, stable content fingerprint (FNV-1a). Lets two tabs' logs be compared
// for "is this literally the same note?" without either dumping the note.
export function fingerprint(text) {
  if (typeof text !== "string") return String(text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Describes a note payload without exposing it: how big, what it fingerprints
// to, and just enough head/tail to recognize truncation or an empty save.
export function describeText(text) {
  if (text == null) return { value: text === null ? "null" : "undefined" };
  if (typeof text !== "string") return { type: typeof text };
  const visible = (s) => s.replace(/\n/g, "\\n").replace(/\u200B/g, "<zwsp>").replace(/\u00A0/g, "<nbsp>");
  return {
    len: text.length,
    hash: fingerprint(text),
    head: visible(text.slice(0, PREVIEW_CHARS)),
    tail: text.length > PREVIEW_CHARS * 2 ? visible(text.slice(-PREVIEW_CHARS)) : undefined,
  };
}

function emit(level, event, data) {
  const entry = { at: new Date().toISOString(), s: Number(elapsed()), tab: TAB, level, event };
  if (data !== undefined) entry.data = data;
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();

  if (!consoleEnabled) return;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  // Serialized inline rather than passed as a second argument: DevTools collapses
  // an object argument to "Object", and copying the console then yields log lines
  // with the payload missing — exactly the data a bug report needs.
  const payload = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  sink(`[PaperTab ${TAB} +${elapsed()}s] ${event}${payload}`);
}

export const log = (event, data) => emit("info", event, data);
log.warn = (event, data) => emit("warn", event, data);
log.error = (event, data) => emit("error", event, data);
log.tab = TAB;

// Plain-text transcript — this is what gets pasted into a bug report.
function transcript() {
  const header = `PaperTab log — tab ${TAB}, started ${STARTED_AT}, ${entries.length} entries`;
  const lines = entries.map((e) => {
    const body = e.data === undefined ? "" : ` ${JSON.stringify(e.data)}`;
    return `+${e.s.toFixed(3)}s [${e.tab}] ${e.level === "info" ? "" : e.level.toUpperCase() + " "}${e.event}${body}`;
  });
  return [header, ...lines].join("\n");
}

// Exposed on window so the log can be retrieved from the console of a tab that
// has already reproduced the bug — including a background tab whose console
// output was never being watched.
export function installDebugHandle(extra = {}) {
  window.__paperTab = {
    tab: TAB,
    startedAt: STARTED_AT,
    entries,
    text: transcript,
    dump: () => {
      console.log(transcript());
      return `${entries.length} entries`;
    },
    copy: async () => {
      const text = transcript();
      try {
        await navigator.clipboard.writeText(text);
        return `copied ${entries.length} entries to clipboard`;
      } catch (err) {
        console.log(text);
        return `clipboard blocked (${err?.message}) — transcript printed above instead`;
      }
    },
    // Reads storage right now, out of band from the page's own state, to answer
    // "what does the profile actually hold at this instant?"
    peek: async () => {
      const { note } = await chrome.storage.local.get("note");
      const detail = { updatedAt: note?.updatedAt, updatedAtISO: note?.updatedAt && new Date(note.updatedAt).toISOString(), ...describeText(note?.text) };
      console.log("[PaperTab] storage.local note:", detail);
      return detail;
    },
    ...extra,
  };
  log("debug:handle-ready", { hint: "run __paperTab.copy() in this tab's console to grab the full log" });
}
