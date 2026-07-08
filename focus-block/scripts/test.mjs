// Logic tests for the FocusBlock service worker.
// Mocks the `chrome.*` APIs, loads background.js, dispatches real messages,
// and asserts on the resulting storage + declarativeNetRequest rules.

let alarmHandler = null;
let msgHandler = null;
const store = {};
let dynamicRules = [];
let badgeText = '';
const notifications = [];

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
const changeNoOld = await dispatch({ type: 'setPassword', password: 'new' });
assert(changeNoOld.ok === false, 'changing password requires the old one');
await dispatch({ type: 'setPassword', password: '', oldPassword: 'hunter2' });
assert(store.password === null, 'password removed with correct old password');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
