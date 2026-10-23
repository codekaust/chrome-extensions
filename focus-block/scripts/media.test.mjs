import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditMedia, creditCombined } from '../src/media.js';
import { buildStats } from '../src/stats.js';

const now = new Date(2026, 9, 23, 12).getTime();
const initial = () => ({ mediaUsage: {}, mediaCoverage: {}, mediaCutoff: 0 });
const total = state => Object.values(state.mediaUsage).reduce((sum, sites) => sum + Object.values(sites).reduce((a, b) => a + b, 0), 0);
test('overlapping players, frames and detectors count once per domain, in any arrival order', () => {
  let state = initial();
  for (const interval of [[now-20000,now-10000], [now-30000,now-15000], [now-15000,now], [now-30000,now]]) {
    state = creditMedia(state, 'youtube.com', [interval], now);
  }
  assert.equal(total(state), 30);
  state = creditMedia(state, 'music.youtube.com', [[now-30000,now]], now);
  assert.equal(total(state), 60);
  assert.deepEqual(Object.keys(state.mediaUsage['2026-10-23']), ['youtube.com', 'music.youtube.com']);
});
test('cleared history and disabled periods cannot return in late reports', () => {
  const state = { ...initial(), mediaCutoff: now-5000 };
  const next = creditMedia(state, 'primevideo.com', [[now-30000,now-10000], [now-10000,now]], now);
  assert.equal(total(next), 5);
});
test('reject sleep gaps, future intervals, non-finite values and negative durations', () => {
  const next = creditMedia(initial(), 'example.com', [[now-600000,now], [now,now+5000], [NaN,now], [now,now-1]], now);
  assert.equal(total(next), 0);
});
test('midnight is split into separate local days', () => {
  const midnight = new Date(2026,9,23,0,0,5).getTime();
  const next = creditMedia(initial(), 'example.com', [[midnight-10000,midnight]], midnight);
  assert.equal(next.mediaUsage['2026-10-22']['example.com'], 5);
  assert.equal(next.mediaUsage['2026-10-23']['example.com'], 5);
});
test('old coverage expires without dropping history; late old intervals do not double count', () => {
  let state = creditMedia(initial(), 'example.com', [[now-10000,now]], now);
  state = creditMedia(state, 'new.com', [[now+190000,now+200000]], now+200000);
  assert.equal(state.mediaCoverage['example.com'], undefined);
  state = creditMedia(state, 'example.com', [[now-10000,now]], now+200000);
  assert.equal(total(state), 20);
});
test('stats expose independent playback series and preserve existing browsing history', () => {
  const stats = buildStats({usage: {'2026-10-23': {'work.com': 120}}, mediaUsage: {'2026-10-22': {'music.youtube.com': 60}, '2026-10-23': {'primevideo.com': 90}}}, now);
  assert.equal(stats.todayTotal, 120);
  assert.equal(stats.media.todayTotal, 90);
  assert.equal(stats.media.weekTotal, 150);
  assert.equal(stats.media.days[5].sites[0].domain, 'music.youtube.com');
  assert.equal(buildStats({usage:{}}, now).media.weekTotal, 0);
});

test('combined usage deduplicates browsing and playback in either arrival order', () => {
  for (const intervals of [
    [[now-20000, now-5000], [now-15000, now]],
    [[now-15000, now], [now-20000, now-5000]],
  ]) {
    let state = {};
    for (const interval of intervals) state = { ...state, ...creditCombined(state, 'youtube.com', [interval], now) };
    assert.equal(state.combinedUsage['2026-10-23']['youtube.com'], 20);
    state = { ...state, ...creditCombined(state, 'work.com', [[now-10000, now]], now) };
    assert.equal(state.combinedUsage['2026-10-23']['work.com'], 10);
    assert.equal(buildStats({ usage: {}, ...state }, now).combined.todayTotal, 30);
  }
});
test('combined stats preserve legacy totals when exact historical overlap is unavailable', () => {
  const stats = buildStats({usage:{'2026-10-23':{'youtube.com':60}},mediaUsage:{'2026-10-23':{'youtube.com':90}}},now);
  assert.equal(stats.combined.todayTotal,150);
  assert.equal(stats.combined.today.length,1);
});
