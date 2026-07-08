// FocusBlock service worker — owns all state, blocking rules, timers & notifications.

const DEFAULTS = {
  blockedSites: [],          // array of hostname strings, e.g. "youtube.com"
  tempUnblocks: {},          // { hostname: endsAtEpochMs }
  focus: { active: false, endsAt: null, durationMin: 25 },
  settings: {
    activityIndicator: true,
    cleanBlockPage: false,
    notifyCycle: true,
    soundCycle: false,
    startPaused: false,
  },
  password: null,            // { hash } sha-256 hex, or null
};

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

// ---------- rule computation ----------
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

  // effective blocked = blocklist minus active temp-unblocks (temp ignored during focus)
  const effective = state.blockedSites.filter((dom) => {
    if (focusActive) return true;
    const until = temp[dom];
    return !(until && until > t);
  });

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

  await updateBadge(state.settings, focusActive, effective.length);
  await scheduleNextAlarm(temp, focus);
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
        if (!state.blockedSites.includes(dom)) {
          await setState({ blockedSites: [...state.blockedSites, dom] });
        }
        await recomputeRules();
        sendResponse({ ok: true });
        break;
      }
      case 'unblockSite': {
        const dom = normalizeDomain(msg.domain);
        const gate = await requirePassword(state, msg.password);
        if (!gate.ok) return sendResponse(gate);
        const list = state.blockedSites.filter((d) => d !== dom);
        const temp = { ...state.tempUnblocks };
        delete temp[dom];
        await setState({ blockedSites: list, tempUnblocks: temp });
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
chrome.runtime.onInstalled.addListener(() => recomputeRules());
chrome.runtime.onStartup.addListener(() => recomputeRules());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'recompute') recomputeRules();
});

// keep rules fresh when popup/options mutate storage directly (defensive)
recomputeRules();
