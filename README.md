# Chrome Extensions

A personal monorepo of Chrome extensions I build and maintain. Each extension
lives in its own top-level directory with its own README and can be loaded
independently as an unpacked extension.

## Extensions

| Extension | Directory | What it does |
| --- | --- | --- |
| **FocusBlock** | [`focus-block/`](./focus-block) | Block time-wasting sites, run focus sessions, and take timed breaks (5 / 15 / 30 min). |

## Repository layout

```
chrome-extensions/
├── README.md          ← you are here
└── focus-block/       ← FocusBlock extension (see its own README)
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
