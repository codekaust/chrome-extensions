import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, shiftDay, summarize, buildStats } from '../src/stats.js';

test('daily drilldown, period ranking, missing days and fractional totals', () => {
  const usage = {
    '2026-10-20': { 'one.com': 60.4, 'two.com': 20 },
    '2026-10-22': { 'one.com': 10.2, 'three.com': 90 },
    '2026-01-01': { 'old.com': 4000 },
  };
  const result = summarize(usage, '2026-10-20', '2026-10-22');
  assert.equal(result.days.length, 3);
  assert.equal(result.days[1].total, 0);
  assert.equal(result.activeDays, 2);
  assert.ok(Math.abs(result.total - 180.6) < 1e-9);
  assert.deepEqual(result.sites.map(s => s.domain), ['three.com', 'one.com', 'two.com']);
  assert.ok(Math.abs(result.sites[1].seconds - 70.6) < 1e-9);
  assert.equal(result.days[0].sites[0].domain, 'one.com');
  assert.ok(Math.abs(summarize(usage, '2026-01-01', '2026-10-22').total - 4180.6) < 1e-9);
});
test('popup includes all sites for each of seven days, with today separate', () => {
  const stats = buildStats({ usage: { '2026-10-22': { 'yesterday.com': 120 } } }, new Date(2026, 9, 23, 12));
  assert.equal(stats.todayKey, '2026-10-23');
  assert.equal(stats.todayTotal, 0);
  assert.equal(stats.weekTotal, 120);
  assert.equal(stats.days.length, 7);
  assert.equal(stats.days[5].sites[0].domain, 'yesterday.com');
  assert.equal(stats.days[5].total, 120);
});
test('empty history yields zero totals and complete calendar days', () => {
  const result = summarize({}, '2026-10-01', '2026-10-31');
  assert.equal(result.days.length, 31);
  assert.equal(result.total, 0);
  assert.equal(result.activeDays, 0);
  assert.deepEqual(result.sites, []);
});
test('calendar dates across leap day, year boundary and DST', () => {
  assert.equal(shiftDay('2024-03-01', -1), '2024-02-29');
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
  process.env.TZ = 'America/New_York';
  for (const date of [new Date(2026, 2, 10, 0, 30), new Date(2026, 10, 3, 23, 30)]) {
    const stats = buildStats({ usage: {} }, date);
    assert.equal(new Set(stats.days.map(d => d.key)).size, 7);
    assert.equal(stats.days.at(-1).key, dayKey(date));
    assert.equal(stats.days[0].key, shiftDay(dayKey(date), -6));
  }
});
