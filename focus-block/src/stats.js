// Calendar-day helpers use local time, including across daylight-saving changes.
export function dayKey(value = Date.now()) {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function shiftDay(key, count) {
  const d = parseDay(key);
  d.setDate(d.getDate() + count);
  return dayKey(d);
}
export function dateLabel(key) {
  return parseDay(key).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}
export function fmtDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return s <= 0 ? '0m' : '<1m';
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}
export function sitesFor(map = {}) {
  return Object.entries(map)
    .filter(([, seconds]) => Number.isFinite(seconds) && seconds > 0)
    .map(([domain, seconds]) => ({ domain, seconds }))
    .sort((a, b) => b.seconds - a.seconds || a.domain.localeCompare(b.domain));
}
export function summarize(usage, start, end) {
  const totals = new Map(), days = [];
  for (let key = start; key <= end; key = shiftDay(key, 1)) {
    const sites = sitesFor(usage[key]);
    const total = sites.reduce((sum, s) => sum + s.seconds, 0);
    days.push({ key, total, sites });
    for (const s of sites) totals.set(s.domain, (totals.get(s.domain) || 0) + s.seconds);
  }
  return {
    days, sites: sitesFor(Object.fromEntries(totals)),
    total: days.reduce((sum, d) => sum + d.total, 0),
    activeDays: days.filter(d => d.total > 0).length,
  };
}
export function buildStats(state, t) {
  const todayKey = dayKey(t);
  const week = summarize(state.usage, shiftDay(todayKey, -6), todayKey);
  const today = week.days.at(-1);
  const mediaWeek = summarize(state.mediaUsage || {}, shiftDay(todayKey, -6), todayKey);
  const mediaToday = mediaWeek.days.at(-1);
  const media = { todayKey, today: mediaToday.sites, todayTotal: mediaToday.total, weekTotal: mediaWeek.total, days: mediaWeek.days };
  return { media, todayKey, today: today.sites, todayTotal: today.total, weekTotal: week.total, days: week.days };
}
