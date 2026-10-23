import { dayKey } from './stats.js';

// Reports older than this are discarded: never turn sleep/crash gaps into usage.
export const MEDIA_WINDOW = 130_000;

// Credit only the uncovered parts of an interval. Coverage is shared by all
// tabs, frames, and detectors for a domain, so simultaneous players count once.
export function creditMedia(state, domain, intervals, now) {
  const cutoff = Math.max(now - MEDIA_WINDOW, state.mediaCutoff || 0);
  const coverage = {};
  for (const [host, ranges] of Object.entries(state.mediaCoverage || {})) {
    const recent = ranges.filter(([, end]) => end > cutoff).map(([start, end]) => [Math.max(start, cutoff), end]);
    if (recent.length) coverage[host] = recent;
  }
  const usage = { ...(state.mediaUsage || {}) };
  let ranges = coverage[domain] || [];
  for (const interval of intervals) {
    if (!Array.isArray(interval) || interval.length !== 2) continue;
    let [start, end] = interval;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > now || end - start > MEDIA_WINDOW) continue;
    start = Math.max(start, cutoff);
    if (start >= end) continue;
    let cursor = start;
    const uncovered = [];
    for (const [a, b] of ranges) {
      if (b <= cursor) continue;
      if (a >= end) break;
      if (a > cursor) uncovered.push([cursor, Math.min(a, end)]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < end) uncovered.push([cursor, end]);
    for (const [a, b] of uncovered) {
      let t = a;
      while (t < b) {
        const midnight = new Date(t); midnight.setHours(24, 0, 0, 0);
        const stop = Math.min(b, midnight.getTime()), key = dayKey(t);
        usage[key] = { ...(usage[key] || {}) };
        usage[key][domain] = (usage[key][domain] || 0) + (stop - t) / 1000;
        t = stop;
      }
    }
    const merged = [];
    for (const range of [...ranges, [start, end]].sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    ranges = merged;
  }
  if (ranges.length) coverage[domain] = ranges;
  return { mediaUsage: usage, mediaCoverage: coverage };
}
