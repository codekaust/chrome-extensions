# TabCopy

Copy tab URLs and titles to your clipboard in whatever format you need — a
single tab, the whole window, or every tab across every window.

## Features

**Scopes**

- **This tab** — the active tab
- **Selected tabs** — all highlighted tabs in the current window
- **This window's tabs** — every tab in the current window
- **All tabs** — every tab across all windows
- **All tabs by window** — every tab, grouped and labelled per window

**Formats** (`Copy as:`)

`URL` · `Title: URL` · `Title & URL` · `Title` · `Markdown` · `BBCode` ·
`CSV` · `JSON` · `HTML` · `HTML table`

Your chosen format is remembered and can be set as a default in **Options**.

## Install (unpacked)

1. Go to `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this `tab-copy/` directory.
3. Pin **TabCopy** to the toolbar.

## Regenerating icons

```
node scripts/gen-icons.mjs
```

## Running tests

```
node scripts/test.mjs
```
