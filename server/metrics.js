// Turns what the database returns for a game (dashboard_game) into what the
// dashboard draws: KPI cards, chart series, sync badges, and, wherever there is
// nothing to draw, a short reason instead of an empty chart. Days are days in
// the reporting time zone (config/games.json), the same for every source.
import config from '../config/games.json';
import bench from '../config/benchmarks.json';
import { dayIn, zoneName } from './zone.js';

export const ZONE = config.timezone || 'UTC';

export const RANGES = { '7d': 7, '30d': 30, '90d': 90 };
export const PLATFORMS = ['all', 'ios', 'android'];
export const SOURCES = [
  { id: 'revenuecat', label: 'RevenueCat', every: 'hourly' },
  { id: 'posthog', label: 'PostHog', every: 'hourly' },
  { id: 'apple', label: 'App Store Connect', every: 'daily' },
  { id: 'google', label: 'Google Play', every: 'daily' },
  { id: 'listing', label: 'Store listing', every: 'hourly' },
  { id: 'supabase_game', label: 'Game database', every: 'hourly' },
];
const STATE_WORD = { live: 'Live', in_review: 'In review', prelaunch: 'Pre-launch' };
const RETENTION_DAYS = [1, 3, 7, 14, 30];
const DAY = 86400000, HOUR = 3600000;

const ymd = (t) => new Date(t).toISOString().slice(0, 10);
export const addDays = (d, n) => ymd(Date.parse(d) + n * DAY);
export function dates(from, to) { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/** The dates a range covers: it ends today in the reporting zone and is n days long. */
export function rangeDates(range, now = Date.now(), zone = ZONE) {
  const n = RANGES[range] || RANGES['30d'], to = dayIn(now, zone);
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
  platforms: Object.fromEntries(['ios', 'android'].map((p) => { const s = g.config?.platforms?.[p]?.status || 'prelaunch'; return [p, { status: s, label: STATE_WORD[s], launched: g.config?.platforms?.[p]?.launched || null }]; })),
  community_label: g.config?.community_label || null, genre: g.config?.genre || null,
});

const count = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const few = (n) => (n === 0 ? 'no' : String(n));
const PLATFORM_WORD = { ios: 'iOS', android: 'Android' };

/** The view of one game on one platform over one range. */
export function buildGame(raw, { range = '30d', now = Date.now() } = {}) {
  const g = raw.game, platform = PLATFORMS.includes(raw.platform) ? raw.platform : 'all';
  const from = raw.from, to = raw.to, days = dates(from, to), n = days.length;
  const game = gameInfo(g), zone = g.config?.timezone || ZONE;
  const state = platform === 'all' ? g.status : game.platforms[platform].status;
  const sync = syncBadges(raw, now), syncBy = Object.fromEntries(sync.map((s) => [s.source, s]));
  const totals = raw.totals || {}, T = (k) => totals[k] || null, P = (k) => raw.prev?.[k] || null;
  const line = (k) => { const pts = raw.series?.[k]; if (!pts) return null; const m = new Map(pts); return days.map((d) => (m.has(d) ? m.get(d) : null)); };
  const sumLines = (ls) => { ls = ls.filter(Boolean); return ls.length ? days.map((_, i) => { const vs = ls.map((l) => l[i]).filter((v) => v != null); return vs.length ? vs.reduce((a, v) => a + v, 0) : null; }) : null; };
  // A change is only shown when the period before has at least half its days, and at least half of it
  // falls after launch: against a period before the game was out, every number is "up" by a meaningless amount.
  const liveSince = (platform === 'all' ? PLATFORMS.filter((p) => p !== 'all') : [platform]).map((p) => game.platforms[p]?.launched).filter(Boolean).sort()[0] || null;
  const prevLive = !liveSince || dates(liveSince, from).length - 1 >= Math.ceil(n / 2);
  const enough = (k) => prevLive && (P(k)?.n || 0) >= Math.ceil(n / 2);

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

  // ---- Installs: the stores' own counts, else new customers (every install makes one), else new players ----
  const storeKeys = [];
  // Apple's sales reports count first downloads; its analytics reports count them too, a day later, and stand in until a vendor number is set.
  const appleDl = T('apple.downloads') ? 'apple.downloads' : T('apple.an_downloads') ? 'apple.an_downloads' : null;
  if (platform !== 'android' && appleDl) storeKeys.push([appleDl, 'App Store']);
  if (platform !== 'ios' && T('google.installs')) storeKeys.push(['google.installs', 'Google Play']);
  const inst = (() => {
    if (storeKeys.length) return { keys: storeKeys.map((s) => s[0]), source: storeKeys.map((s) => s[1]).join(' + '), label: 'Installs' };
    if (T('revenuecat.new_customers')) return { keys: ['revenuecat.new_customers'], source: 'New players · RevenueCat', label: 'New players' };
    if (seen('posthog.new_users')) return { keys: ['posthog.new_users'], source: 'New players · PostHog', label: 'New players' };
    return null;
  })();
  const sumOf = (G, keys) => (keys.every((k) => G(k)) ? keys.reduce((a, k) => a + G(k).sum, 0) : null);
  const instLine = inst ? sumLines(inst.keys.map(line)) : null;
  kpis.push({
    id: 'installs', label: 'Installs', format: 'int', value: inst ? sumOf(T, inst.keys) : null, prev: inst ? sumOf(P, inst.keys) : null,
    delta: inst ? change(sumOf(T, inst.keys), sumOf(P, inst.keys), inst.keys.every(enough)) : null,
    sub: [], source: inst?.source || null, spark: instLine, empty: inst ? null : why(['apple', 'posthog', 'revenuecat']),
  });

  // ---- Who played each day. New: RevenueCat's customers (every install makes one), else PostHog's first sightings.
  // Active: the larger of PostHog's players and RevenueCat's customers last seen that day; where RevenueCat's own
  // count is all there is for a day (before this pull began), that, which is counted in UTC days.
  const rcNew = line('revenuecat.new_customers'), phNew = seen('posthog.new_users') ? line('posthog.new_users') : null;
  const newLine = rcNew || phNew, newSource = rcNew ? 'RevenueCat' : phNew ? 'PostHog' : null;
  const phDau = seen('posthog.dau') ? line('posthog.dau') : null;
  const rcSeen = line('revenuecat.active_customers'), rcChart = line('revenuecat.active_customers_chart'), rcBack = line('revenuecat.returning_customers');
  let utcUntil = null;
  const activeLine = phDau || rcSeen || rcChart ? days.map((d, i) => {
    const own = rcSeen?.[i] ?? null, chart = rcChart?.[i] ?? null, ph = phDau?.[i] ?? null;
    if (own == null && chart != null && !(ph > chart)) utcUntil = d;
    const vs = [own ?? chart, ph].filter((v) => v != null);
    return vs.length ? Math.max(...vs) : null;
  }) : null;
  const backLine = activeLine ? days.map((_, i) => {
    if (activeLine[i] == null) return null;
    if (rcBack?.[i] != null && rcSeen?.[i] != null && rcSeen[i] >= (phDau?.[i] ?? 0)) return rcBack[i];
    return newLine?.[i] == null ? null : Math.max(0, activeLine[i] - newLine[i]);
  }) : null;
  const activeSource = [phDau && 'PostHog', (rcSeen || rcChart) && 'RevenueCat'].filter(Boolean).join(' + ') || null;

  // ---- DAU: the average over whole days (today is still being counted) ----
  const whole = activeLine ? activeLine.slice(0, -1).filter((v) => v != null) : [];
  const dau = activeLine ? (whole.length ? mean(whole) : activeLine.at(-1)) : null;
  const prevDau = [P('posthog.dau'), P('revenuecat.active_customers_chart'), P('revenuecat.active_customers')].filter(Boolean).sort((x, y) => y.avg - x.avg)[0] || null;
  kpis.push({
    id: 'dau', label: 'DAU', format: 'num', value: dau, prev: prevDau?.avg ?? null,
    delta: dau != null && prevDau ? change(dau, prevDau.avg, prevLive && prevDau.n >= Math.ceil(n / 2)) : null,
    sub: phDau && T('posthog.wau') ? [{ label: 'WAU', value: T('posthog.wau').last, format: 'int' }] : [],
    source: activeSource ? `Active players · ${activeSource}` : null,
    spark: activeLine, empty: activeLine ? null : why(['posthog', 'revenuecat']),
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

  // What the stores have not posted yet reads as that, not as zero.
  const storeLine = storeKeys.length ? sumLines(storeKeys.map((k) => line(k[0]))) : null;
  const storeLabel = storeKeys.length ? `First downloads · ${storeKeys.map((k) => k[1]).join(' + ')}` : null;
  const byDay = [
    storeLine && { id: 'downloads', label: storeLabel, short: 'Downloads', values: storeLine, late: true },
    newLine && { id: 'new', label: 'New', values: newLine },
    activeLine && { id: 'active', label: 'Active', values: activeLine },
    backLine && backLine.some((v) => v != null) && { id: 'returning', label: 'Returning', values: backLine },
  ].filter(Boolean);
  charts.players = byDay.length ? {
    dates: days, series: byDay,
    sources: [storeLine && storeLabel, newSource && `New · ${newSource}`, activeSource && `Active · ${activeSource}`].filter(Boolean),
    notes: [
      !storeLine && state === 'live' && platform !== 'android' && syncBy.apple && syncBy.apple.state !== 'ok' ? 'App Store first downloads are not connected yet: New is every first launch RevenueCat saw.' : null,
      utcUntil ? `Active up to ${utcUntil} is RevenueCat's own count, which uses UTC days.` : null,
    ].filter(Boolean),
  } : { empty: why(['revenuecat', 'posthog']) };

  // ---- Downloads since launch ----
  const lifeKeys = storeKeys.length ? storeKeys.map((k) => k[0]) : raw.life?.['revenuecat.new_customers'] ? ['revenuecat.new_customers'] : raw.life?.['posthog.new_users'] ? ['posthog.new_users'] : [];
  const lifeMaps = lifeKeys.map((k) => new Map(raw.life?.[k] || []));
  const livePlatforms = (platform === 'all' ? ['ios', 'android'] : [platform]).filter((p) => game.platforms[p].status === 'live');
  const launched = livePlatforms.map((p) => game.platforms[p].launched).filter(Boolean).sort()[0] || null;
  const firstLife = lifeMaps.flatMap((m) => [...m.keys()]).sort()[0] || null;
  const lifeFact = raw.facts?.['revenuecat.live']?.value?.[platform] || null;
  let downloads = null;
  if (lifeKeys.length && firstLife) {
    const start = launched && launched <= to ? launched : firstLife, ds = dates(start, to);
    let run = 0, lastKnown = -1;
    const daily = ds.map((d, i) => { const vs = lifeMaps.map((m) => m.get(d)).filter((v) => v != null); if (!vs.length) return null; lastKnown = i; return vs.reduce((a, v) => a + v, 0); });
    const cumulative = daily.map((v, i) => { run += v || 0; return i <= lastKnown ? run : null; });
    const fromRc = lifeKeys[0] === 'revenuecat.new_customers';
    const total = fromRc && lifeFact?.customers != null ? Math.max(run, lifeFact.customers) : run;
    downloads = {
      dates: ds, daily, cumulative, total, launched: start, days_live: ds.length,
      today: daily.at(-1), yesterday: ds.length > 1 ? daily.at(-2) : null,
      marks: [1, 7, 14, 30, 60, 90].filter((N) => N <= ds.length && cumulative[N - 1] != null).map((N) => ({ day: N, date: ds[N - 1], value: cumulative[N - 1] })),
      source: storeKeys.length ? storeKeys.map((k) => k[1]).join(' + ') : fromRc ? 'New players · RevenueCat' : 'New players · PostHog',
      note: storeKeys.length ? null : 'Until the store’s own count is connected, a download is a first launch.',
    };
  }
  charts.downloads = downloads || { empty: why(['apple', 'revenuecat', 'posthog']) };

  // ---- Where the listing comes up in search ----
  const search = platform !== 'android' ? raw.facts?.['listing.search']?.value : null;
  const ranked = (search?.terms || []).map((t) => ({ term: t.term, now: t.rank, values: line(`listing.${t.key}`) || days.map(() => null) }));
  charts.ranks = ranked.length
    ? { dates: days, series: ranked, store: search.store, storefront: String(search.storefront || '').toUpperCase(), depth: search.depth, checked_at: search.checked_at }
    : { empty: why(['listing'], 'No search terms set') };

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
  const STORE = [['Open', 'Opened the store'], ['Tap', 'Tapped a price'], ['Sheet', 'Purchase sheet'], ['Bought', 'Bought'], ['Cancel', 'Cancelled'], ['Pending', 'Pending'], ['Error', 'Error'], ['NotReady', 'Store not ready']];
  const store = Object.fromEntries(byPrefix('posthog.store:').map((s) => [s.key, s.value]));
  extras.store = STORE.some(([k]) => store[k] > 0) ? { steps: STORE.filter(([k]) => store[k] != null).map(([k, label]) => ({ key: k, label, count: store[k] })) } : null;

  const gfx = byPrefix('posthog.gfx_level:').sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
  const gfxAll = gfx.reduce((a, s) => a + s.value, 0);
  extras.gfx = gfxAll > 0 ? { levels: gfx.map((s) => ({ level: s.key, players: s.value, share: s.value / gfxAll })) } : null;

  // The last 48 hours: who was new (RevenueCat, else PostHog) and who was playing (PostHog).
  const hourSeries = (key) => { const pts = raw.hourly?.[key]; return pts?.length ? new Map(pts.map(([h, v]) => [Date.parse(h), v])) : null; };
  const hNew = hourSeries('revenuecat.new_customers') || (seen('posthog.new_users') ? hourSeries('posthog.new_users') : null);
  // PostHog only sees players on a build that has it. Until that is most of them, its hourly count would read as a drop.
  const rc24 = raw.facts?.['revenuecat.live']?.value?.[platform]?.last24h?.active ?? null, ph24 = raw.facts?.['posthog.live']?.value?.[platform]?.last24h?.active ?? 0;
  const phCovers = !rc24 || ph24 >= 0.6 * rc24;
  const hActive = seen('posthog.dau') && phCovers ? hourSeries('posthog.active_users') : null;
  if (hNew || hActive) {
    const last = Math.floor(now / HOUR) * HOUR, hours = Array.from({ length: 48 }, (_, i) => last - (47 - i) * HOUR);
    extras.hourly = {
      hours: hours.map((h) => new Date(h).toISOString()),
      series: [hNew && { id: 'new', label: 'New', values: hours.map((h) => hNew.get(h) ?? 0) }, hActive && { id: 'active', label: 'Active', values: hours.map((h) => hActive.get(h) ?? 0) }].filter(Boolean),
      source: [hNew && (raw.hourly?.['revenuecat.new_customers']?.length ? 'New · RevenueCat' : 'New · PostHog'), hActive && 'Active · PostHog'].filter(Boolean).join(' · '),
      note: phCovers ? null : `Active by the hour comes from PostHog, which saw ${ph24} of the last day's ${rc24} players: the ones on a build that has it. It joins this chart once it sees most of them.`,
    };
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
  const loads = T('posthog.loads');
  if (loads?.sum > 0) more.push({ label: 'Average load time', value: (T('posthog.load_secs')?.sum || 0) / loads.sum, format: 'secs', source: 'PostHog' });
  if (seen('posthog.dau')) { tile('posthog.context_lost', 'Lost graphics context', 'sum', 'int', 'PostHog'); tile('posthog.gfx_lite', 'Fell back to lite graphics', 'sum', 'int', 'PostHog'); }
  extras.more = more.length ? more : null;

  // ---- The store listing: rating, versions, written reviews ----
  const fact = (k) => raw.facts?.[k]?.value || null;
  const listing = platform !== 'android' && state === 'live' ? fact('listing.ios') : null;
  extras.listing = listing ? {
    store: listing.store, checked_at: listing.checked_at, rating: listing.rating, rating_count: listing.rating_count,
    by_storefront: (listing.by_storefront || []).map((s) => ({ cc: String(s.cc).toUpperCase(), rating: s.rating, count: s.count })),
    storefronts: (listing.storefronts || []).map((c) => String(c).toUpperCase()),
    version: listing.version, version_released: listing.version_released, released: listing.released, pending: listing.pending || [],
    reviews_total: listing.reviews_total, reviews: listing.reviews, connected: !!listing.connected,
    history: line('listing.rating_count') ? { dates: days, count: line('listing.rating_count'), rating: line('listing.rating') || days.map(() => null) } : null,
  } : null;

  // ---- What the last day's players did ----
  const told = state === 'live' ? fact('posthog.stories') : null;
  const tales = (told?.players || []).filter((p) => platform === 'all' || p.platform === platform);
  extras.stories = tales.length ? { as_of: told.as_of, since: told.since, limit: told.limit, players: tales } : null;

  // ---- Today so far, and the last 24 hours ----
  const rc = state === 'live' ? fact('revenuecat.live') : null, ph = state === 'live' ? fact('posthog.live') : null;
  const rcNow = rc?.[platform]?.today?.date === to ? rc[platform] : null, phNow = ph?.[platform]?.today?.date === to && ph[platform].players > 0 ? ph[platform] : null;
  let today = null;
  if (rcNow || phNow) {
    // New is RevenueCat's (it sees every install); Active and Returning come from whichever saw more players.
    const lead = phNow && (!rcNow || phNow.today.active > rcNow.today.active) ? phNow : rcNow;
    const pick = (span) => ({ new: (rcNow || phNow)[span].new, active: lead[span].active, returning: lead[span].returning });
    const day24 = { ...pick('last24h'), purchases: Math.max(rcNow?.last24h.purchases ?? 0, phNow?.last24h.purchases ?? 0), revenue: rcNow?.last24h.revenue ?? null };
    const now0 = pick('today'), news = [];
    news.push(`${few(now0.new)[0].toUpperCase()}${few(now0.new).slice(1)} new ${now0.new === 1 ? 'player' : 'players'} and ${few(now0.active)} active so far today${now0.returning ? `; ${now0.returning} of them ${now0.returning === 1 ? 'is' : 'are'} returning` : ''}.`);
    const where = (rcNow?.countries || []).filter((c) => c.cc && c.cc !== '??');
    if (where.length) news.push(`By country today: ${where.map((c) => `${c.cc} ${c.active}${c.new ? ` (${c.new} new)` : ''}`).join(', ')}.`);
    const builds = (rcNow?.versions || []).filter((v) => v.version && v.version !== '??');
    if (builds.length > 1) news.push(`Versions in play today: ${builds.map((v) => `${v.version} × ${v.active}`).join(', ')}.`);
    news.push(`Last 24 hours: ${day24.new} new, ${day24.active} active, ${day24.returning} returning, ${day24.purchases ? `${count(day24.purchases, 'purchase')}${day24.revenue ? ` ($${day24.revenue.toFixed(2)})` : ''}` : 'no purchases'}.`);
    if (listing) {
      const waiting = (listing.pending || [])[0];
      news.push(`${listing.store}: ${waiting ? `${waiting.version} is ${waiting.label.toLowerCase()}${waiting.release === 'manual' ? ', with manual release' : ''}. ` : ''}${listing.version} is on sale.`);
      const counts = line('listing.rating_count'), before = counts ? counts.slice(0, -1).filter((v) => v != null).at(-1) : null;
      const moved = before != null && listing.rating_count !== before ? `${listing.rating_count > before ? count(listing.rating_count - before, 'new rating') : count(before - listing.rating_count, 'rating') + ' fewer'} since yesterday: ` : before != null ? 'Still ' : '';
      news.push(`${moved}${count(listing.rating_count, 'rating')}${listing.rating != null ? ` averaging ${listing.rating.toFixed(2)}` : ''}${listing.reviews_total != null ? ` and ${count(listing.reviews_total, 'written review')}` : ''}.`);
    }
    if (ranked.some((r) => r.now)) news.push(`${search.store} search, ${String(search.storefront || '').toUpperCase()}: ${ranked.map((r) => `“${r.term}” ${r.now ? `#${r.now}` : `not in the top ${search.depth}`}`).join(', ')}.`);
    news.push(rev?.sum > 0 ? `Money: $${rev.sum.toFixed(2)} from ${count(T('revenuecat.transactions')?.sum ?? 0, 'purchase')} in the last ${n} days.` : `Money: $0 from players in the last ${n} days.`);
    const out = rc?.testers?.total || 0;
    if (out) news.push(`${count(out, 'tester')} and test ${out === 1 ? 'account is' : 'accounts are'} left out of every RevenueCat number here.`);
    today = {
      date: to, as_of: (lead === phNow ? ph : rc).as_of, day_started: (rc || ph).day_started,
      now: now0, last24h: day24, source: [rcNow && 'RevenueCat', phNow && 'PostHog'].filter(Boolean).join(' + '),
      all_time: downloads ? { value: downloads.total, source: downloads.source } : null, news,
    };
  }

  // ---- Against the average: a game's own rates beside what is typical, each with its source ----
  let benchmarks = null;
  if (state === 'live' && Object.keys(totals).length) {
    const genre = bench.page_to_download.by_genre[game.genre] != null ? game.genre : 'games';
    const of = (b) => b.by_genre?.[genre] ?? b.by_genre?.games ?? null;
    const verdict = (value, typical, low) => {
      if (value == null || !typical) return null;
      const r = value / typical;
      const text = r >= 1.15 ? `${r >= 10 ? Math.round(r) : r.toFixed(1)}× the typical rate` : r > 0.87 ? 'About the typical rate' : `${Math.round(r * 100)}% of the typical rate`;
      return { ratio: r, text: low != null && value < low ? `${text}, under the usual low end` : text, tone: r >= 1.15 ? 'good' : r > 0.87 ? 'flat' : 'bad' };
    };
    const sums = (k) => T(k)?.sum ?? null, rate = (a, b) => (a != null && b > 0 ? a / b : null);
    // Downloads beside page views come from the same analytics reports, so both cover the same days; the sales count stands in without them.
    const dl = sums('apple.an_downloads') ?? sums('apple.downloads'), views = sums('apple.page_views'), shown = sums('apple.impressions'), direct = sums('apple.an_downloads') != null ? sums('apple.an_downloads_direct') : null;
    const needApple = 'Needs App Store Connect analytics';
    const row = (id, b, value, typical, extra = {}) => ({ id, label: b.label, what: b.what, format: 'pct', value, typical, ...verdictOf(value, typical, extra.low), source: b.source, url: b.url, ...extra });
    const verdictOf = (value, typical, low) => { const v = verdict(value, typical, low); return v ? { ratio: v.ratio, verdict: v.text, tone: v.tone } : { ratio: null, verdict: null, tone: null }; };
    const rows = [];
    if (platform !== 'android') {
      rows.push(row('page_to_download', bench.page_to_download, rate(dl, views), of(bench.page_to_download), { need: rate(dl, views) == null ? needApple : null, basis: rate(dl, views) != null ? `${Math.round(dl)} downloads from ${Math.round(views)} page views${direct > 0 ? `; ${Math.round(direct)} of them came straight from the search results, the page never opened` : ''}` : null, group: genre }));
      const typical = of(bench.impression_to_download) && of(bench.page_to_download) ? of(bench.impression_to_download) / of(bench.page_to_download) : null;
      rows.push(row('impression_to_page', bench.impression_to_page, rate(views, shown), typical, { need: rate(views, shown) == null ? needApple : null, basis: rate(views, shown) != null ? `${Math.round(views)} page views from ${Math.round(shown)} impressions` : null, note: bench.impression_to_page.derived, group: genre }));
      rows.push(row('impression_to_download', bench.impression_to_download, rate(dl, shown), of(bench.impression_to_download), { need: rate(dl, shown) == null ? needApple : null, basis: rate(dl, shown) != null ? `${Math.round(dl)} downloads from ${Math.round(shown)} impressions` : null, group: genre }));
    }
    const R = bench.retention, back = lifeFact?.came_back;
    for (const N of [1, 7, 30]) {
      const k = kept(N), b = R[`d${N}`];
      if (k) rows.push({ id: `d${N}`, label: b.label, what: R.what, format: 'pct', value: k.rate, typical: b.mid, low: b.low ?? null, high: b.high ?? null, top: b.top ?? null, ...verdictOf(k.rate, b.mid, b.low), basis: `${k.back} of ${k.size} new players`, source: R.source, url: R.url, need: null });
      else if (N === 1 && back?.cohort > 0) rows.push({ id: 'came_back', label: 'Came back on a later day', what: 'New players seen again on any later day. A looser count than day 1 retention, which is set beside it until PostHog has cohorts of its own.', format: 'pct', value: back.back / back.cohort, typical: b.mid, low: b.low, high: b.high, top: b.top, ...verdictOf(back.back / back.cohort, b.mid, b.low), basis: `${back.back} of ${back.cohort} players · RevenueCat`, source: R.source, url: R.url, need: null, note: 'The typical figure is day 1 retention.' });
      else rows.push({ id: `d${N}`, label: b.label, what: R.what, format: 'pct', value: null, typical: b.mid, low: b.low ?? null, high: b.high ?? null, top: b.top ?? null, ratio: null, verdict: null, tone: null, source: R.source, url: R.url, need: syncBy.posthog?.state === 'ok' ? `No players ${N} ${N === 1 ? 'day' : 'days'} old yet` : 'Needs PostHog' });
    }
    if (downloads) {
      const M = bench.first_month, goal = M.milestones[0], age = downloads.days_live, at = Math.min(age, 28) - 1;
      const so = downloads.cumulative[at] ?? downloads.cumulative.filter((v) => v != null).at(-1) ?? 0, week = Math.min(4, Math.floor(age / 7));
      const share = goal.share_by_week[String(week)], month = goal.share_by_week['4'];
      rows.push({
        id: 'first_month', label: M.label, what: M.what, format: 'int', value: so, typical: goal.downloads, ratio: so / goal.downloads, tone: so >= goal.downloads ? 'good' : 'flat',
        verdict: so >= goal.downloads ? `Past ${goal.downloads}: ${Math.round(month * 100)}% of new apps get there in four weeks` : `${Math.round((so / goal.downloads) * 100)}% of the way to ${goal.downloads}, which ${Math.round((share ?? month) * 100)}% of new apps have passed by week ${week}`,
        basis: `${Math.round(so)} in the first ${Math.min(age, 28)} days · ${downloads.source}`, source: M.source, url: M.url, need: null, milestone: true,
      });
    }
    benchmarks = { genre, rows };
  }
  extras.benchmarks = benchmarks;

  return {
    game, range, platform, from, to, days: n, state, state_label: STATE_WORD[state] || 'Pre-launch',
    clock: { zone, name: zoneName(zone, now) }, today,
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
    range, from: raw.from, to: raw.to, days: days.length, clock: { zone: ZONE, name: zoneName(ZONE, now) },
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
