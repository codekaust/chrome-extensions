// Tests for TabLoop. Run: node scripts/test.mjs
// Part 1: pure schedule.js helpers (no mocking needed).
// Part 2: the service worker's message/alarm handling, with chrome.* mocked.
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;

const {
  MIN_SECONDS,
  MAX_SECONDS,
  clampSeconds,
  alarmName,
  parseAlarmName,
  formatInterval,
  formatCountdown,
} = await import(join(here, "..", "src", "schedule.js"));

// --- clampSeconds ---
{
  assert.strictEqual(clampSeconds(0), MIN_SECONDS);
  assert.strictEqual(clampSeconds(-5), MIN_SECONDS);
  assert.strictEqual(clampSeconds(MIN_SECONDS - 1), MIN_SECONDS);
  assert.strictEqual(clampSeconds(MAX_SECONDS + 1000), MAX_SECONDS);
  assert.strictEqual(clampSeconds(45.4), 45);
  assert.strictEqual(clampSeconds("30"), 30);
  assert.strictEqual(clampSeconds(NaN), MIN_SECONDS);
  pass++;
}

// --- alarmName / parseAlarmName round-trip ---
{
  assert.strictEqual(parseAlarmName(alarmName(42)), 42);
  assert.strictEqual(parseAlarmName("someOtherExtension:42"), null);
  assert.strictEqual(parseAlarmName("tabloop:notanumber"), null);
  pass++;
}

// --- formatInterval ---
{
  assert.strictEqual(formatInterval(10), "10s");
  assert.strictEqual(formatInterval(60), "1m");
  assert.strictEqual(formatInterval(90), "1m 30s");
  assert.strictEqual(formatInterval(3600), "1h");
  assert.strictEqual(formatInterval(5400), "1h 30m");
  pass++;
}

// --- formatCountdown ---
{
  assert.strictEqual(formatCountdown(4500), "5s");
  assert.strictEqual(formatCountdown(65000), "1m 05s");
  assert.strictEqual(formatCountdown(-100), "0s");
  pass++;
}

// --- background.js service worker, chrome.* mocked ---
{
  let alarmHandler = null;
  let msgHandler = null;
  let removedHandler = null;
  let startupHandler = null;
  const store = {};
  const alarms = new Map();
  const badges = {};
  const reloaded = [];
  let liveTabs = new Set([1, 2]);

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
    alarms: {
      async create(name, opts) { alarms.set(name, opts); },
      async clear(name) { alarms.delete(name); },
      onAlarm: { addListener(fn) { alarmHandler = fn; } },
    },
    action: {
      async setBadgeText({ tabId, text }) { badges[tabId] = text; },
      async setBadgeBackgroundColor() {},
    },
    tabs: {
      async get(tabId) {
        if (!liveTabs.has(tabId)) throw new Error("No tab with id: " + tabId);
        return { id: tabId };
      },
      reload(tabId) { reloaded.push(tabId); },
      onRemoved: { addListener(fn) { removedHandler = fn; } },
    },
    runtime: {
      onMessage: { addListener(fn) { msgHandler = fn; } },
      onStartup: { addListener(fn) { startupHandler = fn; } },
    },
  };

  await import(join(here, "..", "src", "background.js"));

  function dispatch(msg) {
    return new Promise((resolve) => {
      const kept = msgHandler(msg, {}, resolve);
      if (!kept) resolve(undefined);
    });
  }

  // start creates an alarm, persists state, and sets a badge
  {
    const res = await dispatch({ type: "start", tabId: 1, seconds: 30 });
    assert.strictEqual(res.active, true);
    assert.strictEqual(res.seconds, 30);
    assert.ok(alarms.has(alarmName(1)));
    assert.strictEqual(alarms.get(alarmName(1)).periodInMinutes, 30 / 60);
    assert.strictEqual(store.tabs["1"].seconds, 30);
    assert.strictEqual(badges[1], "⟳");
    pass++;
  }

  // out-of-range seconds get clamped before being stored
  {
    const res = await dispatch({ type: "start", tabId: 2, seconds: 1 });
    assert.strictEqual(res.seconds, MIN_SECONDS);
    pass++;
  }

  // status reflects what's stored
  {
    const res = await dispatch({ type: "status", tabId: 1 });
    assert.strictEqual(res.active, true);
    assert.strictEqual(res.seconds, 30);
    const off = await dispatch({ type: "status", tabId: 999 });
    assert.strictEqual(off.active, false);
    pass++;
  }

  // firing the alarm reloads the tab and reschedules nextAt
  {
    const before = store.tabs["1"].nextAt;
    await alarmHandler({ name: alarmName(1) });
    assert.deepStrictEqual(reloaded, [1]);
    assert.ok(store.tabs["1"].nextAt >= before);
    pass++;
  }

  // firing an alarm for a tab that no longer exists stops the loop instead of reloading
  {
    liveTabs.delete(2);
    await alarmHandler({ name: alarmName(2) });
    assert.strictEqual(reloaded.includes(2), false);
    assert.strictEqual(store.tabs["2"], undefined);
    assert.strictEqual(alarms.has(alarmName(2)), false);
    pass++;
  }

  // stop clears the alarm, storage entry, and badge
  {
    const res = await dispatch({ type: "stop", tabId: 1 });
    assert.strictEqual(res.active, false);
    assert.strictEqual(alarms.has(alarmName(1)), false);
    assert.strictEqual(store.tabs["1"], undefined);
    assert.strictEqual(badges[1], "");
    pass++;
  }

  // closing a tab cleans up its loop even without an explicit "stop" message
  {
    await dispatch({ type: "start", tabId: 3, seconds: 30 });
    liveTabs.add(3);
    await removedHandler(3);
    assert.strictEqual(alarms.has(alarmName(3)), false);
    assert.strictEqual(store.tabs["3"], undefined);
    pass++;
  }

  // browser restart clears every stored loop rather than silently resuming
  {
    await dispatch({ type: "start", tabId: 4, seconds: 30 });
    assert.ok(alarms.has(alarmName(4)));
    await startupHandler();
    assert.strictEqual(alarms.has(alarmName(4)), false);
    assert.deepStrictEqual(store.tabs, {});
    pass++;
  }
}

console.log(`${pass} test groups passed`);
