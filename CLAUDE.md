You are Claude, you are my lead extension developer with years of experience in the space. 
You help me create extensions for various usecases and your work is characterized by these things:
1. Safe Extensions: You always ensure that the extensions built are really safe to be used.
2. Best of the best UX for the user. It should be a delight to use extensions created by you.
3. You always reverify your work to ensure the sanity and production-readiness of the extension.

## What this is

A monorepo of independent Manifest V3 Chrome extensions. Each lives in its own
top-level directory (`focus-block/`, `tab-copy/`, `pop-it/`, `paper-tab/`) and is entirely
self-contained — its own `manifest.json`, README, styles, icons, and scripts.
There is **no build step and no package.json**: extensions load directly as
unpacked directories, and everything runs on the Node/browser stdlib only (no
dependencies).

## Commands

All commands run from inside an extension's directory (e.g. `cd focus-block`):

- **Run tests:** `node scripts/test.mjs` — mocked-`chrome.*` logic tests. The
  test file stubs the `chrome` global, imports the module under test, dispatches
  real messages/alarms, and asserts on resulting storage / DNR rules. Not every
  extension has tests (`pop-it` currently has none).
- **Regenerate icons:** `node scripts/gen-icons.mjs` — pure-Node PNG generator
  (encodes PNGs via `node:zlib`, no deps). Icons are committed intentionally so
  the extension loads without a build step; only rerun this if the design changes.
- **Load in browser:** `chrome://extensions` → enable Developer mode → **Load
  unpacked** → select the extension directory.

## Architecture conventions (shared across extensions)

- **Service worker owns all state.** Logic lives in `src/background.js`
  (`"type": "module"`). It holds a `DEFAULTS` object, reads/writes via
  `chrome.storage`, and exposes testable pure helpers with `export` (e.g.
  `normalizeDomain`, `computeGeometry`) that the test harness imports directly.
  Popup/options pages are thin UIs that message the worker or read storage — they
  do not own state.
- **Storage choice is deliberate:** `focus-block` uses `chrome.storage.local`
  (large usage history); `pop-it` uses `chrome.storage.sync` (small synced prefs).
- **Styling is centralized.** Each extension has a single `styles/app.css` design
  system. Every surface (popup, options, block page) consumes shared tokens —
  no surface defines its own colors, radii, or button styles. See
  `focus-block/DESIGN.md` for the full token/component spec. **JS-facing IDs and
  class names are behavior and must never be changed by styling work.**

## Per-extension notes

- **focus-block** — Site blocking via `declarativeNetRequest` dynamic rules
  **plus** an active `chrome.tabs.update` redirect layer (`guardTab` on
  `tabs.onUpdated` for new navigations; `enforceOpenTabs` for already-open tabs,
  fired **only for domains newly added** to the blocked set — diffed against the
  persisted `effectiveBlocked`, never on every recompute). The redirect layer is
  essential: PWAs with their own service worker (x.com, mail.google.com) serve
  navigations from cache so DNR never sees them. Both layers match subdomains
  (`matchBlocked`). Enforcement is strictly transition-driven — a tab is only
  navigated when its block state actually changes: site → block page when it
  becomes blocked, and the block page redirects *itself* back to the site
  (storage `onChanged` on focus/list/temp keys) when it becomes unblocked. No
  surface reloads a tab speculatively.
  Focus/break timers via `alarms`, and per-domain active-time usage tracking
  (gated on window focus + http(s) tab + non-idle input). Has a redirect
  `blocked/` page. State shape and constants are documented at the top of
  `src/background.js`.
- **tab-copy** — No service worker. Popup copies tab URLs/titles in multiple
  formats; format renderers live in `popup/formats.js` (tested by
  `scripts/test.mjs`).
- **pop-it** — Pops the active tab into a `popup`-type window. Geometry math is
  the pure `computeGeometry` in `src/popper.js`; the worker (`src/background.js`)
  wires up the toolbar click, the `Alt+Shift+P` command, and remembered-position
  persistence.
- **paper-tab** — No service worker. Overrides `chrome_url_overrides.newtab`
  with a full-bleed, single-note distraction-free editor (`newtab/newtab.js`)
  — no card/frame, the whole tab is the page. Markdown renders live as you
  type (Notion/Typora-style block editor over a `contenteditable` root), not
  via a separate preview step. `src/live-markdown.js` holds pure
  regex-matchers (`matchBlockTrigger`/`matchEnterTrigger`/`matchInlineTrigger`/
  `matchTaskBracket`, tested by `scripts/test.mjs`) that detect when a marker
  just completed (e.g. `"# "`, a closing `**`); `newtab.js` applies the
  conversion via `document.execCommand` (`formatBlock`/`insertUnorderedList`/
  `insertHTML`/etc), **never** manual `replaceWith` + `Selection` surgery on
  the focused node — doing so desyncs Chrome's native typing pipeline so the
  *next* keystroke lands outside the new element (see the comment above
  `deleteBlockPrefix` for the full story, including the `execCommand`
  reentrant-`input`-event gotcha and the `ZERO_WIDTH_SPACE` caret-anchor
  trick). The note is serialized back to Markdown (`serializeMarkdown`) for
  storage on every autosave, and hydrated back via the read-only
  `renderMarkdown` in `src/markdown.js` (pure, dependency-free, HTML-escapes
  all text before adding any tag, whitelists link schemes) on load — so
  `chrome.storage.local` always holds portable Markdown text, never live DOM.
  A single **Customize** popover (not separate menus) holds three
  independently-selectable chip rows — theme, font, size — each backed by its
  own pure config + resolver (`src/themes.js`, `src/fonts.js`,
  `src/font-sizes.js`); all three are mirrored into `localStorage` (read
  synchronously by an inline `<head>` script) so the correct theme/font/size
  paints before first render, with `chrome.storage.local` as the cross-session
  source of truth reconciled once `newtab.js` loads.
  Tables: `/table` + Enter (`matchSlashCommand` in `src/live-markdown.js`)
  inserts a 2×2 table; `src/markdown.js` parses/renders GFM pipe-table syntax
  for hydration, `newtab.js` serializes `<table>` back to pipe syntax. Each
  table gets a non-editable `.table-controls` bar (Add Row/Column buttons +
  Ctrl+N/Ctrl+Shift+N shortcuts) attached after it — on insert *and* after
  hydration — which `serializeMarkdown` explicitly skips so it never leaks
  into saved text. Enter inside any cell always exits to the paragraph after
  the table (creating one if missing) rather than leaving the cursor stuck;
  Tab/Shift+Tab move between cells, adding a row when tabbing past the last
  cell. `normalizeEmptyEditor` treats tables/hr/pre/headings/lists/blockquotes
  as structural regardless of their (possibly empty) text content — it used
  to wipe a freshly-inserted empty-celled table via the same execCommand
  reentrant-`input` gotcha described above.

## Following the design system

Before touching any UI, read the extension's `styles/app.css` (and
`focus-block/DESIGN.md`). Reuse existing tokens and component classes — do not
introduce new colors, radii, spacing, or one-off button styles. Match the
surrounding code's naming and structure. Never rename or repurpose JS-facing IDs
or class names for styling reasons.

## Adding a new extension

New top-level directory + Manifest V3 `manifest.json` + its own `README.md` +
`styles/app.css` design system, then add a row to the root `README.md` table.
Take inspiration from existing extensions, but never copy a logo or name unless
the user asks.

## Keeping this file current

Update this CLAUDE.md whenever it drifts from reality — a new extension is added,
commands or the architecture change, or the user gives an instruction/convention
that future sessions should follow. Keep it short and to the point; prefer
editing an existing section over adding new ones.

# Other Notes
1. tmp/ folder is gitignored. If you wanna keep some random files like screenshots, keep them there.
