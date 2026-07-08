# PopIt

Pop the current tab out into its own compact **popup window** with a single
click — perfect for keeping a video, chat, calculator or reference page
floating above your work.

## How it works

Click the **PopIt** toolbar button (or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>)
and the active tab is moved into a clean, chrome-less popup window sized and
positioned to your liking. The tab keeps its state — nothing reloads.

## Options

- **Width / Height** — the popup's dimensions
- **Position** — center on the current window, pin to a corner, or remember
  where you last dragged it
- **Focus** — whether the popup grabs focus when it opens

The keyboard shortcut can be re-mapped at `chrome://extensions/shortcuts`.

## Install (unpacked)

1. Go to `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this `pop-it/` directory.
3. Pin **PopIt** to the toolbar.

## Regenerating icons

```
node scripts/gen-icons.mjs
```

## Running tests

```
node scripts/test.mjs
```
