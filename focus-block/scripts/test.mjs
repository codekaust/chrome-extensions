// Logic tests for the FocusBlock service worker.
// Mocks the `chrome.*` APIs, loads background.js, dispatches real messages,
// and asserts on the resulting storage + declarativeNetRequest rules.

let alarmHandler = null;
let msgHandler = null;
let updatedHandler = null;
const store = {};
let dynamicRules = [];
let badgeText = '';
const notifications = [];

// controllable "browser state" for usage-tracking tests
let mockWin = { id: 1, focused: true };
let mockTabs = { 1: [{ active: true, url: 'https://example.com/x' }] };
let mockIdle = 'active';
let mockAllTabs = [];        // returned for url-pattern queries (enforceOpenTabs)
let updatedTabs = [];        // { id, url } passed to chrome.tabs.update

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const out = {};
        for (const k of keys) if (k in store) out[k] = store[k];
        return out;
      },
      async set(patch) { Object.assign(store, patch); },
    },
  },
  declarativeNetRequest: {
    async getDynamicRules() { return dynamicRules; },
    async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
      dynamicRules = dynamicRules.filter((r) => !removeRuleIds.includes(r.id));
      dynamicRules.push(...addRules);
    },
  },
  action: {
    async setBadgeText({ text }) { badgeText = text; },
    async setBadgeBackgroundColor() {},
  },
  alarms: {
    async clear() {},
    create() {},
    onAlarm: { addListener(fn) { alarmHandler = fn; } },
  },
  notifications: { create(_id, opts) { notifications.push(opts ?? _id); } },
  tabs: {
    async query({ windowId, url } = {}) {
      if (url) return mockAllTabs;            // url-pattern query → enforceOpenTabs
      return mockTabs[windowId] || [];
    },
    async update(id, props) { updatedTabs.push({ id, ...props }); },
    onActivated: { addListener() {} },
    onUpdated: { addListener(fn) { updatedHandler = fn; } },
  },
  windows: {
    async getLastFocused() { return mockWin; },
    onFocusChanged: { addListener() {} },
  },
  idle: {
    setDetectionInterval() {},
    async queryState() { return mockIdle; },
    onStateChanged: { addListener() {} },
  },
  runtime: {
    getURL: (p) => p,
    onMessage: { addListener(fn) { msgHandler = fn; } },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
  },
};

await import('../src/background.js');

// dispatch a message and await sendResponse
function dispatch(msg) {
  return new Promise((resolve) => {
    msgHandler(msg, {}, resolve);
  });
}

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}
const blockedDomains = () =>
  dynamicRules.map((r) => r.condition.requestDomains[0]).sort();

console.log('\nFocusBlock logic tests\n');

// --- block ---
console.log('block / unblock');
await dispatch({ type: 'blockSite', domain: 'https://www.youtube.com/watch?x=1' });
await dispatch({ type: 'blockSite', domain: 'reddit.com' });
assert(store.blockedSites.join(',') === 'youtube.com,reddit.com', 'normalizes + stores two domains');
assert(JSON.stringify(blockedDomains()) === '["reddit.com","youtube.com"]', 'creates a rule per blocked domain');

await dispatch({ type: 'unblockSite', domain: 'reddit.com' });
assert(store.blockedSites.join(',') === 'youtube.com', 'unblock removes from list');
assert(blockedDomains().join(',') === 'youtube.com', 'unblock removes the rule');

// --- temp unblock ---
console.log('timed break');
const r = await dispatch({ type: 'tempUnblock', domain: 'youtube.com', minutes: 5 });
assert(r.ok && r.endsAt > Date.now(), 'temp unblock returns endsAt in the future');
assert(blockedDomains().length === 0, 'blocked domain is not enforced during a break');
// simulate expiry, then trigger an awaited recompute (same path the alarm uses)
store.tempUnblocks = { 'youtube.com': Date.now() - 1000 };
assert(typeof alarmHandler === 'function', 'alarm listener is registered');
await dispatch({ type: 'setSetting', key: 'activityIndicator', value: true });
assert(blockedDomains().join(',') === 'youtube.com', 'break expiry re-blocks the site');
assert(store.tempUnblocks['youtube.com'] === undefined, 'expired break is pruned from storage');

// --- block now (end a break early) ---
console.log('block now');
await dispatch({ type: 'tempUnblock', domain: 'youtube.com', minutes: 15 });
assert(blockedDomains().length === 0, 'break active, site allowed');
await dispatch({ type: 'reblockNow', domain: 'youtube.com' });
assert(blockedDomains().join(',') === 'youtube.com', 'Block now re-blocks immediately');
assert(store.tempUnblocks['youtube.com'] === undefined, 'Block now clears the break');
assert(store.blockedSites.includes('youtube.com'), 'Block now keeps the site on the list');

// --- focus mode overrides breaks ---
console.log('focus mode');
await dispatch({ type: 'tempUnblock', domain: 'youtube.com', minutes: 30 });
assert(blockedDomains().length === 0, 'break active before focus');
await dispatch({ type: 'startFocus', minutes: 25 });
assert(store.focus.active === true, 'focus session starts');
assert(blockedDomains().join(',') === 'youtube.com', 'focus mode ignores active breaks');
const denied = await dispatch({ type: 'tempUnblock', domain: 'youtube.com', minutes: 5 });
assert(denied.ok === false, 'cannot start a break during focus mode');
await dispatch({ type: 'stopFocus' });
assert(store.focus.active === false, 'focus session can be stopped');

// --- usage tracking ---
console.log('usage tracking');
mockWin = { id: 1, focused: true };
mockTabs = { 1: [{ active: true, url: 'https://example.com/watch' }] };
mockIdle = 'active';
await dispatch({ type: 'getStats' });                 // starts a session
assert(store.session?.domain === 'example.com', 'active session tracks focused tab domain');
// simulate ~6s of viewing, then flush via another getStats
store.session.since = Date.now() - 6000;
let s = (await dispatch({ type: 'getStats' })).stats;
const exToday = s.today.find((x) => x.domain === 'example.com');
assert(exToday && exToday.seconds >= 5, 'active time is credited to the domain');
assert(s.days.length === 7, 'stats return a 7-day series');
assert(s.todayTotal >= 5, 'today total reflects tracked time');

// idle → no tracking
mockIdle = 'idle';
await dispatch({ type: 'getStats' });
assert(store.session === null, 'no session while the user is idle');

// unfocused window → no tracking
mockIdle = 'active';
mockWin = { id: 1, focused: false };
await dispatch({ type: 'getStats' });
assert(store.session === null, 'no session while the browser is unfocused');

// tracking disabled via setting
mockWin = { id: 1, focused: true };
await dispatch({ type: 'setSetting', key: 'trackUsage', value: false });
await dispatch({ type: 'getStats' });
assert(store.session === null, 'no session when tracking is disabled');
await dispatch({ type: 'setSetting', key: 'trackUsage', value: true });

// clear history
await dispatch({ type: 'clearStats' });
s = (await dispatch({ type: 'getStats' })).stats;
assert(s.todayTotal === 0 || s.today.length === 0, 'clearStats wipes usage history');

// --- two block modes ---
console.log('block modes (always vs during-focus)');
await dispatch({ type: 'blockSite', domain: 'twitter.com', mode: 'focus' });
assert(store.focusSites.includes('twitter.com'), 'focus-only site stored in focusSites');
assert(!store.blockedSites.includes('twitter.com'), 'focus-only site not in the always list');
assert(!blockedDomains().includes('twitter.com'), 'focus-only site is NOT blocked outside focus');
await dispatch({ type: 'startFocus', minutes: 25 });
assert(blockedDomains().includes('twitter.com'), 'focus-only site IS blocked during focus');
await dispatch({ type: 'stopFocus' });
assert(!blockedDomains().includes('twitter.com'), 'focus-only site frees up when focus ends');
await dispatch({ type: 'blockSite', domain: 'twitter.com', mode: 'always' });
assert(store.blockedSites.includes('twitter.com') && !store.focusSites.includes('twitter.com'),
  'switching mode moves the site between lists (no duplicate)');
assert(blockedDomains().includes('twitter.com'), 'after switching, site is blocked always');
await dispatch({ type: 'unblockSite', domain: 'twitter.com' });
assert(!store.blockedSites.includes('twitter.com') && !store.focusSites.includes('twitter.com'),
  'unblock removes the site from both lists');

// --- already-open tabs get redirected when a rule starts blocking them ---
console.log('enforce open tabs');
mockAllTabs = [
  { id: 11, url: 'https://x.com/home' },        // will be blocked during focus
  { id: 12, url: 'https://news.ycombinator.com/' }, // never blocked
  { id: 13, url: 'https://mobile.x.com/home' }, // subdomain of a blocked site
];
await dispatch({ type: 'blockSite', domain: 'x.com', mode: 'focus' });
updatedTabs = [];
await dispatch({ type: 'startFocus', minutes: 25 });
const redirectedIds = updatedTabs.map((u) => u.id);
assert(redirectedIds.includes(11), 'open tab on a newly-blocked site is redirected at focus start');
assert(updatedTabs.find((u) => u.id === 11)?.url.includes('site=x.com'),
  'redirect points at the block page for that site');
assert(!redirectedIds.includes(12), 'tab on an allowed site is left alone');
assert(redirectedIds.includes(13), 'subdomain of a blocked site is also redirected');
// A later recompute that does NOT change the blocked set must not touch tabs
// again — this is the whole "stop reloading for no reason" fix.
updatedTabs = [];
await dispatch({ type: 'setSetting', key: 'notifyCycle', value: false });
assert(updatedTabs.length === 0, 'a recompute with no block-set change reloads nothing');
await dispatch({ type: 'stopFocus' });
mockAllTabs = [];

// navigation-time guard redirects a fresh navigation to a blocked site
console.log('navigation guard');
const flush = () => new Promise((r) => setTimeout(r, 0)); // let async guardTab settle
await dispatch({ type: 'blockSite', domain: 'x.com', mode: 'always' });
updatedTabs = [];
updatedHandler(99, { url: 'https://x.com/anything' }, { active: true });
await flush();
assert(updatedTabs.some((u) => u.id === 99 && u.url.includes('site=x.com')),
  'navigating to a blocked site is redirected to the block page');
updatedTabs = [];
// block page / extension URLs must never be re-redirected (no loop)
updatedHandler(98, { url: 'chrome-extension://abc/blocked/blocked.html?site=x.com' }, { active: true });
updatedHandler(97, { url: 'https://news.ycombinator.com/' }, { active: true });
await flush();
assert(updatedTabs.length === 0, 'allowed sites and the block page are not redirected');
await dispatch({ type: 'unblockSite', domain: 'x.com' });

// --- password gating ---
console.log('password protection');
await dispatch({ type: 'setPassword', password: 'hunter2' });
assert(!!store.password?.hash, 'password hash stored');
const noPwd = await dispatch({ type: 'unblockSite', domain: 'youtube.com' });
assert(noPwd.ok === false && noPwd.needsPassword, 'unblock blocked without password');
const wrong = await dispatch({ type: 'unblockSite', domain: 'youtube.com', password: 'nope' });
assert(wrong.ok === false, 'wrong password rejected');
const right = await dispatch({ type: 'unblockSite', domain: 'youtube.com', password: 'hunter2' });
assert(right.ok === true, 'correct password unblocks');
assert(store.blockedSites.length === 0, 'site removed after password unblock');
// switching always→focus is a form of unblocking, so it's password-gated too
await dispatch({ type: 'blockSite', domain: 'imgur.com', mode: 'always' });
const swNoPwd = await dispatch({ type: 'blockSite', domain: 'imgur.com', mode: 'focus' });
assert(swNoPwd.ok === false && swNoPwd.needsPassword, 'always→focus blocked without password');
assert(store.blockedSites.includes('imgur.com'), 'site stays always-blocked when switch is denied');
const swPwd = await dispatch({ type: 'blockSite', domain: 'imgur.com', mode: 'focus', password: 'hunter2' });
assert(swPwd.ok === true, 'always→focus allowed with correct password');
assert(store.focusSites.includes('imgur.com') && !store.blockedSites.includes('imgur.com'),
  'site moved to focus list after gated switch');
// adding a brand-new focus-only site needs no password (not a loosening)
const addFocus = await dispatch({ type: 'blockSite', domain: 'tiktok.com', mode: 'focus' });
assert(addFocus.ok === true, 'adding a new focus-only site needs no password');

const changeNoOld = await dispatch({ type: 'setPassword', password: 'new' });
assert(changeNoOld.ok === false, 'changing password requires the old one');
await dispatch({ type: 'setPassword', password: '', oldPassword: 'hunter2' });
assert(store.password === null, 'password removed with correct old password');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
