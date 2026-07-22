// FocusBlock service worker — owns all state, blocking rules, timers & notifications.

const DEFAULTS = {
  blockedSites: [],          // always blocked — hostnames, e.g. "youtube.com"
  focusSites: [],            // blocked only while a focus session is active
  tempUnblocks: {},          // { hostname: endsAtEpochMs }
  focus: { active: false, endsAt: null, durationMin: 25 },
  settings: {
    activityIndicator: true,
    cleanBlockPage: false,
    notifyCycle: true,
    soundCycle: false,
    startPaused: false,
    trackUsage: true,        // measure active time per site
  },
  password: null,            // { hash } sha-256 hex, or null
  usage: {},                 // { "YYYY-MM-DD": { domain: seconds } }
  session: null,             // { domain, since } — the in-progress active session
  effectiveBlocked: [],      // domains blocked as of the last recompute (for diffing)
};

const IDLE_THRESHOLD = 30;   // seconds of no input before we stop counting
const MAX_TICK = 130;        // ignore deltas larger than this (sleep/suspend gaps)
const RETAIN_DAYS = 30;      // keep this many days of usage history

// ---------- storage helpers ----------
async function getState() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const state = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (stored[k] !== undefined) state[k] = stored[k];
  }
  return state;
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

// ---------- domain helpers ----------
export function normalizeDomain(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.split(':')[0]; // drop port
  if (!s || !s.includes('.')) return null;
  return s;
}

function now() {
  return Date.now();
}

// ---------- usage tracking ----------
function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// What domain (if any) is the user *actively* viewing right now?
// Active := a focused browser window, an http(s) tab, and non-idle input.
async function computeActiveDomain() {
  const state = await getState();
  if (!state.settings.trackUsage) return null;
  let win;
  try { win = await chrome.windows.getLastFocused(); } catch { return null; }
  if (!win || !win.focused) return null;
  let tabs;
  try { tabs = await chrome.tabs.query({ active: true, windowId: win.id }); } catch { return null; }
  const tab = tabs && tabs[0];
  if (!tab || !/^https?:\/\//.test(tab.url || '')) return null;
  let idle = 'active';
  try { idle = await chrome.idle.queryState(IDLE_THRESHOLD); } catch { /* keep active */ }
  if (idle !== 'active') return null;
  return normalizeDomain(tab.url);
}

// Credit elapsed time to the current session's domain, then advance `since`.
async function flushUsage(t) {
  const state = await getState();
  if (!state.session) return;
  const elapsed = (t - state.session.since) / 1000;
  const usage = { ...state.usage };
  if (elapsed > 0 && elapsed <= MAX_TICK) {
    const day = dayKey(t);
    usage[day] = { ...(usage[day] || {}) };
    usage[day][state.session.domain] =
      (usage[day][state.session.domain] || 0) + elapsed;
  }
  pruneUsage(usage, t);
  await setState({ usage, session: { domain: state.session.domain, since: t } });
}

function pruneUsage(usage, t) {
  const cutoff = dayKey(t - RETAIN_DAYS * 86_400_000);
  for (const day of Object.keys(usage)) {
    if (day < cutoff) delete usage[day];
  }
}

// Flush, then re-evaluate what we should be tracking.
async function updateSession() {
  const t = now();
  await flushUsage(t);
  const domain = await computeActiveDomain();
  await setState({ session: domain ? { domain, since: t } : null });
}

function buildStats(state, t) {
  const today = dayKey(t);
  const todayMap = state.usage[today] || {};
  const todayList = Object.entries(todayMap)
    .map(([domain, seconds]) => ({ domain, seconds: Math.round(seconds) }))
    .sort((a, b) => b.seconds - a.seconds);
  const todayTotal = todayList.reduce((a, b) => a + b.seconds, 0);

  // last 7 days (oldest → newest) for the bar chart
  const days = [];
  let weekTotal = 0;
  for (let i = 6; i >= 0; i--) {
    const key = dayKey(t - i * 86_400_000);
    const map = state.usage[key] || {};
    const total = Math.round(Object.values(map).reduce((a, b) => a + b, 0));
    days.push({ key, total });
    weekTotal += total;
  }
  return { today: todayList, todayTotal, weekTotal, days };
}

// ---------- rule computation ----------
// The set of domains that should be blocked right now, given focus + temp breaks:
//  • always-blocked sites: enforced always (minus active temp-breaks, which
//    are ignored while a focus session runs);
//  • focus-only sites: enforced only while a focus session is active.
export function computeEffectiveBlocked(state, t) {
  const focusActive = state.focus.active && state.focus.endsAt && state.focus.endsAt > t;
  const temp = state.tempUnblocks || {};
  const effective = [];
  for (const dom of state.blockedSites) {
    if (focusActive) { effective.push(dom); continue; }
    const until = temp[dom];
    if (!(until && until > t)) effective.push(dom);
  }
  if (focusActive) {
    for (const dom of state.focusSites) {
      if (!effective.includes(dom)) effective.push(dom);
    }
  }
  return effective;
}

function blockPageUrl(dom) {
  return chrome.runtime.getURL(`blocked/blocked.html?site=${encodeURIComponent(dom)}`);
}

// Which blocked entry (if any) covers this domain? Matches the entry itself and
// its subdomains (e.g. "x.com" covers "mobile.x.com"), mirroring how the
// declarativeNetRequest `requestDomains` condition behaves.
export function matchBlocked(dom, blockedSet) {
  if (!dom) return null;
  for (const b of blockedSet) {
    if (dom === b || dom.endsWith(`.${b}`)) return b;
  }
  return null;
}

async function recomputeRules() {
  const state = await getState();
  const t = now();

  // prune expired temp unblocks
  let changed = false;
  const temp = { ...state.tempUnblocks };
  for (const [dom, endsAt] of Object.entries(temp)) {
    if (endsAt <= t) {
      delete temp[dom];
      changed = true;
    }
  }
  if (changed) await setState({ tempUnblocks: temp });

  // focus expiry
  let focus = state.focus;
  if (focus.active && focus.endsAt && focus.endsAt <= t) {
    focus = { ...focus, active: false, endsAt: null };
    await setState({ focus });
    await onFocusFinished(state.settings);
  }

  const focusActive = focus.active && focus.endsAt && focus.endsAt > t;
  const effective = computeEffectiveBlocked({ ...state, tempUnblocks: temp, focus }, t);

  const rules = effective.map((dom, i) => ({
    id: i + 1,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: {
        extensionPath: `/blocked/blocked.html?site=${encodeURIComponent(dom)}`,
      },
    },
    condition: {
      requestDomains: [dom],
      resourceTypes: ['main_frame'],
    },
  }));

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: rules,
  });

  // Only act on a *transition*. When a domain newly becomes blocked (focus
  // starts, a site is added, a break ends) we redirect any tab already sitting
  // on it — once. Domains that were already blocked need nothing (their tabs are
  // already on the block page), and domains that just became *unblocked* are
  // handled by the block page redirecting itself. This is the whole point: no
  // reloading unless a tab's block state actually changed.
  const prev = state.effectiveBlocked || [];
  const added = effective.filter((d) => !prev.includes(d));
  const setChanged = added.length > 0 || prev.some((d) => !effective.includes(d));
  if (added.length) await enforceOpenTabs(added);
  if (setChanged) await setState({ effectiveBlocked: effective });

  await updateBadge(state.settings, focusActive, effective.length);
  await scheduleNextAlarm(temp, focus);
}

// Send every open http(s) tab that's on a currently-blocked domain to the block
// page. Block-page tabs are chrome-extension:// URLs (excluded by the query and
// by normalizeDomain), so they never match again — no redirect loop.
async function enforceOpenTabs(blockedSet) {
  if (!blockedSet.length || !chrome.tabs?.query) return;
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  } catch {
    return;
  }
  for (const tab of tabs || []) {
    const hit = matchBlocked(normalizeDomain(tab.url), blockedSet);
    if (hit && tab.id != null) {
      try { await chrome.tabs.update(tab.id, { url: blockPageUrl(hit) }); } catch { /* tab gone */ }
    }
  }
}

// Navigation-time guard: if a tab navigates to a blocked domain, redirect it to
// the block page. This is the reliable backstop for service-worker-served pages
// that slip past the declarativeNetRequest rule.
async function guardTab(tabId, url) {
  if (!/^https?:\/\//.test(url || '')) return;
  const dom = normalizeDomain(url);
  if (!dom) return;
  const state = await getState();
  const hit = matchBlocked(dom, computeEffectiveBlocked(state, now()));
  if (hit) {
    try { await chrome.tabs.update(tabId, { url: blockPageUrl(hit) }); } catch { /* tab gone */ }
  }
}

async function updateBadge(settings, focusActive, count) {
  if (focusActive) {
    await chrome.action.setBadgeText({ text: 'ON' });
    await chrome.action.setBadgeBackgroundColor({ color: '#4F46E5' });
  } else if (settings.activityIndicator && count > 0) {
    await chrome.action.setBadgeText({ text: ' ' });
    await chrome.action.setBadgeBackgroundColor({ color: '#6366F1' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

async function scheduleNextAlarm(temp, focus) {
  await chrome.alarms.clear('recompute');
  const times = [];
  for (const endsAt of Object.values(temp)) times.push(endsAt);
  if (focus.active && focus.endsAt) times.push(focus.endsAt);
  if (times.length) {
    const next = Math.min(...times);
    chrome.alarms.create('recompute', { when: next + 500 });
  }
}

async function onFocusFinished(settings) {
  if (settings.notifyCycle) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'FocusBlock',
      message: 'Focus session complete. Nice work! 🎯',
      priority: 2,
    });
  }
}

// ---------- password ----------
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- message API ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const state = await getState();
    switch (msg.type) {
      case 'getState': {
        sendResponse({ ok: true, state });
        break;
      }
      case 'blockSite': {
        const dom = normalizeDomain(msg.domain);
        if (!dom) return sendResponse({ ok: false, error: 'Invalid site' });
        const mode = msg.mode === 'focus' ? 'focus' : 'always';
        // Moving an always-blocked site to focus-only makes it reachable outside
        // focus sessions — a form of unblocking — so it's password-gated, exactly
        // like unblockSite. Adding a new site or tightening focus→always is free.
        if (mode === 'focus' && state.blockedSites.includes(dom)) {
          const gate = await requirePassword(state, msg.password);
          if (!gate.ok) return sendResponse(gate);
        }
        // a site lives in exactly one list — moving modes removes it from the other
        const blocked = state.blockedSites.filter((d) => d !== dom);
        const focusList = state.focusSites.filter((d) => d !== dom);
        if (mode === 'always') blocked.push(dom);
        else focusList.push(dom);
        await setState({ blockedSites: blocked, focusSites: focusList });
        await recomputeRules();
        sendResponse({ ok: true, mode });
        break;
      }
      case 'unblockSite': {
        const dom = normalizeDomain(msg.domain);
        const gate = await requirePassword(state, msg.password);
        if (!gate.ok) return sendResponse(gate);
        const list = state.blockedSites.filter((d) => d !== dom);
        const focusList = state.focusSites.filter((d) => d !== dom);
        const temp = { ...state.tempUnblocks };
        delete temp[dom];
        await setState({ blockedSites: list, focusSites: focusList, tempUnblocks: temp });
        await recomputeRules();
        sendResponse({ ok: true });
        break;
      }
      case 'tempUnblock': {
        const dom = normalizeDomain(msg.domain);
        if (!dom) return sendResponse({ ok: false, error: 'Invalid site' });
        if (state.focus.active && state.focus.endsAt > now()) {
          return sendResponse({ ok: false, error: 'Focus mode is active — breaks are disabled.' });
        }
        const temp = { ...state.tempUnblocks, [dom]: now() + msg.minutes * 60_000 };
        await setState({ tempUnblocks: temp });
        await recomputeRules();
        sendResponse({ ok: true, endsAt: temp[dom] });
        break;
      }
      case 'reblockNow': {
        const dom = normalizeDomain(msg.domain);
        const temp = { ...state.tempUnblocks };
        delete temp[dom];
        await setState({ tempUnblocks: temp });
        await recomputeRules();
        sendResponse({ ok: true });
        break;
      }
      case 'setBlockedList': {
        const gate = await requirePassword(state, msg.password);
        if (!gate.ok) return sendResponse(gate);
        const cleaned = [...new Set(
          (msg.list || []).map(normalizeDomain).filter(Boolean)
        )];
        await setState({ blockedSites: cleaned });
        await recomputeRules();
        sendResponse({ ok: true, list: cleaned });
        break;
      }
      case 'startFocus': {
        const dur = Math.max(1, msg.minutes || 25);
        const focus = { active: true, endsAt: now() + dur * 60_000, durationMin: dur };
        await setState({ focus });
        await recomputeRules();
        sendResponse({ ok: true, focus });
        break;
      }
      case 'stopFocus': {
        const gate = await requirePassword(state, msg.password);
        if (!gate.ok) return sendResponse(gate);
        await setState({ focus: { active: false, endsAt: null, durationMin: state.focus.durationMin } });
        await recomputeRules();
        sendResponse({ ok: true });
        break;
      }
      case 'setSetting': {
        await setState({ settings: { ...state.settings, [msg.key]: msg.value } });
        await recomputeRules();
        sendResponse({ ok: true });
        break;
      }
      case 'setPassword': {
        // to change/remove an existing password you must supply the old one
        if (state.password) {
          const gate = await requirePassword(state, msg.oldPassword);
          if (!gate.ok) return sendResponse(gate);
        }
        const password = msg.password ? { hash: await sha256(msg.password) } : null;
        await setState({ password });
        sendResponse({ ok: true });
        break;
      }
      case 'verifyPassword': {
        const gate = await requirePassword(state, msg.password);
        sendResponse(gate);
        break;
      }
      case 'getStats': {
        await updateSession(); // count the in-progress session up to now
        const fresh = await getState();
        sendResponse({ ok: true, stats: buildStats(fresh, now()) });
        break;
      }
      case 'clearStats': {
        const gate = await requirePassword(state, msg.password);
        if (!gate.ok) return sendResponse(gate);
        await setState({ usage: {}, session: null });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message' });
    }
  })();
  return true; // async
});

async function requirePassword(state, provided) {
  if (!state.password) return { ok: true };
  if (!provided) return { ok: false, error: 'Password required', needsPassword: true };
  const hash = await sha256(provided);
  if (hash === state.password.hash) return { ok: true };
  return { ok: false, error: 'Incorrect password', needsPassword: true };
}

// ---------- lifecycle ----------
function bootstrap() {
  recomputeRules();
  try { chrome.idle.setDetectionInterval(IDLE_THRESHOLD); } catch { /* ignore */ }
  chrome.alarms.create('flush', { periodInMinutes: 1 });
  updateSession();
}

chrome.runtime.onInstalled.addListener(bootstrap);
chrome.runtime.onStartup.addListener(bootstrap);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'recompute') recomputeRules();
  if (alarm.name === 'flush') updateSession();
});

// usage-tracking signals
chrome.tabs.onActivated.addListener(() => updateSession());
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url) guardTab(tabId, info.url);   // enforce blocks as soon as a nav starts
  if (tab.active && (info.url || info.status === 'complete')) updateSession();
});
chrome.windows.onFocusChanged.addListener(() => updateSession());
chrome.idle.onStateChanged.addListener(() => updateSession());

// keep rules fresh + start tracking when the worker spins up
bootstrap();
