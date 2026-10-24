import { dayKey } from './stats.js';

// Daily time limits — pure helpers shared by the worker, popup, options and
// block page. A limited site is allowed until today's usage reaches its limit,
// then blocked until local midnight. "Usage" is the same merged browsing +
// playback total the Stats tab shows, so a background video counts too.

export const LIMIT_PRESETS = [15, 30, 45, 60, 90, 120, 180]; // minutes
const MAX_LIMIT = 24 * 60;
const MAX_TICK = 130; // mirrors background.js: larger gaps are never credited

// A whole number of minutes in [1, 1440], or null if unusable.
export function clampLimit(minutes) {
  const n = Math.round(Number(minutes));
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, MAX_LIMIT);
}

export function nextMidnight(t) {
  const d = new Date(t);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// Seconds spent on `dom` today, including the in-progress (not yet flushed)
// active session so the limit bites on time rather than a minute late.
export function usedToday(state, dom, t) {
  const history = state.combinedUsage ?? state.usage ?? {};
  let used = history[dayKey(t)]?.[dom] || 0;
  const session = state.session;
  if (session && session.domain === dom) {
    const startOfDay = nextMidnight(t) - 86_400_000;
    const elapsed = (t - Math.max(session.since, startOfDay)) / 1000;
    if (elapsed > 0 && elapsed <= MAX_TICK) used += elapsed;
  }
  return used;
}

// Seconds left today for a limited site, or null if the site has no limit.
export function limitRemaining(state, dom, t) {
  const minutes = state.timeLimits?.[dom];
  if (!minutes) return null;
  return Math.max(0, minutes * 60 - usedToday(state, dom, t));
}

export function isLimitReached(state, dom, t) {
  const left = limitRemaining(state, dom, t);
  return left !== null && left <= 0;
}

// How strict each mode is, for deciding whether a change loosens blocking
// (and so needs the password). A limited site is also blocked during focus,
// so it is stricter than focus-only.
const RANK = { always: 3, limit: 2, focus: 1 };
export function isLoosening(from, to) {
  if (!from) return false; // adding a new site never loosens anything
  if (from.mode === to.mode) return to.mode === 'limit' && to.minutes > from.minutes;
  return RANK[to.mode] < RANK[from.mode];
}
