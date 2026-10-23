import { renderPie } from './pie.js';
import { dayKey, shiftDay, parseDay, dateLabel, fmtDuration, summarize } from '../src/stats.js';

const el = id => document.getElementById(id);
let usage = {}, today = dayKey(), report = null;
let loading = false;
let trackingOn = true;
function textNode(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function applyRange() {
  const range = el('historyRange').value;
  if (range !== 'custom') {
    el('historyEnd').value = today;
    el('historyStart').value = range === 'all'
      ? Object.keys(usage).filter(key => key <= today).sort()[0] || today
      : shiftDay(today, 1 - Number(range));
  }
  render();
}
export async function refreshStats() {
  if (loading) return;
  loading = true;
  el('refreshStats').disabled = true;
  el('historyStatus').textContent = 'Loading usage history…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'getStats', includeHistory: true });
    if (!res?.ok) throw new Error('Could not load history.');
    applySnapshot(res.stats);
  } catch (error) {
    el('historyStatus').textContent = 'Unable to load usage history. Try Refresh.';
  } finally {
    loading = false;
    el('refreshStats').disabled = false;
  }
}
function applySnapshot(stats) {
  trackingOn = stats.trackingOn;
  usage = stats.combinedUsage || {};
  today = stats.todayKey;
  for (const id of ['historyStart', 'historyEnd', 'historyDay']) el(id).max = today;
  el('historyStatus').textContent = stats.trackingOn ? '' : 'Tracking is paused. Saved history remains available. Enable tracking in General settings.';
  applyRange();
}
function render() {
  const start = el('historyStart').value, end = el('historyEnd').value;
  el('historyStart').setCustomValidity('');
  el('historyEnd').setCustomValidity('');
  if (!start || !end || start > end || end > today || start < '2000-01-01') {
    el('historyStart').setCustomValidity('Choose a start date from 2000 onward and an end date between the start and today.');
    el('historyStart').reportValidity();
    return;
  }
  report = summarize(usage, start, end);
  const peak = report.days.reduce((best, d) => d.total > best.total ? d : best, report.days[0]);
  const cards = [
    [fmtDuration(report.total), 'Total usage'],
    [fmtDuration(report.total / report.days.length), 'Daily average'],
    [String(report.sites.length), 'Unique sites'],
    [`${report.activeDays} / ${report.days.length}`, 'Days with activity'],
  ];
  el('historySummary').replaceChildren(...cards.map(([value, label]) => {
    const card = textNode('div', '', 'stat-card');
    card.append(textNode('div', value, 'stat-value'), textNode('div', label, 'stat-label'));
    return card;
  }));
  el('historyPeriodSummary').textContent = `Usage recorded on ${report.activeDays} of ${report.days.length} days${peak.total ? ` · Busiest day: ${dateLabel(peak.key)} (${fmtDuration(peak.total)})` : ''}`;
  el('historySummary').title = peak.total ? `Busiest day: ${dateLabel(peak.key)} · ${fmtDuration(peak.total)}` : 'No activity in this period';
  const picker = el('historyDay');
  picker.min = start; picker.max = end;
  if (!picker.value || picker.value < start || picker.value > end) picker.value = end;
  renderActivity(); renderWeekdays();
  renderPie(el('historySitesPie'), report.sites, 'Sites in this period');
  renderDay();
}
function bar(label, total, max, action, selected = false) {
  const col = document.createElement(action ? 'button' : 'div');
  col.className = 'bar-col';
  if (action) {
    col.type = 'button'; col.addEventListener('click', action);
    col.setAttribute('aria-pressed', String(selected));
  }
  col.title = `${label}: ${fmtDuration(total)}`;
  col.setAttribute('aria-label', col.title);
  const wrap = textNode('span', '', 'bar-wrap');
  const fill = textNode('span', '', `bar${selected ? ' bar-today' : ''}`);
  fill.style.height = `${total > 0 ? Math.max(2, total / max * 100) : 0}%`;
  wrap.append(fill);
  col.append(textNode('span', fmtDuration(total), 'bar-value'), wrap, textNode('span', label, 'bar-label'));
  return col;
}
function renderActivity() {
  const monthly = el('historyGrouping').value === 'month';
  const buckets = new Map();
  for (const day of report.days) {
    const key = monthly ? day.key.slice(0, 7) : day.key;
    const bucket = buckets.get(key) || { key, start: day.key, end: day.key, total: 0 };
    bucket.total += day.total; bucket.end = day.key; buckets.set(key, bucket);
  }
  const max = Math.max(1, ...Array.from(buckets.values(), d => d.total));
  el('historyChart').replaceChildren(...Array.from(buckets.values(), d => {
    const label = monthly ? parseDay(d.start).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
      : parseDay(d.key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return bar(label, d.total, max, () => {
      if (monthly) {
        el('historyRange').value = 'custom'; el('historyStart').value = d.start; el('historyEnd').value = d.end;
        el('historyGrouping').value = 'day'; render();
      } else {
        el('historyDay').value = d.key; renderDay();
        // Update selection without replacing the focused chart button.
        Array.from(el('historyChart').children).forEach((col, i) => {
          const active = report.days[i].key === d.key;
          col.setAttribute('aria-pressed', String(active));
          col.querySelector('.bar').classList.toggle('bar-today', active);
        });
      }
    }, !monthly && d.key === el('historyDay').value);
  }));
}
function renderWeekdays() {
  const totals = Array.from({ length: 7 }, () => ({ total: 0, count: 0 }));
  for (const d of report.days) {
    const item = totals[parseDay(d.key).getDay()]; item.total += d.total; item.count++;
  }
  const averages = totals.map(d => d.count ? d.total / d.count : 0);
  el('weekdayChart').replaceChildren(...[1, 2, 3, 4, 5, 6, 0].map(i =>
    bar(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i], averages[i], Math.max(1, ...averages))));
}
function renderDay() {
  if (!report) return;
  const d = report.days.find(d => d.key === el('historyDay').value);
  if (!d) return;
  el('historyDaySummary').textContent = `${dateLabel(d.key)} · ${fmtDuration(d.total)} total · ${d.sites.length} sites`;
  renderPie(el('historyDayPie'), d.sites, dateLabel(d.key));
}
el('refreshStats').addEventListener('click', refreshStats);
el('historyRange').addEventListener('change', applyRange);
for (const id of ['historyStart', 'historyEnd']) el(id).addEventListener('change', () => { el('historyRange').value = 'custom'; render(); });
el('historyGrouping').addEventListener('change', () => { if (report) renderActivity(); });
el('historyDay').addEventListener('change', () => { renderDay(); if (report) renderActivity(); });
// Apply storage events directly. Fetching getStats here would flush usage again
// and could create a feedback loop while another browser window is active.
chrome.storage.onChanged.addListener((changes, area) => {
  if (loading || area !== 'local' || (!changes.combinedUsage && !changes.settings)) return;
  if (changes.settings) trackingOn = changes.settings.newValue?.trackUsage !== false;
  applySnapshot({
    combinedUsage: changes.combinedUsage ? changes.combinedUsage.newValue || {} : usage,
    todayKey: dayKey(), trackingOn,
  });
});
