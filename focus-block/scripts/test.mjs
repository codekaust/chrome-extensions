// Logic tests for the FocusBlock service worker.
// Mocks the `chrome.*` APIs, loads background.js, dispatches real messages,
// and asserts on the resulting storage + tab redirects.

let alarmHandler = null;
let msgHandler = null;
let updatedHandler = null;
const store = {};
let badgeText = '';
const notifications = [];

// controllable "browser state" for usage-tracking tests
let mockWin = { id: 1, focused: true };
let mockTabs = { 1: [{ active: true, url: 'https://example.com/x' }] };
let mockAudibleTabs = [];
let removedHandler = null;
let mockIdle = 'active';
let mockAllTabs = [];        // returned for url-pattern queries (enforceOpenTabs)
let updatedTabs = [];        // { id, url } passed to chrome.tabs.update
let tabById = {};            // what chrome.tabs.get returns (where a tab is *now*)

// Grace-period timers are captured instead of waited on, so tests can fire
// them on demand ("3 seconds later…").
const realSetTimeout = globalThis.setTimeout;
let graceTimers = [];
globalThis.setTimeout = (fn, ms, ...rest) => {
  if (ms === 3000) { graceTimers.push(fn); return 0; }
  return realSetTimeout(fn, ms, ...rest);
};

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
    async query({ windowId, url, audible } = {}) {
      if (audible) return mockAudibleTabs;
      if (url) return mockAllTabs;            // url-pattern query → enforceOpenTabs
      return mockTabs[windowId] || [];
    },
    async update(id, props) { updatedTabs.push({ id, ...props }); },
    async get(id) {
      if (!tabById[id]) throw new Error('No tab');
      return tabById[id];
    },
    onRemoved: { addListener(fn) { removedHandler = fn; } },
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
    getURL: (p) => `chrome-extension://test/${p}`,
    onMessage: { addListener(fn) { msgHandler = fn; } },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
  },
};

const { matchBlocked, blockPageUrl, GRACE_MS } = await import('../src/background.js');

// dispatch a message and await sendResponse
function dispatch(msg, sender = {}) {
  return new Promise((resolve) => {
    msgHandler(msg, sender, resolve);
  });
}

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}
const blockedDomains = () => [...(store.effectiveBlocked || [])].sort();
// the original URL carried in a block-page redirect's hash
const carriedUrl = (u) => decodeURIComponent(u.split('#')[1] || '');

console.log('\nFocusBlock logic tests\n');

// --- block ---
console.log('block / unblock');
await dispatch({ type: 'blockSite', domain: 'https://www.youtube.com/watch?x=1' });
await dispatch({ type: 'blockSite', domain: 'reddit.com' });
assert(store.blockedSites.join(',') === 'youtube.com,reddit.com', 'normalizes + stores two domains');
assert(JSON.stringify(blockedDomains()) === '["reddit.com","youtube.com"]', 'both domains are enforced');

await dispatch({ type: 'unblockSite', domain: 'reddit.com' });
assert(store.blockedSites.join(',') === 'youtube.com', 'unblock removes from list');
assert(blockedDomains().join(',') === 'youtube.com', 'unblock stops enforcing it');

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

// Retention and daily attribution at midnight.
const originalNow = Date.now;
const midnight = new Date(2026, 9, 23, 0, 0, 5).getTime();
Date.now = () => midnight;
store.usage = { '2020-01-01': { 'archive.com': 300 } };
store.session = { domain: 'midnight.com', since: midnight - 10000 };
const history = (await dispatch({ type: 'getStats', includeHistory: true })).stats;
assert(history.usage['2020-01-01']['archive.com'] === 300, 'history older than 30 days survives tracking flush');
assert(history.usage['2026-10-22']['midnight.com'] === 5, 'pre-midnight time belongs to the previous day');
assert(history.usage['2026-10-23']['midnight.com'] === 5, 'post-midnight time belongs to today');
assert(history.days[5].sites[0].domain === 'midnight.com', 'popup carries previous-day site details');
Date.now = originalNow;
store.session = null;
assert(!(await dispatch({ type: 'getStats' })).stats.usage, 'popup does not transfer the full history');

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

// --- media playback across all sites, independent of active browsing ---
console.log('media playback');
const mediaNow = Date.now;
let mediaClock = new Date(2026, 9, 23, 12).getTime();
Date.now = () => mediaClock;
store.mediaCutoff = 0;
mockIdle = 'idle'; mockWin = { id: 1, focused: false };
for (const [index, host] of ['primevideo.com', 'youtube.com', 'music.youtube.com', 'arbitrary.example'].entries()) {
  const id = 200 + index;
  tabById[id] = { id, url: `https://${host}/watch` };
  const result = await dispatch({ type: 'mediaProgress', intervals: [[mediaClock-10000, mediaClock]] },
    { tab: tabById[id], frameId: 3, url: 'https://embedded.example/player' });
  assert(result.ok && store.mediaUsage['2026-10-23'][host] === 10, `${host} media counts while idle and browser unfocused`);
}
let mediaStats = (await dispatch({type: 'getStats', includeHistory: true})).stats;
assert(mediaStats.todayTotal === 0 && mediaStats.media.todayTotal === 40, 'playback is separate from browsing in stats');
assert(mediaStats.mediaUsage['2026-10-23']['primevideo.com'] === 10, 'history API includes playback records');
await Promise.all([1,2,3].map(() => dispatch({type: 'mediaProgress', intervals: [[mediaClock-10000,mediaClock]]}, {tab: tabById[200]})));
assert(store.mediaUsage['2026-10-23']['primevideo.com'] === 10, 'concurrent duplicate reports do not double count');
const badSender = await dispatch({type: 'mediaProgress', intervals: [[mediaClock-10000,mediaClock]]});
assert(!badSender.ok, 'media reports require a live browser tab');
const pageRead = await dispatch({type:'getState'}, {tab:tabById[200],url:'https://primevideo.com/watch'});
assert(!pageRead.ok, 'content-script senders cannot read private history or settings');
const pageWrite = await dispatch({type:'clearStats'}, {tab:tabById[200],url:'https://primevideo.com/watch'});
assert(!pageWrite.ok && store.mediaUsage['2026-10-23']['primevideo.com'] === 10, 'content-script senders cannot clear history');

const changedTab = await dispatch({type: 'mediaProgress', intervals: [[mediaClock-10000,mediaClock]]}, {tab: {id:200,url:'https://old.example'}});
assert(!changedTab.ok, 'old-page reports cannot be credited to a different navigated site');

// Browser audio fallback also works without a content-script player (Web Audio).
mockAudibleTabs = [{id:210, url:'https://audio.example', audible:true}];
await updatedHandler(210, {audible:true}, mockAudibleTabs[0]);
mediaClock += 10000;
await dispatch({type:'getStats'});
assert(store.mediaUsage['2026-10-23']['audio.example'] === 10, 'browser audio fallback counts background sound');
mockAudibleTabs = [];
await removedHandler(210);
mediaClock += 10000;
await dispatch({type:'getStats'});
assert(store.mediaUsage['2026-10-23']['audio.example'] === 10, 'closed or silent tabs stop fallback tracking');

await dispatch({type:'setSetting',key:'trackUsage',value:false});
mediaClock += 10000;
await dispatch({type:'mediaProgress',intervals:[[mediaClock-10000,mediaClock]]},{tab:tabById[200]});
assert(store.mediaUsage['2026-10-23']['primevideo.com'] === 10, 'disabling tracking stops playback collection');
await dispatch({type:'setSetting',key:'trackUsage',value:true});
await dispatch({type:'mediaProgress',intervals:[[mediaClock-10000,mediaClock]]},{tab:tabById[200]});
assert(store.mediaUsage['2026-10-23']['primevideo.com'] === 10, 're-enabling cannot backfill the disabled interval');
await dispatch({type:'clearStats'});
await dispatch({type:'mediaProgress',intervals:[[mediaClock-10000,mediaClock]]},{tab:tabById[200]});
assert(Object.keys(store.mediaUsage).length === 0, 'clear history removes media and rejects late pre-clear reports');
mediaClock += 5000;
await dispatch({type:'mediaProgress',intervals:[[mediaClock-5000,mediaClock]]},{tab:tabById[200]});
assert(store.mediaUsage['2026-10-23']['primevideo.com'] === 5, 'new playback is tracked after clearing history');
Date.now = mediaNow;
mockIdle = 'active'; mockWin = {id:1, focused:true};
store.session = null;

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
  { id: 13, url: 'https://mobile.x.com/home' }, // other subdomain — a separate site
  { id: 14, url: 'https://www.x.com/i/bookmarks?tab=2' }, // www. is the same site
];
await dispatch({ type: 'blockSite', domain: 'x.com', mode: 'focus' });
updatedTabs = [];
await dispatch({ type: 'startFocus', minutes: 25 });
const redirectedIds = updatedTabs.map((u) => u.id);
assert(redirectedIds.includes(11), 'open tab on a newly-blocked site is redirected at focus start');
assert(updatedTabs.find((u) => u.id === 11)?.url.includes('site=x.com'),
  'redirect points at the block page for that site');
assert(carriedUrl(updatedTabs.find((u) => u.id === 11).url) === 'https://x.com/home',
  'redirect carries the original URL for the block page to return to');
assert(!redirectedIds.includes(12), 'tab on an allowed site is left alone');
assert(!redirectedIds.includes(13), 'other subdomains of a blocked site are left alone');
assert(redirectedIds.includes(14), 'www. of a blocked site is redirected');
assert(carriedUrl(updatedTabs.find((u) => u.id === 14).url) === 'https://www.x.com/i/bookmarks?tab=2',
  'full path + query survive the round trip');
// A later recompute that does NOT change the blocked set must not touch tabs
// again — this is the whole "stop reloading for no reason" fix.
updatedTabs = [];
await dispatch({ type: 'setSetting', key: 'notifyCycle', value: false });
assert(updatedTabs.length === 0, 'a recompute with no block-set change reloads nothing');
await dispatch({ type: 'stopFocus' });
mockAllTabs = [];

// navigation guard: blocked only if the tab is *still there* after the grace
console.log('navigation guard (grace period)');
const flush = () => new Promise((r) => realSetTimeout(r, 0)); // let async guardTab settle
const fireGrace = async () => {
  const fns = graceTimers; graceTimers = [];
  fns.forEach((fn) => fn());
  await flush(); await flush();
};
assert(GRACE_MS === 3000, 'grace period is 3 seconds');
await dispatch({ type: 'blockSite', domain: 'x.com', mode: 'always' });

updatedTabs = []; graceTimers = [];
tabById[99] = { id: 99, url: 'https://x.com/anything?q=1' };
updatedHandler(99, { url: 'https://x.com/anything?q=1' }, { active: true });
await flush();
assert(updatedTabs.length === 0, 'blocked site is NOT redirected immediately');
assert(graceTimers.length === 1, 'a grace timer is started');
await fireGrace();
const r99 = updatedTabs.find((u) => u.id === 99);
assert(r99 && r99.url.includes('site=x.com'), 'still on the blocked site after the grace → block page');
assert(carriedUrl(r99.url) === 'https://x.com/anything?q=1', 'block page gets the exact URL (path + query)');

// redirect chain: passes through x.com, ends up elsewhere within the grace
updatedTabs = [];
tabById[96] = { id: 96, url: 'https://x.com/oauth/redirect' };
updatedHandler(96, { url: 'https://x.com/oauth/redirect' }, { active: true });
await flush();
tabById[96] = { id: 96, url: 'https://news.ycombinator.com/' };   // hopped onward
updatedHandler(96, { url: 'https://news.ycombinator.com/' }, { active: true });
await flush();
assert(graceTimers.length === 1, 'further hops do not start a second timer');
await fireGrace();
assert(updatedTabs.length === 0, 'a tab that only passed through a blocked site is left alone');

// mid-navigation away: judge pendingUrl, not the page being left
tabById[95] = { id: 95, url: 'https://x.com/', pendingUrl: 'https://example.com/' };
updatedHandler(95, { url: 'https://x.com/' }, { active: true });
await flush();
await fireGrace();
assert(updatedTabs.length === 0, 'a tab already navigating away is left alone');

// a break started during the grace period wins
updatedHandler(99, { url: 'https://x.com/again' }, { active: true });
await flush();
await dispatch({ type: 'tempUnblock', domain: 'x.com', minutes: 5 });
await fireGrace();
assert(updatedTabs.length === 0, 'block state is re-checked when the grace ends');
await dispatch({ type: 'reblockNow', domain: 'x.com' });
updatedTabs = [];

// closed during the grace → no error, nothing to do
updatedHandler(94, { url: 'https://x.com/' }, { active: true });
await flush();
await fireGrace();
assert(updatedTabs.length === 0, 'a tab closed during the grace is ignored');

// non-blocked + extension URLs never even start a timer (no loop, no waste)
updatedHandler(98, { url: 'chrome-extension://abc/blocked/blocked.html?site=x.com' }, { active: true });
updatedHandler(97, { url: 'https://news.ycombinator.com/' }, { active: true });
updatedHandler(93, { url: 'https://mobile.x.com/' }, { active: true });
await flush();
assert(graceTimers.length === 0, 'allowed sites, subdomains, and the block page start no timer');
await dispatch({ type: 'unblockSite', domain: 'x.com' });

// --- exact-host matching (not subdomains) ---
console.log('exact-host matching');
assert(matchBlocked('youtube.com', ['youtube.com']) === 'youtube.com', 'the entry itself matches');
assert(matchBlocked('music.youtube.com', ['youtube.com']) === null, 'a subdomain is a separate site');
assert(matchBlocked('youtube.com', ['music.youtube.com']) === null, 'blocking a subdomain leaves the parent alone');
assert(matchBlocked('notyoutube.com', ['youtube.com']) === null, 'suffix lookalikes do not match');
assert(blockPageUrl('a.com', 'https://a.com/x?y=1&z=2#h').endsWith('#' + encodeURIComponent('https://a.com/x?y=1&z=2#h')),
  'block page URL encodes the original URL into the hash');

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
