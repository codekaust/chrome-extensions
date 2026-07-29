# PaperTab

Open a new tab and trap your best thoughts. A distraction-free notepad that
replaces Chrome's New Tab page — the whole tab is the page, write in plain
text or full Markdown, and it autosaves locally as you type. No accounts,
no syncing, nothing to set up.

## How it works

Every new tab is a blank page, edge to edge. Just start typing — your note
saves itself a moment after you stop (watch the **Saved** indicator in the
corner). Markdown renders live as you type, the way Notion or Typora do —
there's no separate preview mode:

- Type `# `, `## `, … at the start of a line for a heading
- Type `- ` or `* ` for a bullet, `1. ` for a numbered list, `> ` for a quote
- Type `- [ ] ` for a checklist item — pressing Enter continues the checklist
  automatically, no need to retype the brackets each line
- Wrap text in `**bold**`, `*italic*`, `~~strikethrough~~`, or `` `code` `` —
  it formats the instant you type the closing marker
- Paste or type `[text](url)` for a link (click to place your cursor;
  <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>-click to open it)
- Type <code>```</code> then Enter for a code block (Enter inserts a newline
  inside it; <kbd>Esc</kbd> exits back to a normal paragraph)
- Type `---` then Enter for a horizontal rule
- Type `/table` then Enter for a table — see below
- <kbd>Backspace</kbd> at the very start of a heading/list/quote/code block
  turns it back into a plain paragraph

### Tables

Type `/table` at the start of a line and press Enter to insert a 2×2 table.
Inside a table:

- <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> moves to the next/previous
  cell — tabbing past the last cell adds a new row automatically
- <kbd>Enter</kbd> always exits the table to the paragraph below it (creating
  one if needed), so you're never stuck inside; <kbd>Shift</kbd>+<kbd>Enter</kbd>
  adds a line break within the current cell instead
- Click **+ Row** (<kbd>Ctrl</kbd>+<kbd>N</kbd>) or **+ Column**
  (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>) below the table to grow it
  explicitly

### Customize

Click **Customize** (bottom-left) for a single panel with everything:

- **Theme** — **System** (follows your OS light/dark setting), **Light**,
  **Sepia**, **Dark**, **Forest**, or **Slate**
- **Font** — **Serif**, **Elegant**, **Classic**, **Sans**, **Rounded**,
  **Mono**, or **Casual**
- **Size** — **S**, **M**, **L**, or **XL**

All three are saved locally and applied instantly on the next new tab — no
flash of the wrong theme, font, or size.

## Install (unpacked)

1. Go to `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this `paper-tab/` directory.
3. Open a new tab.

## Regenerating icons

```
node scripts/gen-icons.mjs
```

## Running tests

```
node scripts/test.mjs
```

## Debugging note loss

Every step of the persistence path logs to the tab's console (`page:load`,
`init:read-done`, `hydrate:*`, `save:scheduled` → `save:write` → `save:ok`,
`storage:changed`, `sync:apply`/`sync:skip`), prefixed with a per-tab id so logs
from several tabs can be interleaved. Note text is never logged verbatim — only
its length, an FNV-1a fingerprint, and a short head/tail preview.

Right-click a PaperTab tab → **Inspect** → Console, then:

- `__paperTab.copy()` — full transcript for this tab to the clipboard
- `__paperTab.state()` — this tab's live persistence state
- `__paperTab.peek()` — what `chrome.storage.local` holds right now

The ring buffer records even with console output silenced
(`localStorage.setItem("paperTabLog", "off")`).
