# 🎯 FocusBlock

**Keep your browsing in check.** FocusBlock blocks the sites that waste your
time, lets you run distraction-free focus sessions, and — when you genuinely
need a site — gives you a *timed* break instead of an all-or-nothing escape.

Built as a Manifest V3 extension with no third-party dependencies and no data
ever leaving your machine.

<p align="center">
  <img src="icons/icon128.png" width="96" alt="FocusBlock icon" />
</p>

## Features

- **Two block modes** — block a site **Always** (locked all the time) or
  **During Focus only** (usable normally, but locked whenever a focus session is
  running). Set it in one click from the popup, or manage both lists in Settings.
  An entry blocks exactly that site (`www.` included): blocking `youtube.com`
  leaves `music.youtube.com` alone — add a subdomain as its own entry to block it.
- **Redirect-friendly** — a blocked site gets a 3-second grace period before
  the block page appears, so sign-in flows, link shorteners, and other redirect
  chains that merely *pass through* a blocked site keep working.
- **A calm block page** — blocked sites redirect to a friendly page with a
  focus quote (switchable to a clean, quote-free page in Settings). Take a break
  or unblock from there and you land right back on the exact page you wanted.
- **Timed breaks** — need a site for a minute? Unblock it for **5, 15, or 30
  minutes** straight from the popup or the block page. It re-blocks itself
  automatically when time's up.
- **Focus Mode** — start a timed session (15 / 25 / 45 / 60 / 90 / 120 min).
  While it runs, your whole block list is locked *and temporary breaks are
  disabled* — so you can't talk yourself into "just five minutes." A live
  countdown shows in the popup, with an optional notification when you finish.
- **Usage insights** — a **Stats** tab tracks your *active* time per site
  (only while the tab is focused and you're actually at the keyboard). See
  today's total and a clickable 7-day chart: choose any day to see its usage
  and top sites. Open **Stats** in the full options page for all saved history,
  date filters, daily/monthly charts, weekday averages, searchable site totals,
  and complete daily details. Period and daily pie charts show the top seven
  sites plus an **Others** slice, with durations and percentages. Full tables
  remain available below each chart. New history is no longer pruned after 30 days;
  records deleted by older versions cannot be recovered. Tracking is on by default and can be
  toggled or cleared in Settings.
- **Combined usage** — focused browsing and background video/audio appear in
  one Stats view across HTTP(S) websites, including Prime Video, YouTube,
  YouTube Music, and embedded players. Overlapping activity on the same site
  counts once from version 1.3 onward. Existing daily totals are preserved by
  addition; historical overlap cannot be recovered and is flagged in the dashboard.
- **Password protection** — optionally require a password to unblock sites,
  edit your list, or end a focus session early, so it's harder to give in to
  impulse.
- **Activity indicator** — an optional badge on the toolbar icon shows when
  blocking is active.
- **100% local & private** — everything is stored in `chrome.storage.local`.
  No accounts, no servers, nothing uploaded.

## Install (load unpacked)

1. Go to `chrome://extensions` in Chrome / Brave / Edge.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `focus-block/` directory.
4. Pin FocusBlock to your toolbar.

> The prebuilt PNG icons are already included in [`icons/`](./icons). If you
> ever want to regenerate them, run `node scripts/gen-icons.mjs`.

## How to use

**Block a site.** Open the site, click the FocusBlock icon → **Block this
site**. Or open **Settings → Block Sites** and add domains manually.

**Take a break.** On a blocked site (or from the popup), pick **5 / 15 / 30
min**. The site unblocks temporarily and re-locks automatically.

**Focus session.** Popup → **Focus Mode** tab → choose a duration → **Start
focus**. Breaks are disabled until the timer ends.

**Lock it down.** Settings → **Password Protection** → set a password. You'll
then be asked for it before unblocking, editing the list, or ending focus early.

## How it works

The background service worker keeps a single source of truth in
`chrome.storage.local` and recomputes the set of currently-blocked sites
whenever anything changes (list edits, breaks, focus start/end):

- **New navigations.** When a tab navigates to a blocked site, a 3-second grace
  timer starts. When it ends, the worker checks where the tab *actually is*: if
  it's still on the blocked site it goes to the block page (carrying the
  original URL); if it redirected onward, it's left alone. Watching tabs rather
  than intercepting requests also catches PWAs (x.com, Gmail) that serve pages
  from their own service-worker cache.
- **Already-open tabs.** When a site *becomes* blocked (added, focus starts, a
  break ends), tabs already on it are sent to the block page immediately — once.
- **Unblocking.** When a site becomes allowed (break, focus ends, removed from
  the list), the block page sends itself back to the original URL.
- Timed breaks and focus sessions end via `chrome.alarms`; while Focus Mode is
  active, all breaks are ignored so the full list stays locked.

Password gating is enforced in the service worker: sensitive actions
(unblock / edit list / stop focus) require a SHA-256 password check before the
state is changed, so the popup and options pages can't bypass it.

## Project structure

```
focus-block/
├── manifest.json          # MV3 manifest
├── DESIGN.md              # the design system every surface follows
├── src/
│   └── background.js       # service worker: state, rules, timers, usage, messaging
├── styles/
│   └── app.css             # shared design-system stylesheet (tokens + components)
├── popup/                  # toolbar popup (Block · Focus · Stats tabs)
├── options/                # full settings page
├── blocked/                # the page shown when a site is blocked
├── icons/                  # generated PNG icons (16/32/48/128)
└── scripts/
    ├── gen-icons.mjs        # regenerates the icons (pure Node, no deps)
    └── test.mjs             # mocked-chrome logic tests for the service worker
```

## Design

The whole UI is driven by one design system — see **[`DESIGN.md`](./DESIGN.md)**.
Every surface links a single stylesheet (`styles/app.css`) that defines the
tokens (color, spacing, radius, elevation) and components (buttons, tabs,
toggles, chips, cards, charts). Nothing is styled ad-hoc, so the popup, options
page, and block page stay perfectly consistent.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Save your block list, settings, focus state, and local browsing/playback history. |
| `tabs` | See which site a tab is on, so blocked sites can be sent to the block page. |
| `alarms` | Re-block sites when a timed break or focus session ends, and flush usage periodically. |
| `idle` | Pause usage tracking when you step away, so only *active* time is counted. |
| `notifications` | Notify you when a focus session finishes. |

The manifest also injects a media observer into HTTP(S) pages and their frames,
requiring site access so playback can be detected independently of window focus.

## Privacy

FocusBlock collects nothing and sends nothing anywhere. The only outbound
requests are favicon lookups (`google.com/s2/favicons`) used to show site icons
in the UI. All of your data lives on your device.

## Validation

Run `node focus-block/scripts/test.mjs` and `node --test focus-block/scripts/*.test.mjs` from the repository root. No compilation is required; reload the unpacked extension after updating.

## Media tracking details

- HTML video/audio playback is measured from actual media progress, including
  muted playback, background tabs, picture-in-picture, and accessible shadow DOM.
  Browser audio detection supplements players using Web Audio or inaccessible DOM;
  its speaker indicator can linger for a couple of seconds after sound stops.
- Embedded players count under the host website. `www.youtube.com` is grouped
  with `youtube.com`; `music.youtube.com` remains separate. Overlapping browsing
  and players on the same domain count once. Simultaneous playback on different sites counts
  for each site, so even the playback total is not unique elapsed screen time.
- Paused/ended HTML players do not add time. Seeking and playback speed do not
  inflate duration. Long gaps after sleep are discarded, and midnight intervals
  split across local calendar dates.
- Turning off tracking in General disables both browsing and playback. Clear
  history clears both. Playback data starts with version 1.2 and cannot be
  reconstructed for earlier days.
- The content script needs site access to HTTP(S) pages and their frames. After
  updating the unpacked extension, reload it and refresh existing media tabs.
  Browser-protected pages and silent players inaccessible to content scripts
  cannot be measured. This tracks detected playback, not whether you watched it.
- Only per-domain durations and short-lived interval metadata are stored locally;
  no titles, video URLs, page text, or media content are collected.

Browser regression test (optional): install Playwright outside the extension,
then run `node focus-block/scripts/media-browser.mjs`. Set `PLAYWRIGHT_MODULE`
to its module path and `BROWSER_EXECUTABLE` to a Chromium browser executable if
using an existing installation. This creates and removes an isolated profile;
uses generated audio and fixture websites; and checks background, muted, embedded,
paused, disabled, and cleared playback plus the merged popup and full-page statistics.
