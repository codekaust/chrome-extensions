import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampLimit, isLimitReached, isLoosening, limitRemaining, nextMidnight, usedToday } from '../src/limits.js';

const noon = new Date(2026, 9, 23, 12).getTime();

test('limits are whole minutes within a day', () => {
  assert.equal(clampLimit(30), 30);
  assert.equal(clampLimit('45.4'), 45);
  assert.equal(clampLimit(5000), 1440);
  for (const bad of [0, -5, 'abc', null, undefined, NaN]) assert.equal(clampLimit(bad), null);
});

test('usage counts today only, plus the unflushed active session', () => {
  const state = {
    combinedUsage: { '2026-10-22': { 'a.com': 9999 }, '2026-10-23': { 'a.com': 600 } },
    session: { domain: 'a.com', since: noon - 30_000 },
    timeLimits: { 'a.com': 15 },
  };
  assert.equal(usedToday(state, 'a.com', noon), 630);
  assert.equal(limitRemaining(state, 'a.com', noon), 270);
  assert.equal(usedToday(state, 'b.com', noon), 0);
  assert.equal(limitRemaining(state, 'b.com', noon), null, 'unlimited site has no remaining time');
  // gaps longer than a flush tick (sleep) are never credited, matching the worker
  assert.equal(usedToday({ ...state, session: { domain: 'a.com', since: noon - 600_000 } }, 'a.com', noon), 600);
  // a session that started yesterday only counts from midnight
  const justAfter = new Date(2026, 9, 23, 0, 0, 10).getTime();
  assert.equal(usedToday({ combinedUsage: {}, session: { domain: 'a.com', since: justAfter - 60_000 } }, 'a.com', justAfter), 10);
});

test('a limit is reached at exactly its length and resets the next day', () => {
  const state = { combinedUsage: { '2026-10-23': { 'a.com': 900 } }, timeLimits: { 'a.com': 15 } };
  assert.equal(isLimitReached(state, 'a.com', noon), true);
  assert.equal(isLimitReached({ ...state, timeLimits: { 'a.com': 16 } }, 'a.com', noon), false);
  assert.equal(isLimitReached(state, 'a.com', nextMidnight(noon)), false);
  assert.equal(nextMidnight(noon), new Date(2026, 9, 24).getTime());
  // falls back to browsing-only history before the merged ledger exists
  assert.equal(isLimitReached({ combinedUsage: null, usage: state.combinedUsage, timeLimits: state.timeLimits }, 'a.com', noon), true);
});

test('only changes that make a site more reachable count as loosening', () => {
  assert.equal(isLoosening(null, { mode: 'limit', minutes: 60 }), false);
  assert.equal(isLoosening({ mode: 'always' }, { mode: 'limit', minutes: 60 }), true);
  assert.equal(isLoosening({ mode: 'limit', minutes: 30 }, { mode: 'focus' }), true);
  assert.equal(isLoosening({ mode: 'limit', minutes: 30 }, { mode: 'limit', minutes: 60 }), true);
  assert.equal(isLoosening({ mode: 'limit', minutes: 30 }, { mode: 'limit', minutes: 15 }), false);
  assert.equal(isLoosening({ mode: 'limit', minutes: 30 }, { mode: 'always' }), false);
  assert.equal(isLoosening({ mode: 'focus' }, { mode: 'limit', minutes: 600 }), false);
});
