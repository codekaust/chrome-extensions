# TabLoop

Auto-refresh any tab on a timer — a safer, minimal replacement for extensions
like "Easy Auto Refresh." Pick a preset interval or set a custom one, hit
**Start**, and TabLoop reloads that tab in the background for as long as it
stays open, even in another window.

## Why it's safe

- **No `tabs` or host permissions, no content scripts, no network calls.**
  TabLoop only asks for `alarms` and `storage`. Every `chrome.tabs` call it
  makes (checking a tab still exists, reloading it by id) uses fields Chrome
  always populates regardless of permissions — it never reads a tab's URL,
  title, or page content.
- **Minimum interval of 3 seconds** so a typo can't turn into a reload storm
  against a real server.
- **Per-tab, not global.** Enabling TabLoop on one tab never touches any
  other tab.
- **No silent resurrection.** Closing a tab immediately cancels its loop. A
  full browser restart clears every loop rather than guessing whether a
  restored tab id still means the same tab — you re-enable it if you still
  want it.

## How it works

1. Click the **TabLoop** toolbar icon on the tab you want to auto-refresh.
2. Pick a preset (10s – 1h) or type a custom value + unit.
3. Click **Start**. The toolbar badge shows a ⟳ while that tab is looping.
4. Click **Stop** (or close the tab) to end it.

## Install (unpacked)

1. Go to `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this `tab-loop/` directory.
3. Pin **TabLoop** to the toolbar.

## Regenerating icons

```
node scripts/gen-icons.mjs
```

## Running tests

```
node scripts/test.mjs
```
