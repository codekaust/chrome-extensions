import { fmtDuration } from '../src/stats.js';

export function pieSlices(sites, limit = 7) {
  const sorted = sites.filter(s => Number.isFinite(s.seconds) && s.seconds > 0)
    .slice().sort((a, b) => b.seconds - a.seconds || a.domain.localeCompare(b.domain));
  const slices = sorted.slice(0, limit).map(site => ({ ...site, count: 1, others: false }));
  const remainder = sorted.slice(limit);
  if (remainder.length) slices.push({ domain: 'Others', seconds: remainder.reduce((sum, s) => sum + s.seconds, 0), count: remainder.length, others: true });
  return slices;
}

const expandedOthers = new WeakMap();

export function renderPie(container, sites, label) {
  const previousScroll = container.querySelector('.usage-pie-other-sites')?.scrollTop || 0;
  container.replaceChildren();
  const slices = pieSlices(sites);
  const total = slices.reduce((sum, s) => sum + s.seconds, 0);
  if (!total) {
    const empty = document.createElement('p');
    empty.className = 'stats-empty'; empty.textContent = 'No recorded usage to chart.';
    container.append(empty); return;
  }
  const ns = 'http://www.w3.org/2000/svg';
  const figure = document.createElement('figure'); figure.className = 'usage-pie-figure';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 240 240');
  svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', `${label}: ${fmtDuration(total)} total usage`);
  const legend = document.createElement('ul'); legend.className = 'usage-pie-legend';
  const details = document.createElement('div'); details.className = 'usage-pie-details';
  let othersPanel;
  if (!slices.some(slice => slice.others)) expandedOthers.delete(container);
  let angle = -Math.PI / 2;
  slices.forEach((slice, index) => {
    const fraction = slice.seconds / total;
    const next = angle + fraction * Math.PI * 2;
    const shape = document.createElementNS(ns, slices.length === 1 ? 'circle' : 'path');
    if (slices.length === 1) {
      shape.setAttribute('cx', '120'); shape.setAttribute('cy', '120'); shape.setAttribute('r', '112');
    } else {
      const point = a => `${120 + 112 * Math.cos(a)} ${120 + 112 * Math.sin(a)}`;
      shape.setAttribute('d', `M120 120 L${point(angle)} A112 112 0 ${fraction > 0.5 ? 1 : 0} 1 ${point(next)} Z`);
    }
    angle = next;
    const color = slice.others ? 'var(--pie-others)' : `var(--pie-${index + 1})`;
    shape.style.fill = color;
    const percent = fraction * 100;
    const share = percent < 0.1 ? '<0.1%' : `${percent.toFixed(1)}%`;
    const name = slice.others ? `Others (${slice.count} ${slice.count === 1 ? 'site' : 'sites'})` : slice.domain;
    const description = `${name}: ${fmtDuration(slice.seconds)} · ${share}`;
    const title = document.createElementNS(ns, 'title'); title.textContent = description;
    shape.append(title); shape.setAttribute('tabindex', '0'); shape.setAttribute('role', 'img'); shape.setAttribute('aria-label', description);
    svg.append(shape);
    const item = document.createElement('li');
    const swatch = document.createElement('span'); swatch.className = 'usage-pie-swatch'; swatch.style.background = color; swatch.setAttribute('aria-hidden', 'true');
    const site = document.createElement('span'); site.className = 'usage-pie-site'; site.textContent = name;
    const value = document.createElement('span'); value.className = 'usage-pie-value'; value.textContent = `${fmtDuration(slice.seconds)} · ${share}`;
    if (slice.others) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'usage-pie-toggle';
      const chevron = document.createElement('span'); chevron.className = 'usage-pie-chevron'; chevron.setAttribute('aria-hidden', 'true');
      button.append(swatch, site, value, chevron); item.classList.add('usage-pie-others'); item.append(button);
      othersPanel = document.createElement('section');
      othersPanel.id = `${container.id}-others`;
      othersPanel.className = 'usage-pie-breakdown';
      othersPanel.setAttribute('aria-label', `Other sites in ${label}`);
      const hint = document.createElement('p'); hint.className = 'muted small';
      hint.textContent = 'Sites in Others, ranked by usage. Percentages are shares of the full chart.';
      const list = document.createElement('ul'); list.className = 'usage-pie-other-sites';
      list.setAttribute('tabindex', '0'); list.setAttribute('aria-label', 'Other sites usage');
      const leading = new Set(slices.filter(s => !s.others).map(s => s.domain));
      const remaining = sites.filter(s => Number.isFinite(s.seconds) && s.seconds > 0 && !leading.has(s.domain))
        .slice().sort((a, b) => b.seconds - a.seconds || a.domain.localeCompare(b.domain));
      for (const entry of remaining) {
        const row = document.createElement('li');
        const domain = document.createElement('span'); domain.className = 'usage-pie-site'; domain.textContent = entry.domain;
        const amount = document.createElement('span'); amount.className = 'usage-pie-value';
        const percent = entry.seconds / total * 100;
        amount.textContent = `${fmtDuration(entry.seconds)} · ${percent < 0.1 ? '<0.1%' : `${percent.toFixed(1)}%`}`;
        row.append(domain, amount); list.append(row);
      }
      othersPanel.append(hint, list);
      shape.setAttribute('role', 'button'); shape.classList.add('usage-pie-others-slice');
      for (const control of [button, shape]) control.setAttribute('aria-controls', othersPanel.id);
      const sync = () => {
        const open = !!expandedOthers.get(container);
        othersPanel.hidden = !open;
        button.setAttribute('aria-expanded', String(open)); shape.setAttribute('aria-expanded', String(open));
        chevron.textContent = open ? '▴' : '▾';
      };
      const toggle = () => { expandedOthers.set(container, !expandedOthers.get(container)); sync(); };
      button.addEventListener('click', toggle); shape.addEventListener('click', toggle);
      shape.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
      });
      sync();
    } else item.append(swatch, site, value);
    legend.append(item);
    const highlight = active => { shape.classList.toggle('highlight', active); item.classList.toggle('highlight', active); };
    shape.addEventListener('mouseenter', () => highlight(true)); shape.addEventListener('mouseleave', () => highlight(false));
    shape.addEventListener('focus', () => highlight(true)); shape.addEventListener('blur', () => highlight(false));
    item.addEventListener('mouseenter', () => highlight(true)); item.addEventListener('mouseleave', () => highlight(false));
  });
  const caption = document.createElement('figcaption'); caption.textContent = `${fmtDuration(total)} total usage`;
  details.append(legend);
  if (othersPanel) details.append(othersPanel);
  figure.append(svg, caption); container.append(figure, details);
  const otherSites = container.querySelector('.usage-pie-other-sites');
  if (otherSites) otherSites.scrollTop = previousScroll;
}
