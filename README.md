# Chrome Extensions

A personal monorepo of Chrome extensions I build and maintain. Each extension
lives in its own top-level directory with its own README and can be loaded
independently as an unpacked extension.

## Extensions

| Extension | Directory | What it does |
| --- | --- | --- |
| **FocusBlock** | [`focus-block/`](./focus-block) | Block time-wasting sites, run focus sessions, and take timed breaks (5 / 15 / 30 min). |
| **TabCopy** | [`tab-copy/`](./tab-copy) | Copy tab URLs/titles in any format (Link, Markdown, JSON, CSV, HTML…) for one tab, a window, or all windows. |
| **PopIt** | [`pop-it/`](./pop-it) | Pop the current tab out into its own compact popup window with one click. |
| **PaperTab** | [`paper-tab/`](./paper-tab) | A distraction-free New Tab notepad with live Markdown formatting that autosaves locally. |

## Repository layout

```
chrome-extensions/
├── README.md          ← you are here
├── focus-block/       ← FocusBlock extension (see its own README)
├── tab-copy/          ← TabCopy extension (see its own README)
├── pop-it/            ← PopIt extension (see its own README)
└── paper-tab/         ← PaperTab extension (see its own README)
```

Each extension folder is self-contained. To work on one, open its directory and
follow the install instructions in that extension's `README.md`.

## Loading an unpacked extension (general steps)

1. Open your Chromium browser (Chrome, Brave, Edge…) and go to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the extension's directory.
4. Pin it to the toolbar and you're ready to go.

## Adding a new extension

Create a new top-level directory, add a `manifest.json` (Manifest V3), and give
it its own `README.md`. Then add a row to the table above.
It is great to take inspiration from existing extensions, but never copy its logo or name unless asked by the user.
