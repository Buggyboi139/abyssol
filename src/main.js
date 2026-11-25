// The dashboard page: a login screen, then tabs (Overview and one per game), a
// range and platform filter, KPI cards, charts, and sync badges. Everything it
// shows comes from /api; nothing secret is in this file or reaches it.
import './style.css';
import { api, Unauthorized, explain } from './api.js';
import { fmt, day, moment, time, ago, deltaText, clockIn, dateOf } from './format.js';
import { destroyCharts, dayBars, stackedDayBars, dayLines, retentionCurve, sideBars, hourLines, growthLine, rankLines, sparkline, colorOf, SERIES } from './charts.js';

const RANGES = [['7d', '7D'], ['30d', '30D'], ['90d', '90D']];
const PLATFORMS = [['all', 'All'], ['ios', 'iOS'], ['android', 'Android']];
const app = document.getElementById('app');
const state = { authed: false, view: 'overview', range: '30d', platform: 'all', nav: [], data: null, error: null, loading: false, seq: 0 };
let afterAttach = [];

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  dot: [['circle', { cx: 8, cy: 8, r: 4, fill: 'currentColor' }]],
  half: [['circle', { cx: 8, cy: 8, r: 4.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }], ['path', { d: 'M8 3.500a4.500 4.500 0 0 1 0 9z', fill: 'currentColor' }]],
  ring: [['circle', { cx: 8, cy: 8, r: 4.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }]],
  check: [['path', { d: 'M3.500 8.500l3 3L12.500 5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]],
  alert: [['path', { d: 'M8 2.500l6 10.500H2z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }], ['path', { d: 'M8 6.500v3M8 11.300v.2', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round' }]],
  cross: [['path', { d: 'M4.500 4.500l7 7M11.500 4.500l-7 7', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }]],
  clock: [['circle', { cx: 8, cy: 8, r: 5.2, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }], ['path', { d: 'M8 5.200V8l2 1.300', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round' }]],
  up: [['path', { d: 'M8 3.500l4.500 8h-9z', fill: 'currentColor' }]],
  down: [['path', { d: 'M8 12.500l4.500-8h-9z', fill: 'currentColor' }]],
  flat: [['path', { d: 'M3.500 8h9', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }]],
  info: [['circle', { cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 }], ['path', { d: 'M8 7.300v4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round' }], ['circle', { cx: 8, cy: 4.800, r: 0.95, fill: 'currentColor' }]],
  wave: [['path', { d: 'M1.500 10.500c2 0 2-2 4.300-2s2.300 2 4.400 2 2.200-2 4.300-2M1.500 6c2 0 2-2 4.300-2s2.300 2 4.400 2 2.200-2 4.300-2', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round' }]],
};
function icon(name, cls = '') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', `icon ${cls}`.trim());
  for (const [tag, attrs] of ICONS[name]) { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); svg.append(el); }
  return svg;
}

const STATUS_ICON = { live: 'dot', in_review: 'half', prelaunch: 'ring' };
const pill = (status, label, extra = '') => h('span', { class: `pill pill-${status} ${extra}`.trim() }, icon(STATUS_ICON[status] || 'ring'), label);

const CHIP_ICON = { live: 'dot', in_review: 'half', prelaunch: 'ring', error: 'cross', off: 'ring', none: 'flat' };
const chip = (empty) => h('span', { class: `chip chip-${empty.kind}` }, icon(CHIP_ICON[empty.kind] || 'ring'), empty.badge);

/** A small label in a pill. A tone (good, bad, warn) tints it and always comes with an icon. */
const TONE_ICON = { good: 'up', bad: 'down', warn: 'alert', flat: 'flat' };
const tag = (label, tone = '', mark = TONE_ICON[tone]) => h('span', { class: `tag${tone ? ` tag-${tone}` : ''}` }, mark && icon(mark), label);

/** What a chart's place shows when there is nothing to chart: a badge and a few words. */
const emptyState = (empty) => h('div', { class: 'empty' }, chip(empty), empty.text && h('span', { class: 'empty-text' }, empty.text));

// ---- The info button: sources, rules and caveats live behind it, never on the panel ----
// One popover at a time, on the page's top layer, so no panel clips it. It opens on a click or a tap,
// and closes on a second one, a click anywhere else, or Escape.
let openInfo = null, infoSeq = 0;
function closeInfo(refocus = false) {
  if (!openInfo) return;
  const { btn, pop } = openInfo; openInfo = null;
  pop.remove(); btn.setAttribute('aria-expanded', 'false'); btn.removeAttribute('aria-controls');
  if (refocus && btn.isConnected) btn.focus();
}
function placeInfo() {
  if (!openInfo) return;
  const { btn, pop } = openInfo;
  if (!btn.isConnected) return closeInfo();
  const r = btn.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight, w = pop.offsetWidth, ht = pop.offsetHeight;
  if (r.bottom < 0 || r.top > vh) return closeInfo();
  const below = r.bottom + 6 + ht <= vh - 8 || r.top - 6 - ht < 8;
  pop.style.left = `${Math.max(8, Math.min(vw - w - 8, r.left + r.width / 2 - w / 2))}px`;
  pop.style.top = `${Math.max(8, below ? r.bottom + 6 : r.top - 6 - ht)}px`;
}
function info(label, ...content) {
  const kids = content.flat(Infinity).filter((k) => k != null && k !== false && k !== '');
  if (!kids.length) return null;
  const id = `info-${++infoSeq}`;
  const btn = h('button', { class: 'info', type: 'button', 'aria-label': `About ${label}`, 'aria-expanded': 'false', onclick: (e) => {
    e.preventDefault(); e.stopPropagation();
    const mine = openInfo?.btn === btn;
    closeInfo();
    if (mine) return;
    const pop = h('div', { class: 'pop', id, role: 'dialog', 'aria-label': `About ${label}` }, h('div', { class: 'pop-title' }, label), kids);
    document.body.append(pop);
    openInfo = { btn, pop }; btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('aria-controls', id);
    placeInfo();
  } }, icon('info'));
  return btn;
}
document.addEventListener('click', (e) => { if (openInfo && !openInfo.pop.contains(e.target)) closeInfo(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openInfo) { e.preventDefault(); closeInfo(true); } });
window.addEventListener('scroll', placeInfo, { passive: true, capture: true });
window.addEventListener('resize', placeInfo);
/** A sentence in a popover. */
const say = (text) => (text ? h('p', null, text) : null);
/** A name and its value in a popover. */
const fact = (k, v) => (v == null || v === '' || v === false ? null : h('div', { class: 'pop-row' }, h('span', { class: 'pop-k' }, k), h('span', { class: 'pop-v' }, v)));

/** A change against the period before, as a tinted chip: "+14%", "−2.1 pp". Nothing when there is no period to compare. */
function delta(d, days) {
  if (!d) return null;
  const tone = d.good == null ? 'flat' : d.good ? 'good' : 'bad', sign = d.dir > 0 ? '+' : '−';
  const text = d.unit === 'new' ? 'New' : d.dir === 0 ? 'No change' : d.unit === 'pp' ? `${sign}${Math.abs(d.value).toFixed(1)} pp` : `${sign}${deltaText(d)}`;
  return h('span', { class: `tag tag-${tone}`, title: `Against the ${days} days before` }, icon(d.dir > 0 ? 'up' : d.dir < 0 ? 'down' : 'flat'), text);
}

const kpiValue = (k) => (k.pair ? `${fmt(k.value, 'pct')} / ${fmt(k.value2, 'pct')}` : k.of != null ? `${fmt(k.value, 'int')} of ${k.of}` : fmt(k.value, k.format));

/** A KPI card: the number, its change, a line of detail and a sparkline. Its source and rule are behind the info button. */
function kpiCard(k, days) {
  const about = info(k.label, say(k.rule), k.pair && fact('Shown', 'Day 1 / day 7'), fact('Source', k.source),
    k.id !== 'live' && k.value != null && fact('Change', k.delta ? `Against the ${days} days before` : 'No earlier period to compare'));
  const card = h('article', { class: `kpi${k.value == null ? ' kpi-empty' : ''}` }, h('div', { class: 'kpi-head' }, h('h3', { class: 'kpi-label' }, k.label), about));
  if (k.value == null) { card.append(h('div', { class: 'kpi-value' }, '—'), h('div', { class: 'kpi-why' }, chip(k.empty), k.empty.text && k.empty.kind !== 'none' && h('span', { class: 'empty-text' }, k.empty.text))); return card; }
  card.append(h('div', { class: 'kpi-value' }, kpiValue(k)));
  const change = k.id !== 'live' ? delta(k.delta, days) : null;
  if (change || k.sub?.length) card.append(h('div', { class: 'kpi-meta' }, change, k.sub?.length ? h('span', { class: 'kpi-sub' }, k.sub.map((s) => `${fmt(s.value, s.format)} ${s.label}`).join(' · ')) : null));
  if (k.spark) card.append(sparkline(k.spark));
  return card;
}

/** A canvas in a box of a set height. The chart is drawn once the box is on the page. */
function chartBox(height, label, draw) {
  const canvas = h('canvas', { role: 'img', 'aria-label': label });
  const box = h('div', { class: 'chart' }, canvas);
  box.style.height = `${height}px`;
  afterAttach.push(() => draw(canvas));
  return box;
}

function dataTable({ columns, rows }) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, columns.map((c, i) => h('th', { scope: 'col', class: i ? 'num' : '' }, c)))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h(i ? 'td' : 'th', i ? { class: 'num' } : { scope: 'row' }, c)))))));
}

const legend = (items) => h('ul', { class: 'legend' }, items.map((it) => { const sw = h('span', { class: 'swatch' }); sw.style.background = it.color; return h('li', null, sw, it.label); }));

/** A panel's heading: its title, a legend if it has one, and the info button on the right. */
const panelHead = (title, about, ...kids) => h('header', { class: 'panel-head' }, h('h2', null, title), kids, h('span', { class: 'spacer' }), about);

/** A titled box holding a chart, with a table of the same numbers behind a button. `source` and `about` go behind the info button. */
function panel({ title, source, about, wide, items, empty, table, body }) {
  const content = h('div', { class: 'panel-body' });
  const head = panelHead(title, !empty && info(title, fact('Source', source), about), items && !empty && legend(items));
  const section = h('section', { class: `panel${wide ? ' wide' : ''}` }, head, content);
  if (empty) { content.append(emptyState(empty)); return section; }
  const chartView = h('div', { class: 'chart-view' }, body());
  content.append(chartView);
  if (table) {
    let tableView = null;
    const btn = h('button', { class: 'ghost small', type: 'button', 'aria-pressed': 'false', onclick: () => {
      const on = btn.getAttribute('aria-pressed') !== 'true';
      if (on && !tableView) { tableView = dataTable(table()); content.append(tableView); }
      btn.setAttribute('aria-pressed', String(on)); btn.textContent = on ? 'Chart' : 'Table';
      chartView.hidden = on; if (tableView) tableView.hidden = !on;
    } }, 'Table');
    head.append(btn);
  }
  return section;
}

const caption = (text) => h('div', { class: 'cap' }, text);
const tiles = (list) => h('div', { class: 'tiles' }, list.map((t) => h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, t.label), h('div', { class: 'tile-value' }, fmt(t.value, t.format)))));
const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), sub && h('div', { class: 'stat-sub' }, sub));
/** A small heading and the pills that belong to it. */
const pills = (label, list) => { list = list.filter(Boolean); return list.length ? h('div', { class: 'pgroup' }, h('span', { class: 'pgroup-k' }, label), list) : null; };

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function revenuePanel(c) {
  return panel({
    title: 'Daily revenue and transactions', source: 'RevenueCat', wide: true, empty: c.empty,
    table: () => ({ columns: ['Day', 'Revenue', 'Transactions'], rows: c.dates.map((d, i) => [day(d), fmt(c.revenue[i], 'usd'), fmt(c.transactions[i], 'int')]).reverse() }),
    body: () => [
      caption('Revenue'),
      h('div', { class: 'quiet-host' }, chartBox(190, 'Revenue each day', (cv) => dayBars(cv, { dates: c.dates, values: c.revenue, format: 'usd', label: 'Revenue', showDates: false })), c.quiet && h('div', { class: 'quiet-note' }, c.quiet)),
      caption('Transactions'),
      chartBox(120, 'Transactions each day', (cv) => dayBars(cv, { dates: c.dates, values: c.transactions, format: 'int', label: 'Transactions', color: SERIES[1] })),
    ],
  });
}

/** Today so far: who played, where, on which versions, and how the listing stands. */
function todayPanel(t, clock) {
  const n = (v) => fmt(v, 'int'), d24 = t.last24h;
  const tile = (label, value, sub) => h('div', { class: 'tstat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), sub && h('div', { class: 'stat-sub' }, sub));
  const about = info('Today so far',
    fact('Day started', clockIn(t.day_started, clock.zone)), fact('As of', time(t.as_of)), fact('Source', t.source), t.all_time && fact('All time', t.all_time.source),
    t.testers_out > 0 && fact('Left out', `${n(t.testers_out)} ${t.testers_out === 1 ? 'tester' : 'testers and test accounts'}`),
    say('New is every first launch. Active and Returning come from whichever source saw more players. The 24h figures are the last 24 hours, not the calendar day.'));
  return h('section', { class: 'panel wide today' },
    panelHead('Today so far', about),
    h('div', { class: 'tstats' },
      tile('New', n(t.now.new), `24h · ${n(d24.new)}`), tile('Active', n(t.now.active), `24h · ${n(d24.active)}`), tile('Returning', n(t.now.returning), `24h · ${n(d24.returning)}`),
      t.all_time && tile('All time', n(t.all_time.value)),
      tile('24h purchases', n(d24.purchases), d24.revenue != null ? fmt(d24.revenue, 'usd') : null)),
    h('div', { class: 'pgroups' },
      pills('Countries', (t.countries || []).slice(0, 8).map((c) => h('span', { class: 'tag', title: c.new ? `${c.new} new` : null }, h('b', null, c.cc), ` ${n(c.active)}`))),
      pills('Versions', (t.versions || []).map((v) => h('span', { class: 'tag' }, h('b', null, v.version), ` ×${n(v.active)}`))),
      t.store && pills('Store', [t.store.version && tag(`${t.store.version} live`, 'good', 'dot'), ...t.store.pending.map((p) => tag(`${p.version} ${p.label.toLowerCase()}`, 'warn', 'half'))]),
      t.rating?.count > 0 && pills('Rating', [h('span', { class: 'tag' }, h('b', null, t.rating.value == null ? '—' : t.rating.value.toFixed(1)), ` ★ (${n(t.rating.count)})`), t.rating.change > 0 && tag(`+${t.rating.change} new`, 'good')])));
}

/** New, active, and returning players a day, beside the store's own first downloads. */
function playersPanel(c) {
  const cell = (s, i, last) => (s.values[i] == null ? (s.late && i >= last - 1 ? 'not posted yet' : '—') : fmt(s.values[i], 'int'));
  return panel({
    title: 'Players by day', wide: true, empty: c.empty, items: c.series?.map((s, i) => ({ label: s.short || s.label, color: colorOf(s, i) })),
    about: [c.sources?.map((x) => { const [k, ...v] = x.split(' · '); return fact(k, v.join(' · ')); }), c.notes?.map(say), c.series?.some((s) => s.late) && say('The stores post a day’s downloads a day or two later. Until then that day has no point.')],
    table: () => ({ columns: ['Day', ...c.series.map((s) => s.label)], rows: c.dates.map((d, i) => [day(d), ...c.series.map((s) => cell(s, i, c.dates.length - 1))]).reverse() }),
    body: () => chartBox(300, c.series.map((s) => s.label).join(', ') + ' each day', (cv) => dayLines(cv, c)),
  });
}

function downloadsPanel(c) {
  return panel({
    title: 'Downloads since launch', empty: c.empty, source: c.source, about: [c.launched && fact('Launched', day(c.launched)), say(c.note)],
    table: () => ({ columns: ['Day', 'That day', 'In all'], rows: c.dates.map((d, i) => [day(d), fmt(c.daily[i], 'int'), fmt(c.cumulative[i], 'int')]).reverse() }),
    body: () => [
      h('div', { class: 'stats tight' }, stat('All time', fmt(c.total, 'int'), `${c.days_live} days`), stat('Today', fmt(c.today, 'int')), stat('Yesterday', fmt(c.yesterday, 'int')),
        c.marks.filter((m) => m.day > 1).slice(-3).map((m) => stat(`Day ${m.day}`, fmt(m.value, 'int')))),
      chartBox(210, 'Downloads in all, day by day since launch', (cv) => growthLine(cv, c)),
    ],
  });
}

const stars = (n) => h('span', { class: 'stars', role: 'img', 'aria-label': `${n} of 5 stars` }, '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n)));

/** The listing as the store shows it: rating, the versions on sale and waiting, and what reviewers wrote. */
function listingPanel(l) {
  const about = info('Store listing', fact('Source', l.store), fact('Checked', ago(l.checked_at)), fact('Storefronts', l.storefronts.join(', ')),
    say('Ratings are added up over these storefronts.'), !l.connected && say('Written reviews need App Store Connect.'));
  return h('section', { class: 'panel' },
    panelHead('Store listing', about),
    h('div', { class: 'stats tight' },
      stat('Rating', l.rating == null ? '—' : l.rating.toFixed(2), l.rating == null ? null : stars(l.rating)),
      stat('Ratings', fmt(l.rating_count, 'int')),
      stat('Reviews', l.reviews_total == null ? '—' : fmt(l.reviews_total, 'int')),
      stat('On sale', l.version || '—', l.version_released ? dateOf(l.version_released) : null)),
    h('div', { class: 'pgroups tight' },
      pills('By country', l.by_storefront.map((s) => h('span', { class: 'tag' }, h('b', null, s.cc), ` ${s.rating.toFixed(1)} ★ (${s.count})`))),
      pills('Waiting', l.pending.map((p) => tag(`${p.version} ${p.label.toLowerCase()}${p.release === 'manual' ? ' · manual' : p.release === 'scheduled' ? ' · scheduled' : ''}`, 'warn', 'half')))),
    l.reviews?.length ? h('ul', { class: 'reviews' }, l.reviews.slice(0, 6).map((r) => h('li', null,
      h('div', { class: 'review-top' }, stars(r.rating), h('strong', null, r.title), h('span', { class: 'src' }, `${r.territory} · ${dateOf(r.at)}`)),
      h('p', null, r.body)))) : null);
}

function ranksPanel(c) {
  const shown = (c.series || []).slice(0, SERIES.length);
  const about = c.empty ? null : [fact('Storefront', c.storefront), fact('Checked', ago(c.checked_at)), say(`Lower is better. A term with no rank is outside the top ${c.depth}. The history starts the day the dashboard first looked.`)];
  // A line needs two days. Until there are two, the ranks are badges.
  const days = c.empty ? 0 : c.dates.filter((_, i) => c.series.some((s) => s.values[i] != null)).length;
  if (!c.empty && days < 2) {
    return h('section', { class: 'panel' },
      panelHead('Search rank', info('Search rank', fact('Source', `${c.store} search`), about)),
      h('div', { class: 'ranks' }, c.series.map((s) => h('div', { class: `rank${s.now ? '' : ' rank-none'}` }, h('div', { class: 'rank-n' }, s.now ? `#${s.now}` : '—'), h('div', { class: 'rank-term' }, s.term)))));
  }
  return panel({
    title: 'Search rank', empty: c.empty, source: c.empty ? null : `${c.store} search`, about, items: shown.map((s, i) => ({ label: `${s.term} ${s.now ? `#${s.now}` : '—'}`, color: SERIES[i] })),
    table: () => ({ columns: ['Day', ...c.series.map((s) => s.term)], rows: c.dates.map((d, i) => [day(d), ...c.series.map((s) => (s.values[i] == null ? '—' : `#${s.values[i]}`))]).reverse() }),
    body: () => chartBox(240, 'Search rank for each term, day by day', (cv) => rankLines(cv, { dates: c.dates, series: shown })),
  });
}

/** A game's own numbers beside the average: the number, a bar for it on a track with a tick at the average and a band for the usual range, and a short verdict. The reasoning is behind each row's info button. */
function benchPanel(b) {
  const f = (v, r) => fmt(v, r.format);
  const row = (r) => {
    const top = Math.max(r.value || 0, r.average || 0, r.high || 0, r.top || 0) * 1.12 || 1, pct = (v) => Math.max(0, Math.min(100, (v / top) * 100)), at = (v) => `${pct(v).toFixed(2)}%`;
    const range = r.low != null && r.high != null ? `${f(r.low, r)} to ${f(r.high, r)}` : null;
    const words = [`${r.label}: ${r.value == null ? 'no figure yet' : f(r.value, r)}`, r.average != null && `average ${f(r.average, r)}`, range && `${r.percentiles ? '25th to 75th percentile' : 'usual range'} ${range}`].filter(Boolean).join(', ');
    const track = h('div', { class: 'bullet', role: 'img', 'aria-label': words, title: words });
    if (range) { const band = h('span', { class: 'bullet-band' }); band.style.left = at(r.low); band.style.width = `calc(${at(r.high)} - ${at(r.low)})`; track.append(band); }
    if (r.value != null) { const bar = h('span', { class: 'bullet-bar' }); bar.style.width = at(r.value); track.append(bar); }
    if (r.average != null) { const tick = h('span', { class: 'bullet-tick' }); tick.style.left = at(r.average); track.append(tick); }
    // One small figure under the track says what the tick (or, with no average, the band) stands for.
    const mark = r.average ?? (range ? (r.low + r.high) / 2 : null);
    const under = mark == null ? null : h('span', { class: `bullet-at${pct(mark) < 12 ? ' l' : pct(mark) > 88 ? ' r' : ''}`, 'aria-hidden': 'true' }, r.average != null ? f(r.average, r) : `${f(r.low, r)}–${f(r.high, r)}`);
    if (under) under.style.left = at(mark);
    const about = info(r.label, say(r.what),
      fact('Ours', r.value == null ? r.need || 'No figure yet' : f(r.value, r)), r.how && h('p', { class: 'pop-sub' }, r.how),
      r.average != null && fact(r.percentiles ? 'Median' : 'Average', f(r.average, r)),
      range && fact(r.percentiles ? '25th to 75th percentile' : 'Usual range', range),
      !range && r.high != null && fact('Top quarter', f(r.high, r)),
      r.top != null && fact('Top games', f(r.top, r)), fact('Compared with', r.peer_group), fact('Verdict', r.verdict), say(r.note), say(r.where),
      h('p', null, h('a', { class: 'link', href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.source)));
    return h('li', { class: `bench${r.value == null ? ' bench-none' : ''}` },
      h('div', { class: 'bench-name' }, r.label),
      h('div', { class: 'bench-you' }, r.value == null ? '—' : f(r.value, r)),
      h('div', { class: 'bench-bar' }, track, under),
      h('div', { class: 'bench-pill' }, r.short ? tag(r.short, r.tone || 'flat') : h('span', { class: 'bench-need' }, r.need || 'No figure yet')),
      about);
  };
  const groups = b.groups?.length ? b.groups : [null];
  const key = h('ul', { class: 'legend' }, [['bullet-bar', 'Ours'], ['bullet-tick', 'Average'], ['bullet-band', 'Usual range']].map(([c, label]) => h('li', null, h('span', { class: `key ${c}` }), label)));
  return h('section', { class: 'panel wide' },
    panelHead('Against the average', info('Against the average',
      say('Each row sets the game’s own number beside the average for a launch like it: a game released with no marketing wherever a figure for one exists.'),
      say('The bar is ours, the tick is the average, and the band is the usual range. Each row’s button says how ours is worked out and where the average comes from.')), key),
    groups.map((g) => [g && h('h3', { class: 'bench-group' }, g), h('ul', { class: 'benches' }, b.rows.filter((r) => !g || r.group === g).map(row))]));
}

/** Seconds as a short token: 4.2s, 12m, 1.5h. */
const brief = (s) => (s < 90 ? `${s < 10 ? Math.round(s * 10) / 10 : Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
const PLAT = { ios: 'iOS', android: 'Android' };
const tok = (value, label, title) => h('span', { class: 'tok', title: title || null }, h('b', null, value), label ? ` ${label}` : null);

/** One player's last day as a row of tokens. */
function storyRow(p, steps) {
  const x = p.facts, kids = [
    tag(p.new ? 'New' : 'Returning', p.new ? 'good' : '', p.new ? 'dot' : 'ring'),
    h('span', { class: 'tag' }, h('b', null, PLAT[p.platform] || p.platform || '?'), p.version ? ` ${p.version}` : null, p.country ? ` · ${p.country}` : null),
  ];
  if (!x) kids.push(h('span', { class: 'tok wrap' }, p.lines.join(' ')), (p.flags || []).map((f) => tag(f, 'warn')));
  else {
    if (!p.new && p.launches > 1) kids.push(tok(`${p.launches}${p.launches >= 5 ? '+' : ''}`, 'launches'));
    if (x.load_secs != null) kids.push(tok(brief(x.load_secs), 'load'));
    if (p.played_secs) kids.push(tok(brief(p.played_secs), 'played'));
    if (x.ftue) {
      const fill = h('i'); fill.style.width = `${steps ? Math.min(100, (x.ftue.step / steps) * 100) : 100}%`;
      kids.push(h('span', { class: 'tok ftue', title: `First-time steps: reached ${x.ftue.step}, ${x.ftue.name}` }, steps ? h('span', { class: 'meter' }, fill) : null, h('b', null, steps ? `${x.ftue.step}/${steps}` : `Step ${x.ftue.step}`)));
    }
    kids.push(x.areas.map((a) => h('span', { class: 'tag' }, h('b', null, a.name), ` ${brief(a.secs)}`)));
    if (x.gfx) kids.push(tok(`L${x.gfx}`, 'gfx', `Graphics settled at level ${x.gfx}`));
    if (x.quests) kids.push(tok(`${x.quests.done}/${x.quests.accepted}`, 'quests', `Quests: ${x.quests.offered} offered, ${x.quests.accepted} accepted, ${x.quests.done} finished, ${x.quests.left} given up`));
    if (x.chapters) kids.push(tok(x.chapters.finished.length ? `Ch ${x.chapters.finished.join(', ')}` : `Ch ${x.chapters.begun.join(', ')}`, x.chapters.finished.length ? 'done' : 'started'));
    if (x.runway) kids.push(tok(x.runway.rated || (x.runway.entered || x.runway.sent ? 'in' : 'open'), 'runway', `Runway: opened ${x.runway.opened}, rated ${x.runway.rated}, submitted ${x.runway.sent}, entered ${x.runway.entered}`));
    if (x.shop && !x.shop.bought.length) kids.push(tok(x.shop.taps ? `${x.shop.taps} tap${x.shop.taps === 1 ? '' : 's'}` : `×${x.shop.opens}`, 'shop', `Shop: opened ${x.shop.opens}, tapped a price ${x.shop.taps}, cancelled ${x.shop.cancels}`));
    kids.push(x.other.map((o) => tok(`×${o.n}`, o.name.toLowerCase())));
    kids.push(x.marks.map((m) => tag(m.label, m.tone, m.tone === 'good' ? 'check' : m.tone === 'bad' ? 'cross' : 'alert')));
  }
  return h('li', { class: 'story' }, kids, h('span', { class: 'story-when' }, `${ago(p.last_seen)} · #${p.tag}`));
}

/** What each of the last day's players did, the most recent first. */
function storiesPanel(s) {
  const about = info('What players did', fact('Source', 'PostHog'), fact('Players', `${s.players.length}${s.players.length >= s.limit ? ' most recent' : ''}`), fact('As of', time(s.as_of)),
    say('One row a player, the most recent first. The bar is how far through the first-time steps they got. The tag at the right is a one-way hash of the analytics id.'));
  return h('section', { class: 'panel wide' },
    panelHead('What players did, last 24 hours', about),
    h('ul', { class: 'stories' }, s.players.map((p) => storyRow(p, s.ftue_steps))));
}

function retentionPanel(c) {
  return panel({
    title: 'Retention curve', source: c.source || 'PostHog', empty: c.empty, about: [say('Of the players who first played on a day, the share who played again that many days later.')],
    table: () => ({ columns: ['Day', 'Came back', 'Players', 'Rate'], rows: c.points.map((p) => [`Day ${p.day}`, fmt(p.back, 'int'), fmt(p.size, 'int'), fmt(p.rate, 'pct')]) }),
    body: () => chartBox(280, 'Share of new players who came back, by day', (cv) => retentionCurve(cv, c)),
  });
}

function barsPanel({ title, source, about, empty, rows, label, valueText, tip, columns, cells, color }) {
  return panel({
    title, source, about, empty,
    table: () => ({ columns, rows: rows.map(cells) }),
    body: () => chartBox(rows.length * 28 + 18, title, (cv) => sideBars(cv, { labels: rows.map(label), values: rows.map((r) => r.v), text: (i) => valueText(rows[i]), tip: (i) => tip(rows[i], i), color })),
  });
}

function ftuePanel(c) {
  const rows = (c.steps || []).map((s) => ({ ...s, v: s.users }));
  return barsPanel({
    title: 'First-time funnel', source: c.source || 'PostHog', empty: c.empty, rows, label: (r) => r.label,
    valueText: (r) => `${fmt(r.users, 'int')} · ${fmt(r.share, 'pct')}`,
    tip: (r, i) => [`${fmt(r.users, 'int')} players`, `${fmt(r.share, 'pct')} of the first step`, ...(i && rows[i - 1].users ? [`${fmt(r.users / rows[i - 1].users, 'pct')} of the step before`] : [])],
    columns: ['Step', 'Players', 'Of first step'], cells: (r) => [r.label, fmt(r.users, 'int'), fmt(r.share, 'pct')],
  });
}

function productsPanel(c) {
  const rows = (c.items || []).map((p) => ({ ...p, v: p.revenue }));
  return barsPanel({
    title: 'Revenue by product', source: 'RevenueCat', empty: c.empty, rows, label: (r) => r.id,
    valueText: (r) => `${fmt(r.revenue, 'usd')} · ${fmt(r.transactions, 'int')} sold`,
    tip: (r) => [`${fmt(r.revenue, 'usd')} revenue`, `${fmt(r.transactions, 'int')} sold`],
    columns: ['Product', 'Revenue', 'Sold'], cells: (r) => [r.id, fmt(r.revenue, 'usd'), fmt(r.transactions, 'int')],
  });
}

const SYNC_ICON = { ok: 'check', stale: 'alert', error: 'cross', off: 'ring', waiting: 'clock', never: 'ring' };
function syncBadge(s) {
  return h('li', { class: `sync sync-${s.state}`, title: s.message || null },
    h('div', { class: 'sync-top' }, icon(SYNC_ICON[s.state]), h('span', { class: 'sync-name' }, s.label), h('span', { class: 'sync-word' }, s.word)),
    h('div', { class: 'sync-when' }, s.last_ok ? h('time', { datetime: s.last_ok, title: moment(s.last_ok) }, ago(s.last_ok)) : '—'),
    s.state === 'error' && s.message && h('div', { class: 'sync-msg' }, s.message));
}
const syncPanel = (sync) => h('section', { class: 'panel wide' },
  panelHead('Source sync health', info('Source sync health', say('Each source and when its last pull finished. Hover a badge for the exact time.'), say('RevenueCat, PostHog and the listing are pulled hourly; the stores twice a day.'))),
  h('ul', { class: 'syncs' }, sync.map(syncBadge)));

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function gameView(v) {
  const x = v.extras, out = [
    v.today && todayPanel(v.today, v.clock),
    h('div', { class: 'kpis' }, v.kpis.map((k) => kpiCard(k, v.days))),
    h('div', { class: 'grid' },
      playersPanel(v.charts.players), downloadsPanel(v.charts.downloads), x.listing ? listingPanel(x.listing) : ranksPanel(v.charts.ranks),
      x.listing && ranksPanel(v.charts.ranks), x.listing && retentionPanel(v.charts.retention),
      x.benchmarks && benchPanel(x.benchmarks),
      revenuePanel(v.charts.revenue), !x.listing && retentionPanel(v.charts.retention),
      ftuePanel(v.charts.ftue), productsPanel(v.charts.products),
      x.stories && storiesPanel(x.stories), syncPanel(v.sync)),
  ].filter(Boolean);
  const more = [];
  if (x.hourly) more.push(panel({ title: x.hourly.series.length > 1 ? 'New and active players, last 48 hours' : `${x.hourly.series[0].label} players, last 48 hours`, about: [x.hourly.source.split(' · ').reduce((rows, part, i, all) => (i % 2 ? rows : [...rows, fact(part, all[i + 1])]), []), say(x.hourly.note)], wide: true, items: x.hourly.series.length > 1 ? x.hourly.series.map((s, i) => ({ label: s.label, color: colorOf(s, i) })) : null, table: () => ({ columns: ['Hour', ...x.hourly.series.map((s) => s.label)], rows: x.hourly.hours.map((t, i) => [moment(t), ...x.hourly.series.map((s) => fmt(s.values[i], 'int'))]).reverse() }), body: () => chartBox(200, 'Players each hour', (cv) => hourLines(cv, x.hourly)) }));
  if (x.store) { const rows = x.store.steps.map((s) => ({ ...s, v: s.count })); more.push(barsPanel({ title: 'Store funnel', source: 'PostHog', rows, label: (r) => r.label, valueText: (r) => fmt(r.count, 'int'), tip: (r) => [`${fmt(r.count, 'int')} times`], columns: ['Step', 'Times'], cells: (r) => [r.label, fmt(r.count, 'int')] })); }
  if (x.gfx) {
    // Each player once when the sync has counted them so; otherwise a player counts again every day they played.
    const once = x.gfx.unit !== 'player-days', unit = once ? 'players' : 'player-days', rows = x.gfx.levels.map((s) => ({ ...s, v: s.players }));
    more.push(barsPanel({ title: 'Graphics level', source: 'PostHog', about: [fact('Counted', once ? 'Each player once' : 'Player-days'), say(once ? 'Each player counts once, at the level their game last settled on in the range.' : 'A player counts once for every day they played, so these are player-days, not players. The next PostHog sync counts each player once.')], rows, label: (r) => `Level ${r.level}`, valueText: (r) => `${fmt(r.players, 'int')} · ${fmt(r.share, 'pct')}`, tip: (r) => [`${fmt(r.players, 'int')} ${unit}`, `${fmt(r.share, 'pct')} of them`], columns: ['Level', once ? 'Players' : 'Player-days', 'Share'], cells: (r) => [`Level ${r.level}`, fmt(r.players, 'int'), fmt(r.share, 'pct')] }));
  }
  if (x.community) more.push(h('section', { class: 'panel' }, panelHead(x.community.label, info(x.community.label, fact('Source', 'Game database'))), tiles(x.community.tiles)));
  if (x.more) more.push(h('section', { class: 'panel' }, panelHead('More numbers', info('More numbers', x.more.map((t) => fact(t.label, t.source)))), tiles(x.more)));
  if (more.length) out.push(h('div', { class: 'grid' }, more));
  return out;
}

function gameCard(g, days, index) {
  const revenue = g.kpis.find((k) => k.id === 'revenue');
  return h('a', { class: 'game-card', href: hrefFor(g.game.slug, 'all') },
    h('div', { class: 'game-head' }, h('h2', null, g.game.name), pill(g.game.status, g.game.status_label)),
    h('div', { class: 'plats' }, ['ios', 'android'].map((p) => h('span', { class: 'plat' }, p === 'ios' ? 'iOS' : 'Android', pill(g.game.platforms[p].status, g.game.platforms[p].label, 'quiet')))),
    g.has_data
      ? [h('dl', { class: 'mini' }, g.kpis.map((k) => h('div', null, h('dt', null, k.label), h('dd', null, k.value == null ? '—' : kpiValue(k), k.delta && k.delta.dir !== 0 && k.delta.unit !== 'new' && h('span', { class: `mini-delta delta-${k.delta.good ? 'good' : 'bad'}` }, icon(k.delta.dir > 0 ? 'up' : 'down'), deltaText(k.delta)))))), revenue?.spark && sparkline(revenue.spark, SERIES[index % SERIES.length])]
      : h('div', { class: 'game-empty' }, emptyState({ kind: g.state, badge: g.state_label, text: 'No live data yet' })),
    h('ul', { class: 'dots', 'aria-label': 'Sync health' }, g.sync.map((s) => h('li', { class: `sync-${s.state}`, title: `${s.label}: ${s.word}${s.last_ok ? `, last pull ${moment(s.last_ok)}` : ''}` }, icon(SYNC_ICON[s.state]), h('span', { class: 'sr' }, `${s.label}: ${s.word}`)))));
}

function overviewView(o) {
  const c = o.revenue_by_game, color = (slug) => SERIES[Math.max(0, o.nav.findIndex((g) => g.slug === slug)) % SERIES.length];
  return [
    h('div', { class: 'kpis kpis-4' }, o.totals.map((k) => kpiCard(k, o.days))),
    h('div', { class: 'grid' }, panel({
      title: 'Daily revenue by game', source: 'RevenueCat', wide: true, empty: c.empty, items: c.series?.map((s) => ({ label: s.label, color: color(s.slug) })),
      table: () => ({ columns: ['Day', ...c.series.map((s) => s.label)], rows: c.dates.map((d, i) => [day(d), ...c.series.map((s) => fmt(s.values[i], 'usd'))]).reverse() }),
      body: () => h('div', { class: 'quiet-host' }, chartBox(240, 'Revenue each day, by game', (cv) => stackedDayBars(cv, { dates: c.dates, format: 'usd', series: c.series.map((s) => ({ ...s, color: color(s.slug) })) })), c.quiet && h('div', { class: 'quiet-note' }, c.quiet)),
    })),
    h('div', { class: 'games' }, o.games.map((g, i) => gameCard(g, o.days, i))),
    h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h2', null, 'Source sync health')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data matrix' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Game'), o.sources.map((s) => h('th', { scope: 'col' }, s.label)))),
        h('tbody', null, o.games.map((g) => h('tr', null, h('th', { scope: 'row' }, g.game.name), g.sync.map((s) => h('td', { class: `sync-${s.state}`, title: s.message || null }, h('span', { class: 'cell' }, icon(SYNC_ICON[s.state]), s.word), h('span', { class: 'cell-when' }, s.last_ok ? h('time', { datetime: s.last_ok, title: moment(s.last_ok) }, ago(s.last_ok)) : ''))))))))),
  ];
}

// ---------------------------------------------------------------------------
// Shell, routing, loading
// ---------------------------------------------------------------------------

const hrefFor = (view, platform = state.platform, range = state.range) => {
  const q = new URLSearchParams({ range });
  if (view !== 'overview' && platform !== 'all') q.set('platform', platform);
  return view === 'overview' ? `#/overview?${q}` : `#/game/${view}?${q}`;
};

function readHash() {
  const m = /^#\/(?:overview|game\/([a-z0-9-]+))(?:\?(.*))?$/.exec(location.hash), q = new URLSearchParams(m?.[2] || '');
  state.view = m?.[1] || 'overview';
  if (RANGES.some(([id]) => id === q.get('range'))) state.range = q.get('range');
  state.platform = state.view !== 'overview' && PLATFORMS.some(([id]) => id === q.get('platform')) ? q.get('platform') : 'all';
}

const header = h('header', { class: 'top' }), toolbar = h('div', { class: 'toolbar' }), main = h('main', { class: 'main', id: 'main' });

function seg(label, options, current, href) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label }, options.map(([id, text]) => h('a', { href: href(id), class: id === current ? 'on' : '', 'aria-current': id === current ? 'true' : null }, text)));
}

function paintChrome() {
  const tab = (view, label, status) => h('a', { href: hrefFor(view, 'all'), class: `tab${state.view === view ? ' on' : ''}`, 'aria-current': state.view === view ? 'page' : null }, label, status && pill(status.status, status.label, 'quiet'));
  header.replaceChildren(
    h('div', { class: 'brand' }, icon('wave', 'logo'), 'Abyssol'),
    h('nav', { class: 'tabs', 'aria-label': 'Games' }, tab('overview', 'Overview'), state.nav.map((g) => tab(g.slug, g.name, { status: g.status, label: g.status_label }))),
    h('button', { class: 'ghost', type: 'button', onclick: signOut }, 'Sign out'));

  const game = state.view !== 'overview' && state.nav.find((g) => g.slug === state.view);
  const shown = state.data?.body;
  toolbar.replaceChildren(...[
    seg('Range', RANGES, state.range, (id) => hrefFor(state.view, state.platform, id)),
    state.view !== 'overview' && seg('Platform', PLATFORMS, state.platform, (id) => hrefFor(state.view, id)),
    game && h('div', { class: 'plats' }, ['ios', 'android'].map((p) => h('span', { class: 'plat' }, p === 'ios' ? 'iOS' : 'Android', pill(game.platforms[p].status, game.platforms[p].label, 'quiet')))),
    h('div', { class: 'toolbar-end' },
      h('span', { class: 'updated', 'aria-live': 'polite' }, state.loading ? 'Loading…' : shown ? `Updated ${time(shown.generated_at)}` : ''),
      shown && !state.loading && info('These numbers', fact('Days are', shown.clock?.name || 'UTC'), fact('Read at', moment(shown.generated_at)),
        say('The page reads again every ten minutes while it is in front. The sources are pulled hourly, the stores twice a day.')),
      h('button', { class: 'ghost', type: 'button', onclick: () => load(), disabled: state.loading }, 'Refresh')),
  ].filter(Boolean));
  if (openInfo && !openInfo.btn.isConnected) closeInfo();
}

function paintMain() {
  closeInfo();
  destroyCharts(); afterAttach = [];
  const kids = [];
  if (state.error) kids.push(h('div', { class: 'banner', role: 'alert' }, icon('alert'), h('span', null, explain(state.error)), h('button', { class: 'ghost small', type: 'button', onclick: () => load() }, 'Try again')));
  const d = state.data;
  if (d && d.view === state.view) kids.push(...(d.view === 'overview' ? overviewView(d.body) : gameView(d.body)));
  else if (!state.error) kids.push(h('div', { class: 'kpis' }, Array.from({ length: 6 }, () => h('div', { class: 'kpi skeleton' }))), h('div', { class: 'grid' }, h('div', { class: 'panel wide skeleton tall' })));
  main.replaceChildren(...kids);
  main.classList.remove('refetching');
  for (const draw of afterAttach) draw();
  afterAttach = [];
}

async function load() {
  const seq = ++state.seq;
  state.loading = true; state.error = null;
  paintChrome();
  // What is on screen stays, dimmed, until the new numbers arrive.
  if (state.data?.view === state.view) main.classList.add('refetching'); else paintMain();
  try {
    const body = state.view === 'overview' ? await api.overview(state.range) : await api.game(state.view, state.range, state.platform);
    if (seq !== state.seq) return;
    state.data = { view: state.view, body };
    if (body.nav?.length) { state.nav = body.nav; try { sessionStorage.setItem('abyssol.nav', JSON.stringify(body.nav)); } catch { /* private mode */ } }
  } catch (e) {
    if (seq !== state.seq) return;
    if (e instanceof Unauthorized) { state.loading = false; return showLogin(); }
    state.error = e;
  }
  state.loading = false;
  paintChrome(); paintMain();
}

function showApp() {
  state.authed = true;
  try { state.nav = JSON.parse(sessionStorage.getItem('abyssol.nav')) || []; } catch { state.nav = []; }
  app.replaceChildren(h('a', { class: 'skip', href: '#main' }, 'Skip to the numbers'), header, toolbar, main);
  readHash(); load();
}

function showLogin(message = '') {
  state.authed = false; state.data = null; state.seq++;
  destroyCharts();
  const user = h('input', { type: 'text', name: 'username', id: 'username', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: true, autofocus: true });
  const input = h('input', { type: 'password', name: 'password', id: 'password', autocomplete: 'current-password', required: true });
  const note = h('p', { class: 'login-note', role: 'alert' }, message);
  const button = h('button', { class: 'primary', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'login', onsubmit: async (e) => {
    e.preventDefault();
    button.disabled = true; note.textContent = '';
    try { await api.login(user.value, input.value); input.value = ''; showApp(); }
    catch (err) { note.textContent = explain(err); button.disabled = false; input.select(); }
  } },
  h('div', { class: 'brand big' }, icon('wave', 'logo'), 'Abyssol'),
  h('label', { for: 'username' }, 'Username'), user,
  h('label', { for: 'password' }, 'Password'), input, button, note);
  app.replaceChildren(h('div', { class: 'login-wrap' }, form));
  user.focus();
}

async function signOut() {
  try { await api.logout(); } catch { /* the cookie is cleared on the next try */ }
  try { sessionStorage.removeItem('abyssol.nav'); } catch { /* private mode */ }
  showLogin();
}

window.addEventListener('hashchange', () => { if (state.authed) { readHash(); load(); } });
// The sync runs hourly: look again every ten minutes while the page is in front.
setInterval(() => { if (state.authed && !state.loading && document.visibilityState === 'visible') load(); }, 600000);

(async () => {
  try { (await api.session()).authenticated ? showApp() : showLogin(); }
  catch (e) { showLogin(explain(e)); }
})();
