import { dayKey, buildStats, mergeHistory } from './stats.js';
import { creditMedia, creditCombined } from './media.js';
import { clampLimit, isLimitReached, isLoosening, limitRemaining, nextMidnight } from './limits.js';

// FocusBlock service worker — owns all state, blocking, timers & notifications.

const DEFAULTS = {
  blockedSites: [],          // always blocked — hostnames, e.g. "youtube.com"
  focusSites: [],            // blocked only while a focus session is active
  timeLimits: {},            // { hostname: minutesPerDay } — blocked once today's usage hits it
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
  combinedUsage: null,        // union of browsing and playback per site
  combinedCoverage: {},
  combinedSince: 0,
  legacyCombined: false,
  mediaUsage: {},             // separate playback time; may overlap focused browsing
  mediaCoverage: {},          // recent credited intervals, deduplicated per domain
  mediaAudible: {},           // fallback sessions for tabs producing browser audio
  mediaCutoff: 0,             // ignore reports from before clear/disable/enable
  session: null,             // { domain, since } — the in-progress active session
  effectiveBlocked: [],      // domains blocked as of the last recompute (for diffing)
};

const IDLE_THRESHOLD = 30;   // seconds of no input before we stop counting
const MAX_TICK = 130;        // ignore deltas larger than this (sleep/suspend gaps)

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

// Serialize state mutations from tabs, frames, alarms and UI messages. This
// prevents concurrent read/modify/write operations losing usage or undoing clear.
let operation = Promise.resolve();
function enqueue(fn) {
  const result = operation.then(fn);
  operation = result.catch(error => console.error('FocusBlock:', error));
  return result;
}

// Browser audio supplements DOM players (e.g. Web Audio or closed shadow roots).
// Chrome's audible indicator can linger briefly after sound stops.
async function updateMediaAudible() {
  const t = now();
  const state = await getState();
  if (!state.settings.trackUsage) return;
  Object.assign(state, creditCombined(state, '', [], t));
  Object.assign(state, creditMedia(state, '', [], t)); // expire recent interval metadata
  const tabs = await chrome.tabs.query({ audible: true });
  const next = {};
  for (const tab of tabs) {
    if (tab.discarded || !/^https?:\/\//.test(tab.url || '')) continue;
    const domain = normalizeDomain(tab.url);
    if (domain) next[tab.id] = { domain, since: t };
  }
  for (const session of Object.values(state.mediaAudible)) {
    Object.assign(state, creditMedia(state, session.domain, [[session.since, t]], t));
    Object.assign(state, creditCombined(state, session.domain, [[session.since, t]], t));
  }
  await setState({ mediaUsage: state.mediaUsage, mediaCoverage: state.mediaCoverage, mediaAudible: next, combinedUsage: state.combinedUsage, combinedCoverage: state.combinedCoverage });
}

async function receiveMedia(msg, sender) {
  if (!sender.tab || !Array.isArray(msg.intervals) || msg.intervals.length > 512 ||
      (sender.documentLifecycle && sender.documentLifecycle !== 'active')) return { ok: false };
  let tab;
  try { tab = await chrome.tabs.get(sender.tab.id); } catch { return { ok: false }; }
  if (!/^https?:\/\//.test(tab.url || '') || tab.discarded) return { ok: false };
  // Attribute embedded players to the website the user opened, not its CDN.
  const domain = normalizeDomain(tab.url);
  if (!domain || domain !== normalizeDomain(sender.tab.url)) return { ok: false };
  const state = await getState();
  if (!state.settings.trackUsage) return { ok: true };
  const t = now();
  await setState({ ...creditMedia(state, domain, msg.intervals, t), ...creditCombined(state, domain, msg.intervals, t) });
  return { ok: true };
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
    let cursor = state.session.since;
    while (cursor < t) {
      const midnight = new Date(cursor);
      midnight.setHours(24, 0, 0, 0);
      const end = Math.min(t, midnight.getTime());
      const day = dayKey(cursor);
      usage[day] = { ...(usage[day] || {}) };
      usage[day][state.session.domain] =
        (usage[day][state.session.domain] || 0) + (end - cursor) / 1000;
      cursor = end;
    }
  }
  await setState({ usage, ...creditCombined(state, state.session.domain, [[state.session.since, t]], t), session: { domain: state.session.domain, since: t } });
}

// Flush, then re-evaluate what we should be tracking.
async function updateSession() {
  const t = now();
  await flushUsage(t);
  const domain = await computeActiveDomain();
  await setState({ session: domain ? { domain, since: t } : null });
  // A limit can run out mid-session; re-check so the exhaustion alarm follows
  // whichever site is being used now.
  const { timeLimits } = await getState();
  if (Object.keys(timeLimits).length) await recomputeBlocking();
}

// ---------- rule computation ----------
// The set of domains that should be blocked right now, given focus + temp breaks:
//  • always-blocked sites: enforced always (minus active temp-breaks, which
//    are ignored while a focus session runs);
//  • focus-only sites: enforced only while a focus session is active;
//  • time-limited sites: enforced once today's usage reaches the limit (minus
//    temp-breaks), and always while a focus session runs.
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
  for (const dom of Object.keys(state.timeLimits || {})) {
    if (effective.includes(dom)) continue;
    if (focusActive) { effective.push(dom); continue; }
    const until = temp[dom];
    if (until && until > t) continue;
    if (isLimitReached(state, dom, t)) effective.push(dom);
  }
  return effective;
}

// The original URL rides along in the hash (not the query) so its own `?`/`&`
// can't collide with `site`; the block page returns the user there once the
// site is allowed again.
export function blockPageUrl(dom, url) {
  const base = chrome.runtime.getURL(`blocked/blocked.html?site=${encodeURIComponent(dom)}`);
  return url ? `${base}#${encodeURIComponent(url)}` : base;
}

// Which blocked entry (if any) covers this domain? An entry blocks exactly that
// host — "www." is the same host (normalizeDomain strips it), but any other
// subdomain is a separate site: blocking "youtube.com" leaves
// "music.youtube.com" alone. Block a subdomain by adding it as its own entry.
export function matchBlocked(dom, blockedSet) {
  if (!dom) return null;
  return blockedSet.includes(dom) ? dom : null;
}

async function recomputeBlocking() {
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
  await scheduleNextAlarm(temp, focus, limitTimes(state, effective, t));
}

// When a time limit can next change a site's block state: the moment the site
// in active use runs out, and midnight (when every limit resets). Background
// playback is caught by the minute-by-minute flush instead.
function limitTimes(state, effective, t) {
  const doms = Object.keys(state.timeLimits || {});
  if (!doms.length) return [];
  const times = [nextMidnight(t)];
  const dom = state.session?.domain;
  if (dom && !effective.includes(dom)) {
    const left = limitRemaining(state, dom, t);
    if (left !== null) times.push(t + left * 1000);
  }
  return times;
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
      try { await chrome.tabs.update(tab.id, { url: blockPageUrl(hit, tab.url) }); } catch { /* tab gone */ }
    }
  }
}

// Navigation-time guard: when a tab navigates to a blocked domain, give it a
// short grace period before showing the block page. Sites (sign-in flows, link
// shorteners, OAuth hops) often pass *through* a blocked domain on their way
// somewhere else; blocking at the first hop would break the whole chain. So we
// wait, then look at where the tab actually is, and block only if it stayed.
// (This is also why there are no declarativeNetRequest rules: those fire before
// the page loads and can't grant a grace period. Tab-level checks also catch
// PWAs that serve navigations from their own service worker cache.)
export const GRACE_MS = 3000;
const pendingGuards = new Set(); // tab ids with a grace timer running

async function guardTab(tabId, url) {
  if (!/^https?:\/\//.test(url || '')) return;
  // One timer per tab: further hops during the grace period don't extend it —
  // the check reads the tab's URL at the end, wherever it ended up.
  if (pendingGuards.has(tabId)) return;
  const state = await getState();
  if (!matchBlocked(normalizeDomain(url), computeEffectiveBlocked(state, now()))) return;
  if (pendingGuards.has(tabId)) return; // another nav scheduled one while we read
  pendingGuards.add(tabId);
  setTimeout(() => {
    pendingGuards.delete(tabId);
    blockIfStillThere(tabId);
  }, GRACE_MS);
}

async function blockIfStillThere(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; } // tab closed
  // pendingUrl: the tab is already mid-navigation to somewhere else — judge
  // the destination, not the page it's leaving.
  const url = tab.pendingUrl || tab.url;
  if (!/^https?:\/\//.test(url || '')) return;
  const state = await getState();
  const hit = matchBlocked(normalizeDomain(url), computeEffectiveBlocked(state, now()));
  if (hit) {
    try { await chrome.tabs.update(tabId, { url: blockPageUrl(hit, url) }); } catch { /* tab gone */ }
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

async function scheduleNextAlarm(temp, focus, extra = []) {
  await chrome.alarms.clear('recompute');
  const times = [...extra];
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
  enqueue(async () => {
    if (msg.type === 'mediaProgress') return sendResponse(await receiveMedia(msg, _sender));
    // Content scripts only report media. They cannot read history or mutate settings.
    if (_sender.tab && !_sender.url?.startsWith(chrome.runtime.getURL(''))) {
      return sendResponse({ ok: false, error: 'Extension page required' });
    }
    const state = await getState();
    switch (msg.type) {
      case 'getState': {
        sendResponse({ ok: true, state });
        break;
      }
      case 'blockSite': {
        const dom = normalizeDomain(msg.domain);
        if (!dom) return sendResponse({ ok: false, error: 'Invalid site' });
        const mode = ['focus', 'limit'].includes(msg.mode) ? msg.mode : 'always';
        const minutes = mode === 'limit' ? clampLimit(msg.minutes) : null;
        if (mode === 'limit' && !minutes) return sendResponse({ ok: false, error: 'Invalid time limit' });
        // Any change that makes a site more reachable — always→limit/focus,
        // limit→focus, or raising a limit — is a form of unblocking, so it's
        // password-gated exactly like unblockSite. Adding or tightening is free.
        const current = state.blockedSites.includes(dom) ? { mode: 'always' }
          : state.timeLimits[dom] ? { mode: 'limit', minutes: state.timeLimits[dom] }
          : state.focusSites.includes(dom) ? { mode: 'focus' } : null;
        if (isLoosening(current, { mode, minutes })) {
          const gate = await requirePassword(state, msg.password);
          if (!gate.ok) return sendResponse(gate);
        }
        // a site lives in exactly one list — moving modes removes it from the others
        const blocked = state.blockedSites.filter((d) => d !== dom);
        const focusList = state.focusSites.filter((d) => d !== dom);
        const timeLimits = { ...state.timeLimits };
        delete timeLimits[dom];
        if (mode === 'always') blocked.push(dom);
        else if (mode === 'focus') focusList.push(dom);
        else timeLimits[dom] = minutes;
        await setState({ blockedSites: blocked, focusSites: focusList, timeLimits });
        await recomputeBlocking();
        sendResponse({ ok: true, mode });
        break;
      }
      case 'unblockSite': {
        const dom = normalizeDomain(msg.domain);
        const gate = await requirePassword(state, msg.password);
        if (!gate.ok) return sendResponse(gate);
        const list = state.blockedSites.filter((d) => d !== dom);
        const focusList = state.focusSites.filter((d) => d !== dom);
        const timeLimits = { ...state.timeLimits };
        delete timeLimits[dom];
        const temp = { ...state.tempUnblocks };
        delete temp[dom];
        await setState({ blockedSites: list, focusSites: focusList, timeLimits, tempUnblocks: temp });
        await recomputeBlocking();
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
        await recomputeBlocking();
        sendResponse({ ok: true, endsAt: temp[dom] });
        break;
      }
      case 'reblockNow': {
        const dom = normalizeDomain(msg.domain);
        const temp = { ...state.tempUnblocks };
        delete temp[dom];
        await setState({ tempUnblocks: temp });
        await recomputeBlocking();
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
        await recomputeBlocking();
        sendResponse({ ok: true, list: cleaned });
        break;
      }
      case 'startFocus': {
        const dur = Math.max(1, msg.minutes || 25);
        const focus = { active: true, endsAt: now() + dur * 60_000, durationMin: dur };
        await setState({ focus });
        await recomputeBlocking();
        sendResponse({ ok: true, focus });
        break;
      }
      case 'stopFocus': {
        const gate = await requirePassword(state, msg.password);
        if (!gate.ok) return sendResponse(gate);
        await setState({ focus: { active: false, endsAt: null, durationMin: state.focus.durationMin } });
        await recomputeBlocking();
        sendResponse({ ok: true });
        break;
      }
      case 'setSetting': {
        // Time limits are measured by usage tracking — switching it off would
        // silently disable them, so it's gated like any other unblock.
        if (msg.key === 'trackUsage' && !msg.value && Object.keys(state.timeLimits).length) {
          const gate = await requirePassword(state, msg.password);
          if (!gate.ok) return sendResponse(gate);
        }
        if (msg.key === 'trackUsage') {
          await updateSession();
          await updateMediaAudible();
          await setState({ session: null, mediaAudible: {}, mediaCoverage: {}, combinedCoverage: {}, mediaCutoff: now() });
        }
        await setState({ settings: { ...state.settings, [msg.key]: msg.value } });
        await recomputeBlocking();
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
        await updateMediaAudible();
        await updateSession(); // count the in-progress session up to now
        const fresh = await getState();
        const stats = buildStats(fresh, now());
        if (msg.includeHistory) {
          stats.usage = fresh.usage;
          stats.mediaUsage = fresh.mediaUsage;
          stats.combinedUsage = fresh.combinedUsage;
          stats.legacyCombined = fresh.legacyCombined;
          stats.trackingOn = fresh.settings.trackUsage;
        }
        sendResponse({ ok: true, stats });
        break;
      }
      case 'clearStats': {
        const gate = await requirePassword(state, msg.password);
        if (!gate.ok) return sendResponse(gate);
        await setState({ usage: {}, combinedUsage: {}, legacyCombined: false, session: null, mediaUsage: {}, mediaCoverage: {}, mediaAudible: {}, mediaCutoff: now() });
        await recomputeBlocking(); // cleared usage also resets today's limits
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message' });
    }
  }).catch(() => sendResponse({ ok: false, error: 'Could not update FocusBlock data.' }));
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
function bootstrap(resetMedia = false) {
  return enqueue(async () => {
    const state = await getState();
    if (state.combinedUsage === null) {
      const legacyCombined = Object.entries(state.mediaUsage).some(([day, sites]) =>
        Object.keys(sites).some(domain => state.usage[day]?.[domain] > 0));
      await setState({ combinedUsage: mergeHistory(state.usage, state.mediaUsage), combinedSince: now(), legacyCombined });
    }
    if (resetMedia) await setState({ mediaAudible: {}, mediaCoverage: {}, combinedCoverage: {}, mediaCutoff: now() });
    await recomputeBlocking();
    try { chrome.idle.setDetectionInterval(IDLE_THRESHOLD); } catch { /* ignore */ }
    chrome.alarms.create('flush', { periodInMinutes: 1 });
    await updateSession();
    await updateMediaAudible();
  });
}

chrome.runtime.onInstalled.addListener(() => bootstrap(true));
chrome.runtime.onStartup.addListener(() => bootstrap(true));
chrome.alarms.onAlarm.addListener((alarm) => enqueue(async () => {
  if (alarm.name === 'recompute') await recomputeBlocking();
  if (alarm.name === 'flush') { await updateSession(); await updateMediaAudible(); }
}));

chrome.tabs.onActivated.addListener(() => enqueue(updateSession));
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url) guardTab(tabId, info.url);
  return enqueue(async () => {
    if (tab.active && (info.url || info.status === 'complete')) await updateSession();
    if ('audible' in info || info.url || 'discarded' in info) await updateMediaAudible();
  });
});
chrome.tabs.onRemoved.addListener(() => enqueue(updateMediaAudible));
chrome.windows.onFocusChanged.addListener(() => enqueue(updateSession));
chrome.idle.onStateChanged.addListener(() => enqueue(updateSession));

// Worker restarts preserve recent coverage and clocks; browser restarts reset them.
bootstrap();
