// The dashboard page: a login screen, then tabs (Overview and one per game), a
// range and platform filter, KPI cards, charts, and sync badges. Everything it
// shows comes from /api; nothing secret is in this file or reaches it.
import './style.css';
import { api, Unauthorized, explain } from './api.js';
import { fmt, day, moment, time, ago, deltaText } from './format.js';
import { destroyCharts, dayBars, stackedDayBars, dayLines, retentionCurve, sideBars, hourLine, sparkline, SERIES } from './charts.js';

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

/** What a chart's place shows when there is nothing to chart: a badge and a few words. */
const emptyState = (empty) => h('div', { class: 'empty' }, chip(empty), empty.text && h('span', { class: 'empty-text' }, empty.text));

function delta(d, days) {
  if (!d) return h('div', { class: 'delta delta-none' }, 'No earlier period to compare');
  const tone = d.good == null ? 'flat' : d.good ? 'good' : 'bad';
  const words = d.unit === 'new' ? 'Up from zero' : d.dir === 0 ? 'No change' : deltaText(d);
  return h('div', { class: `delta delta-${tone}`, title: `Against the ${days} days before` },
    icon(d.dir > 0 ? 'up' : d.dir < 0 ? 'down' : 'flat'), h('span', { class: 'delta-value' }, words), h('span', { class: 'delta-vs' }, `vs prior ${days}D`));
}

const kpiValue = (k) => (k.pair ? `${fmt(k.value, 'pct')} / ${fmt(k.value2, 'pct')}` : k.of != null ? `${fmt(k.value, 'int')} of ${k.of}` : fmt(k.value, k.format));

function kpiCard(k, days) {
  const card = h('article', { class: `kpi${k.value == null ? ' kpi-empty' : ''}` }, h('h3', { class: 'kpi-label' }, k.label));
  if (k.value == null) { card.append(h('div', { class: 'kpi-value' }, '—'), h('div', { class: 'kpi-why' }, chip(k.empty), k.empty.text && k.empty.kind !== 'none' && h('span', { class: 'empty-text' }, k.empty.text))); return card; }
  card.append(h('div', { class: 'kpi-value' }, kpiValue(k)));
  if (k.id !== 'live') card.append(delta(k.delta, days));
  if (k.sub?.length) card.append(h('div', { class: 'kpi-sub' }, k.sub.map((s) => `${fmt(s.value, s.format)} ${s.label}`).join(' · ')));
  if (k.spark) card.append(sparkline(k.spark));
  if (k.source) card.append(h('div', { class: 'kpi-src' }, k.source));
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

/** A titled box holding a chart, with a table of the same numbers behind a button. */
function panel({ title, source, wide, items, empty, table, body }) {
  const content = h('div', { class: 'panel-body' });
  const head = h('header', { class: 'panel-head' }, h('h2', null, title), items && !empty && legend(items), h('span', { class: 'spacer' }), source && !empty && h('span', { class: 'src' }, source));
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
const tiles = (list) => h('div', { class: 'tiles' }, list.map((t) => h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, t.label), h('div', { class: 'tile-value' }, fmt(t.value, t.format)), t.source && h('div', { class: 'kpi-src' }, t.source))));

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function revenuePanel(c) {
  return panel({
    title: 'Daily revenue and transactions', source: 'RevenueCat', wide: true, empty: c.empty,
    table: () => ({ columns: ['Day (UTC)', 'Revenue', 'Transactions'], rows: c.dates.map((d, i) => [day(d), fmt(c.revenue[i], 'usd'), fmt(c.transactions[i], 'int')]).reverse() }),
    body: () => [
      caption('Revenue'),
      h('div', { class: 'quiet-host' }, chartBox(190, 'Revenue each day', (cv) => dayBars(cv, { dates: c.dates, values: c.revenue, format: 'usd', label: 'Revenue', showDates: false })), c.quiet && h('div', { class: 'quiet-note' }, c.quiet)),
      caption('Transactions'),
      chartBox(120, 'Transactions each day', (cv) => dayBars(cv, { dates: c.dates, values: c.transactions, format: 'int', label: 'Transactions', color: SERIES[1] })),
    ],
  });
}

function audiencePanel(c) {
  return panel({
    title: 'Installs and DAU', empty: c.empty, items: c.series?.map((s, i) => ({ label: s.label, color: SERIES[i] })),
    table: () => ({ columns: ['Day (UTC)', ...c.series.map((s) => s.label)], rows: c.dates.map((d, i) => [day(d), ...c.series.map((s) => fmt(s.values[i], 'int'))]).reverse() }),
    body: () => chartBox(280, c.series.map((s) => s.label).join(' and ') + ' each day', (cv) => dayLines(cv, c)),
  });
}

function retentionPanel(c) {
  return panel({
    title: 'Retention curve', source: 'PostHog', empty: c.empty,
    table: () => ({ columns: ['Day', 'Came back', 'Players', 'Rate'], rows: c.points.map((p) => [`Day ${p.day}`, fmt(p.back, 'int'), fmt(p.size, 'int'), fmt(p.rate, 'pct')]) }),
    body: () => chartBox(280, 'Share of new players who came back, by day', (cv) => retentionCurve(cv, c)),
  });
}

function barsPanel({ title, source, empty, rows, label, valueText, tip, columns, cells, color }) {
  return panel({
    title, source, empty,
    table: () => ({ columns, rows: rows.map(cells) }),
    body: () => chartBox(rows.length * 28 + 18, title, (cv) => sideBars(cv, { labels: rows.map(label), values: rows.map((r) => r.v), text: (i) => valueText(rows[i]), tip: (i) => tip(rows[i], i), color })),
  });
}

function ftuePanel(c) {
  const rows = (c.steps || []).map((s) => ({ ...s, v: s.users }));
  return barsPanel({
    title: 'First-time funnel', source: 'PostHog', empty: c.empty, rows, label: (r) => r.label,
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
    h('div', { class: 'sync-when' }, s.last_ok ? ['Last pull ', h('time', { datetime: s.last_ok }, moment(s.last_ok)), ` · ${ago(s.last_ok)}`] : 'No successful pull yet'),
    s.state === 'error' && s.message && h('div', { class: 'sync-msg' }, s.message));
}
const syncPanel = (sync) => h('section', { class: 'panel wide' }, h('header', { class: 'panel-head' }, h('h2', null, 'Source sync health')), h('ul', { class: 'syncs' }, sync.map(syncBadge)));

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function gameView(v) {
  const x = v.extras, out = [
    h('div', { class: 'kpis' }, v.kpis.map((k) => kpiCard(k, v.days))),
    h('div', { class: 'grid' },
      revenuePanel(v.charts.revenue), audiencePanel(v.charts.audience), retentionPanel(v.charts.retention),
      ftuePanel(v.charts.ftue), productsPanel(v.charts.products), syncPanel(v.sync)),
  ];
  const more = [];
  if (x.hourly) more.push(panel({ title: 'Players, last 48 hours', source: 'PostHog', wide: true, body: () => chartBox(200, 'Players each hour', (cv) => hourLine(cv, { hours: x.hourly.hours, values: x.hourly.players, label: 'Players' })) }));
  if (x.store) { const rows = x.store.steps.map((s) => ({ ...s, v: s.count })); more.push(barsPanel({ title: 'Store funnel', source: 'PostHog', rows, label: (r) => r.label, valueText: (r) => fmt(r.count, 'int'), tip: (r) => [`${fmt(r.count, 'int')} times`], columns: ['Step', 'Times'], cells: (r) => [r.label, fmt(r.count, 'int')] })); }
  if (x.gfx) { const rows = x.gfx.levels.map((s) => ({ ...s, v: s.players })); more.push(barsPanel({ title: 'Graphics level', source: 'PostHog', rows, label: (r) => `Level ${r.level}`, valueText: (r) => `${fmt(r.players, 'int')} · ${fmt(r.share, 'pct')}`, tip: (r) => [`${fmt(r.players, 'int')} players`, `${fmt(r.share, 'pct')} of them`], columns: ['Level', 'Players', 'Share'], cells: (r) => [`Level ${r.level}`, fmt(r.players, 'int'), fmt(r.share, 'pct')] })); }
  if (x.community) more.push(h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h2', null, x.community.label), h('span', { class: 'spacer' }), h('span', { class: 'src' }, 'Game database')), tiles(x.community.tiles)));
  if (x.more) more.push(h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h2', null, 'More numbers')), tiles(x.more)));
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
      table: () => ({ columns: ['Day (UTC)', ...c.series.map((s) => s.label)], rows: c.dates.map((d, i) => [day(d), ...c.series.map((s) => fmt(s.values[i], 'usd'))]).reverse() }),
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
    h('span', { class: 'spacer' }),
    h('span', { class: 'updated', 'aria-live': 'polite' }, state.loading ? 'Loading…' : shown ? `Days are UTC · Updated ${time(shown.generated_at)}` : ''),
    h('button', { class: 'ghost', type: 'button', onclick: () => load(), disabled: state.loading }, 'Refresh'),
  ].filter(Boolean));
}

function paintMain() {
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
  const input = h('input', { type: 'password', name: 'password', id: 'password', autocomplete: 'current-password', required: true, autofocus: true });
  const note = h('p', { class: 'login-note', role: 'alert' }, message);
  const button = h('button', { class: 'primary', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'login', onsubmit: async (e) => {
    e.preventDefault();
    button.disabled = true; note.textContent = '';
    try { await api.login(input.value); input.value = ''; showApp(); }
    catch (err) { note.textContent = explain(err); button.disabled = false; input.select(); }
  } },
  h('div', { class: 'brand big' }, icon('wave', 'logo'), 'Abyssol'),
  h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'abyssol', hidden: true }),
  h('label', { for: 'password' }, 'Password'), input, button, note);
  app.replaceChildren(h('div', { class: 'login-wrap' }, form));
  input.focus();
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
