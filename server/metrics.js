// Turns what the database returns for a game (dashboard_game) into what the
// dashboard draws: KPI cards, chart series, sync badges, and, wherever there is
// nothing to draw, a short reason instead of an empty chart.

export const RANGES = { '7d': 7, '30d': 30, '90d': 90 };
export const PLATFORMS = ['all', 'ios', 'android'];
export const SOURCES = [
  { id: 'revenuecat', label: 'RevenueCat', every: 'hourly' },
  { id: 'posthog', label: 'PostHog', every: 'hourly' },
  { id: 'apple', label: 'App Store Connect', every: 'daily' },
  { id: 'google', label: 'Google Play', every: 'daily' },
  { id: 'supabase_game', label: 'Game database', every: 'hourly' },
];
const STATE_WORD = { live: 'Live', in_review: 'In review', prelaunch: 'Pre-launch' };
const RETENTION_DAYS = [1, 3, 7, 14, 30];
const DAY = 86400000, HOUR = 3600000;

const ymd = (t) => new Date(t).toISOString().slice(0, 10);
export const addDays = (d, n) => ymd(Date.parse(d) + n * DAY);
export function dates(from, to) { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/** The dates a range covers: it ends today (UTC) and is n days long. */
export function rangeDates(range, now = Date.now()) {
  const n = RANGES[range] || RANGES['30d'], to = ymd(now);
  return { n, from: addDays(to, -(n - 1)), to };
}

/**
 * The change from the period before. A count changes by a percentage, a rate by
 * percentage points. `good` says whether the direction is the one you want.
 */
export function change(cur, prev, ok = true, { pp = false, upGood = true } = {}) {
  if (cur == null || prev == null || !ok) return null;
  let value;
  if (pp) value = (cur - prev) * 100;
  else if (prev === 0) return cur === 0 ? { value: 0, unit: 'pct', dir: 0, good: null } : { value: null, unit: 'new', dir: 1, good: upGood };
  else value = ((cur - prev) / Math.abs(prev)) * 100;
  const dir = Math.abs(value) < 0.05 ? 0 : value > 0 ? 1 : -1;
  return { value, unit: pp ? 'pp' : 'pct', dir, good: dir === 0 ? null : (dir > 0) === upGood };
}

/** One badge per source: how its last sync went, and exactly when it last succeeded. */
export function syncBadges(raw, now = Date.now()) {
  const by = Object.fromEntries((raw.sync || []).map((r) => [r.source, r]));
  return SOURCES.map(({ id, label, every }) => {
    const r = by[id];
    let state = 'never', word = 'No sync yet';
    if (r) {
      const msg = r.last_message || '';
      if (r.last_status === 'error') { state = 'error'; word = 'Error'; }
      else if (r.last_status === 'skipped') {
        if (/not live|no live platform/i.test(msg)) { state = 'waiting'; word = 'Waiting for launch'; }
        else if (/^not connected/i.test(msg)) { state = 'off'; word = 'Not connected'; }
        else { state = 'off'; word = 'Not set up'; }
      } else {
        const stale = now - Date.parse(r.last_ok) > (every === 'hourly' ? 3 : 30) * HOUR;
        state = stale ? 'stale' : 'ok'; word = stale ? 'Stale' : 'OK';
      }
    }
    return { source: id, label, every, state, word, last_ok: r?.last_ok || null, last_run: r?.last_run || null, message: (r?.last_message || '').slice(0, 240) };
  });
}

const gameInfo = (g) => ({
  slug: g.slug, name: g.display_name, status: g.status, status_label: STATE_WORD[g.status] || 'Pre-launch',
  platforms: Object.fromEntries(['ios', 'android'].map((p) => { const s = g.config?.platforms?.[p]?.status || 'prelaunch'; return [p, { status: s, label: STATE_WORD[s] }]; })),
  community_label: g.config?.community_label || null,
});

/** The view of one game on one platform over one range. */
export function buildGame(raw, { range = '30d', now = Date.now() } = {}) {
  const g = raw.game, platform = PLATFORMS.includes(raw.platform) ? raw.platform : 'all';
  const from = raw.from, to = raw.to, days = dates(from, to), n = days.length;
  const game = gameInfo(g);
  const state = platform === 'all' ? g.status : game.platforms[platform].status;
  const sync = syncBadges(raw, now), syncBy = Object.fromEntries(sync.map((s) => [s.source, s]));
  const totals = raw.totals || {}, T = (k) => totals[k] || null, P = (k) => raw.prev?.[k] || null;
  const line = (k) => { const pts = raw.series?.[k]; if (!pts) return null; const m = new Map(pts); return days.map((d) => (m.has(d) ? m.get(d) : null)); };
  const sumLines = (ls) => { ls = ls.filter(Boolean); return ls.length ? days.map((_, i) => { const vs = ls.map((l) => l[i]).filter((v) => v != null); return vs.length ? vs.reduce((a, v) => a + v, 0) : null; }) : null; };
  // A change is only shown when the period before has at least half its days.
  const enough = (k) => (P(k)?.n || 0) >= Math.ceil(n / 2);

  // Why there is nothing to show: the game or platform is not live, a source
  // failed or is not connected, or there is nothing in the range.
  const why = (sources, nothing = 'No data yet') => {
    if (state !== 'live') return { kind: state, badge: STATE_WORD[state] || 'Pre-launch', text: 'No live data yet' };
    const rows = sources.map((s) => syncBy[s]).filter(Boolean);
    const bad = rows.find((r) => r.state === 'error');
    if (bad) return { kind: 'error', badge: 'Sync error', text: bad.label };
    const off = rows.find((r) => r.state !== 'ok' && r.state !== 'stale');
    if (off) return { kind: 'off', badge: off.state === 'never' ? 'No sync yet' : 'Not connected', text: off.label };
    return { kind: 'none', badge: nothing, text: '' };
  };

  const kpis = [];

  // ---- Revenue ----
  const rev = T('revenuecat.revenue');
  kpis.push({
    id: 'revenue', label: 'Revenue', format: 'usd', value: rev ? rev.sum : null, prev: P('revenuecat.revenue')?.sum ?? null,
    delta: rev ? change(rev.sum, P('revenuecat.revenue')?.sum, enough('revenuecat.revenue')) : null,
    sub: rev ? [{ label: 'transactions', value: T('revenuecat.transactions')?.sum ?? 0, format: 'int' }, ...(T('revenuecat.proceeds') ? [{ label: 'proceeds', value: T('revenuecat.proceeds').sum, format: 'usd' }] : [])] : [],
    source: 'RevenueCat', spark: line('revenuecat.revenue'), empty: rev ? null : why(['revenuecat']),
  });

  // PostHog counts only once it has seen a player in this range or the one before: connected with no build
  // sending yet, its zeros would hide what RevenueCat knows.
  const seen = (k) => { const t = T(k); return t && (t.sum > 0 || (P(k)?.sum ?? 0) > 0) ? t : null; };

  // ---- Installs: the stores' own counts, else new players, else new customers ----
  const inst = (() => {
    const store = [];
    if (platform !== 'android' && T('apple.downloads')) store.push(['apple.downloads', 'App Store']);
    if (platform !== 'ios' && T('google.installs')) store.push(['google.installs', 'Google Play']);
    if (store.length) return { keys: store.map((s) => s[0]), source: store.map((s) => s[1]).join(' + '), label: 'Installs' };
    if (seen('posthog.new_users')) return { keys: ['posthog.new_users'], source: 'New players · PostHog', label: 'New players' };
    if (T('revenuecat.new_customers')) return { keys: ['revenuecat.new_customers'], source: 'New customers · RevenueCat', label: 'New customers' };
    return null;
  })();
  const sumOf = (G, keys) => (keys.every((k) => G(k)) ? keys.reduce((a, k) => a + G(k).sum, 0) : null);
  const instLine = inst ? sumLines(inst.keys.map(line)) : null;
  kpis.push({
    id: 'installs', label: 'Installs', format: 'int', value: inst ? sumOf(T, inst.keys) : null, prev: inst ? sumOf(P, inst.keys) : null,
    delta: inst ? change(sumOf(T, inst.keys), sumOf(P, inst.keys), inst.keys.every(enough)) : null,
    sub: [], source: inst?.source || null, spark: instLine, empty: inst ? null : why(['apple', 'posthog', 'revenuecat']),
  });

  // ---- DAU: the average over whole days (today is still being counted) ----
  const dauKey = seen('posthog.dau') ? 'posthog.dau' : T('revenuecat.active_customers') ? 'revenuecat.active_customers' : null;
  const dauLine = dauKey ? line(dauKey) : null;
  const whole = dauLine ? dauLine.slice(0, -1).filter((v) => v != null) : [];
  const dau = dauKey ? (whole.length ? mean(whole) : T(dauKey).avg) : null;
  kpis.push({
    id: 'dau', label: 'DAU', format: 'num', value: dau, prev: dauKey ? P(dauKey)?.avg ?? null : null,
    delta: dauKey ? change(dau, P(dauKey)?.avg, enough(dauKey)) : null,
    sub: dauKey === 'posthog.dau' && T('posthog.wau') ? [{ label: 'WAU', value: T('posthog.wau').last, format: 'int' }] : [],
    source: dauKey === 'posthog.dau' ? 'PostHog' : dauKey ? 'Active customers · RevenueCat' : null,
    spark: dauLine, empty: dauKey ? null : why(['posthog', 'revenuecat']),
  });

  // ---- Retention: of the players whose day N fell inside the range, the share who came back ----
  const cohorts = new Map(raw.cohorts || []);
  const kept = (N, shift = 0) => {
    let back = 0, size = 0;
    for (let d = addDays(from, -N - shift), end = addDays(to, -N - 1 - shift); d <= end; d = addDays(d, 1)) {
      const c = cohorts.get(d), r = c?.[`retained_d${N}`];
      if (c && c.new_users > 0 && r != null) { back += r; size += c.new_users; }
    }
    return size ? { rate: back / size, back, size } : null;
  };
  const d1 = kept(1), d7 = kept(7), d1Prev = kept(1, n);
  kpis.push({
    id: 'retention', label: 'D1 / D7 retention', format: 'pct', value: d1?.rate ?? null, value2: d7?.rate ?? null, pair: true,
    delta: d1 && d1Prev ? change(d1.rate, d1Prev.rate, true, { pp: true }) : null,
    sub: d1 ? [{ label: 'new players', value: d1.size, format: 'int' }] : [],
    source: 'PostHog', spark: null, empty: d1 || d7 ? null : why(['posthog']),
  });

  // ---- Unclean exits and crashes (lower is better) ----
  const rateOf = (G, a, b) => (G(a) && G(b)?.sum > 0 ? G(a).sum / G(b).sum : null);
  const unclean = rateOf(T, 'posthog.unclean_exits', 'posthog.sessions');
  const crashOf = (G) => {
    if (platform !== 'android') { const r = rateOf(G, 'apple.crashes', 'apple.sessions'); if (r != null) return { rate: r, source: 'App Store' }; }
    if (platform !== 'ios' && G('google.user_perceived_crash_rate')) return { rate: G('google.user_perceived_crash_rate').avg, source: 'Google Play' };
    return null;
  };
  const crash = crashOf(T), crashPrev = crashOf(P);
  if (unclean != null) {
    kpis.push({
      id: 'stability', label: 'Unclean exit rate', format: 'pct', value: unclean, upGood: false,
      delta: change(unclean, rateOf(P, 'posthog.unclean_exits', 'posthog.sessions'), enough('posthog.sessions'), { pp: true, upGood: false }),
      sub: crash ? [{ label: `crash rate · ${crash.source}`, value: crash.rate, format: 'pct' }] : [{ label: 'unclean exits', value: T('posthog.unclean_exits').sum, format: 'int' }],
      source: 'PostHog', spark: null, empty: null,
    });
  } else {
    kpis.push({
      id: 'stability', label: crash ? 'Crash rate' : 'Unclean exit / crash rate', format: 'pct', value: crash?.rate ?? null, upGood: false,
      delta: crash && crashPrev ? change(crash.rate, crashPrev.rate, true, { pp: true, upGood: false }) : null,
      sub: [], source: crash?.source || null, spark: null, empty: crash ? null : why(['posthog', platform === 'android' ? 'google' : 'apple']),
    });
  }

  // ---- Conversion: new customers who paid ----
  const conv = rateOf(T, 'revenuecat.new_paying_customers', 'revenuecat.conv_cohort_size');
  kpis.push({
    id: 'conversion', label: 'Conversion rate', format: 'pct', value: conv,
    delta: change(conv, rateOf(P, 'revenuecat.new_paying_customers', 'revenuecat.conv_cohort_size'), enough('revenuecat.conv_cohort_size'), { pp: true }),
    sub: conv != null ? [{ label: 'paying', value: T('revenuecat.new_paying_customers').sum, format: 'int' }, { label: 'new customers', value: T('revenuecat.conv_cohort_size').sum, format: 'int' }] : [],
    source: 'RevenueCat', spark: null, empty: conv != null ? null : why(['revenuecat']),
  });

  // ---- Charts ----
  const charts = {};
  const revLine = line('revenuecat.revenue');
  charts.revenue = revLine
    ? { dates: days, revenue: revLine, transactions: line('revenuecat.transactions') || days.map(() => null), quiet: rev.sum > 0 ? null : 'No sales in this range' }
    : { empty: why(['revenuecat']) };

  const audience = [
    dauLine && { id: 'dau', label: dauKey === 'posthog.dau' ? 'DAU' : 'Active customers', values: dauLine },
    instLine && { id: 'installs', label: inst.label, values: instLine },
  ].filter(Boolean);
  charts.audience = audience.length ? { dates: days, series: audience } : { empty: why(['posthog', 'revenuecat']) };

  const curve = RETENTION_DAYS.map((N) => ({ day: N, ...(kept(N) || {}) })).filter((p) => p.rate != null);
  charts.retention = curve.length ? { points: [{ day: 0, rate: 1, back: curve[0].size, size: curve[0].size }, ...curve] } : { empty: why(['posthog']) };

  const byPrefix = (prefix) => Object.entries(totals).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k.slice(prefix.length), value: v.sum }));
  const words = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  const ftue = byPrefix('posthog.ftue:').filter((s) => /^\d/.test(s.key)).sort((a, b) => (a.key < b.key ? -1 : 1));
  charts.ftue = ftue.some((s) => s.value > 0)
    ? { steps: ftue.map((s) => ({ key: s.key, label: words(s.key.replace(/^\d+[a-z]?_/, '')), users: s.value, share: ftue[0].value > 0 ? s.value / ftue[0].value : null })) }
    : { empty: why(['posthog']) };

  const products = new Map();
  const product = (id) => products.get(id) || products.set(id, { id, revenue: 0, transactions: 0 }).get(id);
  for (const s of byPrefix('revenuecat.revenue_by_product:')) product(s.key).revenue = s.value;
  for (const s of byPrefix('revenuecat.transactions_by_product:')) product(s.key).transactions = s.value;
  let items = [...products.values()].filter((p) => p.revenue > 0 || p.transactions > 0).sort((a, b) => b.revenue - a.revenue || b.transactions - a.transactions);
  if (items.length > 8) { const rest = items.slice(7); items = [...items.slice(0, 7), { id: `Other (${rest.length})`, revenue: rest.reduce((a, p) => a + p.revenue, 0), transactions: rest.reduce((a, p) => a + p.transactions, 0) }]; }
  charts.products = items.length ? { items } : { empty: rev ? { kind: 'none', badge: 'No sales in this range', text: '' } : why(['revenuecat']) };

  // ---- Extras, shown only when there is something to show ----
  const extras = {};
  const STORE = [['Tap', 'Tapped a price'], ['Sheet', 'Purchase sheet'], ['Bought', 'Bought'], ['Cancel', 'Cancelled'], ['Pending', 'Pending'], ['Error', 'Error'], ['NotReady', 'Store not ready']];
  const store = Object.fromEntries(byPrefix('posthog.store:').map((s) => [s.key, s.value]));
  extras.store = STORE.some(([k]) => store[k] > 0) ? { steps: STORE.filter(([k]) => store[k] != null).map(([k, label]) => ({ key: k, label, count: store[k] })) } : null;

  const gfx = byPrefix('posthog.gfx_level:').sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
  const gfxAll = gfx.reduce((a, s) => a + s.value, 0);
  extras.gfx = gfxAll > 0 ? { levels: gfx.map((s) => ({ level: s.key, players: s.value, share: s.value / gfxAll })) } : null;

  const perHour = raw.hourly?.['posthog.active_users'];
  if (perHour?.length) {
    const m = new Map(perHour.map(([h, v]) => [Date.parse(h), v])), last = Math.floor(now / HOUR) * HOUR;
    const hours = Array.from({ length: 48 }, (_, i) => last - (47 - i) * HOUR);
    extras.hourly = { hours: hours.map((h) => new Date(h).toISOString()), players: hours.map((h) => m.get(h) ?? 0) };
  } else extras.hourly = null;

  const players = T('supabase_game.community_players_total');
  extras.community = players ? {
    label: game.community_label || 'Community',
    tiles: [
      { label: 'Players', value: players.last, format: 'int' },
      { label: 'Active, last 7 days', value: T('supabase_game.community_active_players_7d')?.last ?? null, format: 'int' },
      { label: 'Entries this week', value: T('supabase_game.community_weekly_entries')?.last ?? null, format: 'int' },
    ],
  } : null;

  const more = [];
  const tile = (key, label, pick, format, source) => { const t = T(key); if (t) more.push({ label, value: t[pick], format, source }); };
  tile('apple.impressions', 'Impressions', 'sum', 'int', 'App Store');
  tile('apple.page_views', 'Product page views', 'sum', 'int', 'App Store');
  tile('apple.redownloads', 'Redownloads', 'sum', 'int', 'App Store');
  tile('apple.proceeds', 'Proceeds', 'sum', 'usd', 'App Store');
  tile('apple.sessions', 'Sessions (opted in)', 'sum', 'int', 'App Store');
  tile('google.active_devices', 'Active devices', 'avg', 'num', 'Google Play');
  tile('google.user_perceived_anr_rate', 'ANR rate', 'avg', 'pct', 'Google Play');
  tile('google.rating_total', 'Rating', 'last', 'rating', 'Google Play');
  tile('google.reviews_7d', 'Reviews, last 7 days', 'last', 'int', 'Google Play');
  tile('posthog.app_errors', 'App errors', 'sum', 'int', 'PostHog');
  extras.more = more.length ? more : null;

  return {
    game, range, platform, from, to, days: n, state, state_label: STATE_WORD[state] || 'Pre-launch',
    has_data: Object.keys(totals).length > 0, kpis, charts, extras, sync,
    nav: (raw.nav || []).map(gameInfo), generated_at: new Date(now).toISOString(),
  };
}

/** Every game side by side, and the portfolio's totals. */
export function buildOverview(raw, { range = '30d', now = Date.now() } = {}) {
  const views = (raw.games || []).filter(Boolean).map((g) => buildGame(g, { range, now }));
  const days = dates(raw.from, raw.to);
  const total = (id, format, label, source) => {
    const ks = views.map((v) => v.kpis.find((k) => k.id === id)).filter((k) => k.value != null);
    if (!ks.length) return { id, label, format, value: null, delta: null, sub: [], source: null, spark: null, empty: { kind: 'none', badge: 'No live data yet', text: '' } };
    const value = ks.reduce((a, k) => a + k.value, 0), withPrev = ks.filter((k) => k.prev != null && k.delta);
    const spark = days.map((_, i) => { const vs = ks.map((k) => k.spark?.[i]).filter((v) => v != null); return vs.length ? vs.reduce((a, v) => a + v, 0) : null; });
    return {
      id, label, format, value, sub: [], source, spark, empty: null,
      delta: withPrev.length === ks.length ? change(value, withPrev.reduce((a, k) => a + k.prev, 0)) : null,
    };
  };
  const live = views.filter((v) => v.game.status === 'live').length;
  const withRevenue = views.filter((v) => v.charts.revenue.revenue);
  return {
    range, from: raw.from, to: raw.to, days: days.length,
    totals: [
      total('revenue', 'usd', 'Revenue', 'All games · RevenueCat'),
      total('installs', 'int', 'Installs', 'All games'),
      total('dau', 'num', 'DAU', 'All games, added together'),
      { id: 'live', label: 'Games live', format: 'int', value: live, of: views.length, delta: null, sub: [], source: null, spark: null, empty: null },
    ],
    revenue_by_game: withRevenue.length
      ? { dates: days, series: withRevenue.map((v) => ({ slug: v.game.slug, label: v.game.name, values: v.charts.revenue.revenue })), quiet: withRevenue.some((v) => v.kpis[0].value > 0) ? null : 'No sales in this range' }
      : { empty: { kind: 'none', badge: 'No live data yet', text: '' } },
    games: views.map((v) => ({ game: v.game, state: v.state, state_label: v.state_label, has_data: v.has_data, kpis: v.kpis.map((k) => ({ ...k, spark: k.id === 'revenue' ? k.spark : null })), sync: v.sync })),
    nav: views.map((v) => v.game), sources: SOURCES, generated_at: new Date(now).toISOString(),
  };
}
