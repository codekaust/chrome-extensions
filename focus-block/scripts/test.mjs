// Logic tests for the FocusBlock service worker.
// Mocks the `chrome.*` APIs, loads background.js, dispatches real messages,
// and asserts on the resulting storage + tab redirects.

let alarmHandler = null;
let msgHandler = null;
let updatedHandler = null;
let installedHandler = null;
const store = { usage: {'2020-01-01': {'legacy.example': 60}}, mediaUsage: {'2020-01-01': {'legacy.example': 90}} };
let badgeText = '';
const notifications = [];
const alarmsCreated = {};    // name → { when, periodInMinutes }

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
    async clear(name) { delete alarmsCreated[name]; },
    create(name, info) { alarmsCreated[name] = info; },
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
    onInstalled: { addListener(fn) { installedHandler = fn; } },
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
assert(store.combinedUsage['2020-01-01']['legacy.example'] === 150, 'upgrade preserves both historical totals');
assert(store.legacyCombined === true, 'legacy overlap limitation is recorded');
await installedHandler();
assert(store.combinedUsage['2020-01-01']['legacy.example'] === 150, 'repeated bootstrap does not add historical totals again');

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

// Combined browsing + playback shares one interval ledger.
console.log('merged usage');
Date.now = () => mediaClock;
await dispatch({type:'clearStats'});
store.combinedSince = 0;
mockIdle = 'active'; mockWin = {id:1,focused:true};
mockTabs = {1:[{active:true,url:'https://primevideo.com/watch'}]};
store.session = {domain:'primevideo.com',since:mediaClock};
mediaClock += 10000;
await dispatch({type:'mediaProgress',intervals:[[mediaClock-10000,mediaClock]]},{tab:tabById[200]});
const merged = (await dispatch({type:'getStats',includeHistory:true})).stats;
assert(merged.combined.todayTotal === 10, 'focused playback counts once in combined stats');
assert(merged.combinedUsage['2026-10-23']['primevideo.com'] === 10, 'full history uses the same merged total');
await dispatch({type:'clearStats'});
assert(Object.keys(store.combinedUsage).length === 0, 'clear history wipes combined data');
await dispatch({type:'mediaProgress',intervals:[[mediaClock-10000,mediaClock]]},{tab:tabById[200]});
assert(Object.keys(store.combinedUsage).length === 0, 'late reports cannot revive cleared combined data');
Date.now = mediaNow;
store.session = null;
mockTabs = {1:[{active:true,url:'https://example.com/watch'}]};

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

// --- daily time limits ---
console.log('daily time limits');
{
  const realNow = Date.now;
  let clock = new Date(2026, 9, 23, 12).getTime();
  Date.now = () => clock;
  const day = '2026-10-23';
  store.combinedUsage = { [day]: { 'reddit.com': 600 } };
  store.session = null;
  mockWin = { id: 1, focused: false }; // keep the live session out of the way

  const bad = await dispatch({ type: 'blockSite', domain: 'reddit.com', mode: 'limit', minutes: 0 });
  assert(bad.ok === false && !store.timeLimits?.['reddit.com'], 'an invalid limit is rejected');
  await dispatch({ type: 'blockSite', domain: 'reddit.com', mode: 'limit', minutes: 30 });
  assert(store.timeLimits['reddit.com'] === 30, 'limit stored in minutes');
  assert(!store.blockedSites.includes('reddit.com') && !store.focusSites.includes('reddit.com'),
    'a limited site lives only in the limit list');
  assert(!blockedDomains().includes('reddit.com'), 'site is allowed while under its limit');
  assert(alarmsCreated.recompute?.when === new Date(2026, 9, 24).getTime() + 500,
    'a recompute is scheduled for midnight, when limits reset');

  // the active session's projected run-out time drives the next recompute
  mockWin = { id: 1, focused: true };
  mockTabs = { 1: [{ active: true, url: 'https://reddit.com/r/all' }] };
  await alarmHandler({ name: 'flush' });
  assert(alarmsCreated.recompute?.when === clock + 1200_000 + 500,
    'the alarm is set for the moment the in-use site runs out');

  // the in-progress session is counted, and open tabs are sent to the block page
  mockAllTabs = [{ id: 31, url: 'https://reddit.com/r/all' }, { id: 32, url: 'https://old.reddit.com/' }];
  updatedTabs = [];
  store.combinedUsage = { [day]: { 'reddit.com': 1790 } };
  clock += 15_000;
  await alarmHandler({ name: 'recompute' });
  assert(blockedDomains().includes('reddit.com'), 'site is blocked once its limit is used up');
  assert(updatedTabs.map((u) => u.id).join() === '31', 'open tabs on the site (not other subdomains) are redirected');
  mockAllTabs = [];
  mockWin = { id: 1, focused: false };
  store.session = null;
  store.combinedUsage = { [day]: { 'reddit.com': 1805 } }; // the session's time, flushed

  // navigating there afterwards is caught by the grace-period guard
  graceTimers = []; updatedTabs = [];
  tabById[41] = { id: 41, url: 'https://reddit.com/' };
  updatedHandler(41, { url: 'https://reddit.com/' }, { active: false });
  await new Promise((r) => realSetTimeout(r, 0));
  graceTimers.splice(0).forEach((fn) => fn());
  await new Promise((r) => realSetTimeout(r, 0)); await new Promise((r) => realSetTimeout(r, 0));
  assert(updatedTabs.some((u) => u.id === 41 && u.url.includes('site=reddit.com')), 'new visits are blocked after the grace');

  // a timed break works on a spent limit
  await dispatch({ type: 'tempUnblock', domain: 'reddit.com', minutes: 5 });
  assert(!blockedDomains().includes('reddit.com'), 'a break lifts a spent limit');
  await dispatch({ type: 'reblockNow', domain: 'reddit.com' });
  assert(blockedDomains().includes('reddit.com'), 'Block now ends the break');

  // raising a limit unblocks; lowering re-blocks
  await dispatch({ type: 'blockSite', domain: 'reddit.com', mode: 'limit', minutes: 60 });
  assert(!blockedDomains().includes('reddit.com'), 'raising the limit frees the site');
  await dispatch({ type: 'blockSite', domain: 'reddit.com', mode: 'limit', minutes: 15 });
  assert(blockedDomains().includes('reddit.com'), 'lowering the limit below usage blocks it');

  // midnight resets every limit
  clock = new Date(2026, 9, 24, 0, 0, 1).getTime();
  await alarmHandler({ name: 'recompute' });
  assert(!blockedDomains().includes('reddit.com'), 'limits reset at midnight');

  // focus sessions block limited sites even with time left
  await dispatch({ type: 'startFocus', minutes: 25 });
  assert(blockedDomains().includes('reddit.com'), 'limited sites are blocked during focus');
  const noBreak = await dispatch({ type: 'tempUnblock', domain: 'reddit.com', minutes: 5 });
  assert(noBreak.ok === false, 'no breaks on limited sites during focus');
  await dispatch({ type: 'stopFocus' });
  assert(!blockedDomains().includes('reddit.com'), 'focus ending frees a limited site with time left');

  // clearing history resets today's usage
  store.combinedUsage = { '2026-10-24': { 'reddit.com': 5000 } };
  await alarmHandler({ name: 'recompute' });
  assert(blockedDomains().includes('reddit.com'), 'blocked again after heavy use');
  await dispatch({ type: 'clearStats' });
  assert(!blockedDomains().includes('reddit.com'), 'clearing usage history re-evaluates limits');

  // switching modes keeps a site in exactly one list
  await dispatch({ type: 'blockSite', domain: 'reddit.com', mode: 'always' });
  assert(store.blockedSites.includes('reddit.com') && !store.timeLimits['reddit.com'], 'limit → always moves the site');
  await dispatch({ type: 'blockSite', domain: 'reddit.com', mode: 'limit', minutes: 20 });
  assert(!store.blockedSites.includes('reddit.com') && store.timeLimits['reddit.com'] === 20, 'always → limit moves it back');
  await dispatch({ type: 'unblockSite', domain: 'reddit.com' });
  assert(!('reddit.com' in store.timeLimits), 'unblock removes the limit');

  Date.now = realNow;
  mockWin = { id: 1, focused: true };
  mockTabs = { 1: [{ active: true, url: 'https://example.com/watch' }] };
  store.session = null;
  updatedTabs = [];
}

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
// time limits: setting or lowering is free, raising or loosening to one is gated
const addLimit = await dispatch({ type: 'blockSite', domain: 'twitch.tv', mode: 'limit', minutes: 30 });
assert(addLimit.ok === true, 'adding a time limit needs no password');
const lower = await dispatch({ type: 'blockSite', domain: 'twitch.tv', mode: 'limit', minutes: 15 });
assert(lower.ok === true && store.timeLimits['twitch.tv'] === 15, 'lowering a limit needs no password');
const raise = await dispatch({ type: 'blockSite', domain: 'twitch.tv', mode: 'limit', minutes: 120 });
assert(raise.ok === false && raise.needsPassword && store.timeLimits['twitch.tv'] === 15, 'raising a limit needs the password');
const toFocus = await dispatch({ type: 'blockSite', domain: 'twitch.tv', mode: 'focus' });
assert(toFocus.ok === false && store.timeLimits['twitch.tv'] === 15, 'limit → focus-only needs the password');
await dispatch({ type: 'blockSite', domain: 'vimeo.com', mode: 'always' });
const alwaysToLimit = await dispatch({ type: 'blockSite', domain: 'vimeo.com', mode: 'limit', minutes: 30 });
assert(alwaysToLimit.ok === false && store.blockedSites.includes('vimeo.com'), 'always → limit needs the password');
const trackOff = await dispatch({ type: 'setSetting', key: 'trackUsage', value: false });
assert(trackOff.ok === false && store.settings.trackUsage === true, 'turning off tracking with limits set needs the password');
const trackOffPwd = await dispatch({ type: 'setSetting', key: 'trackUsage', value: false, password: 'hunter2' });
assert(trackOffPwd.ok === true && store.settings.trackUsage === false, 'the password allows turning tracking off');
await dispatch({ type: 'setSetting', key: 'trackUsage', value: true });

const changeNoOld = await dispatch({ type: 'setPassword', password: 'new' });
assert(changeNoOld.ok === false, 'changing password requires the old one');
await dispatch({ type: 'setPassword', password: '', oldPassword: 'hunter2' });
assert(store.password === null, 'password removed with correct old password');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
