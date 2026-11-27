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

const PLATFORM_WORD = { ios: 'iOS', android: 'Android' };
const STABILITY_RULE = 'Unclean exits over sessions, from PostHog. The crash rate is App Store crashes over sessions, or Google Play\'s user-perceived crash rate. Lower is better.';

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
  // Trim pre-launch days from charts and sparklines so a 90D view on a younger game fills the chart instead of
  // squeezing real days onto the far right behind months of pre-launch zeros.
  const trim = liveSince && liveSince > from && liveSince <= to ? days.indexOf(liveSince) : 0;
  const chartDays = trim > 0 ? days.slice(trim) : days;
  const clip = (arr) => (arr && trim > 0 ? arr.slice(trim) : arr);

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
    sub: rev ? [{ label: 'tx', value: T('revenuecat.transactions')?.sum ?? 0, format: 'int' }, ...(T('revenuecat.proceeds') ? [{ label: 'proceeds', value: T('revenuecat.proceeds').sum, format: 'usd' }] : [])] : [],
    source: 'RevenueCat', rule: 'What players paid in the range. Proceeds are what is left after the store takes its cut.', spark: clip(line('revenuecat.revenue')), empty: rev ? null : why(['revenuecat']),
  });

  // PostHog counts only once it has seen a player in this range or the one before: connected with no build
  // sending yet, its zeros would hide what RevenueCat knows.
  const seen = (k) => { const t = T(k); return t && (t.sum > 0 || (P(k)?.sum ?? 0) > 0) ? t : null; };

  // ---- Installs: the stores' own counts plus real-time RevenueCat installs only for days the store has not posted yet ----
  const rcNew = line('revenuecat.new_customers'), phNew = seen('posthog.new_users') ? line('posthog.new_users') : null;
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
  let instTail = 0;
  if (storeKeys.length && instLine && rcNew) {
    let lastStore = -1;
    for (let i = 0; i < instLine.length; i++) if (instLine[i] != null) lastStore = i;
    if (lastStore >= 0) {
      for (let i = lastStore + 1; i < instLine.length; i++) {
        if (rcNew[i] != null) { instLine[i] = rcNew[i]; instTail += rcNew[i]; }
      }
    }
  }
  const instTotal = inst ? sumOf(T, inst.keys) + instTail : null;
  kpis.push({
    id: 'installs', label: 'Installs', format: 'int', value: instTotal, prev: inst ? sumOf(P, inst.keys) : null,
    delta: inst ? change(instTotal, sumOf(P, inst.keys), inst.keys.every(enough)) : null,
    sub: [], source: inst?.source || null,
    rule: instTail > 0
      ? 'Official first-time downloads from the store, plus real-time installs from RevenueCat (testers excluded) for the recent day or two the store has not posted yet.'
      : 'First-time downloads as the stores count them. Until a store count arrives: new customers in RevenueCat, then new players in PostHog.',
    spark: clip(instLine), empty: inst ? null : why(['apple', 'posthog', 'revenuecat']),
  });

  // ---- Who played each day. New: RevenueCat's customers (every install makes one), else PostHog's first sightings.
  // Active: the larger of PostHog's players and RevenueCat's customers last seen that day; where RevenueCat's own
  // count is all there is for a day (before this pull began), that, which is counted in UTC days.
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

  // ---- DAU: the average over whole live days (today is still being counted, pre-launch days left out) ----
  const liveActive = clip(activeLine);
  const whole = liveActive ? liveActive.slice(0, -1).filter((v) => v != null) : [];
  const dau = liveActive ? (whole.length ? mean(whole) : liveActive.at(-1)) : null;
  // The period before is only ever one of the tester-free counts. RevenueCat's own chart counts testers, so when it
  // is all there is for the period before, there is no change to show.
  const prevDau = [P('posthog.dau'), P('revenuecat.active_customers')].filter(Boolean).sort((x, y) => y.avg - x.avg)[0] || null;
  kpis.push({
    id: 'dau', label: 'DAU', format: 'num', value: dau, prev: prevDau?.avg ?? null,
    delta: dau != null && prevDau ? change(dau, prevDau.avg, prevLive && prevDau.n >= Math.ceil(n / 2)) : null,
    sub: phDau && T('posthog.wau') ? [{ label: 'WAU', value: T('posthog.wau').last, format: 'int' }] : [],
    source: activeSource ? `Active players · ${activeSource}` : null,
    rule: 'The average over whole days of each day\'s active players: the larger of PostHog\'s count and RevenueCat\'s customers seen that day. Today is left out until it ends.',
    spark: liveActive, empty: activeLine ? null : why(['posthog', 'revenuecat']),
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
    source: 'PostHog', rule: 'Of the players who first played N days before each day in the range, the share who played again on day N.', spark: null, empty: d1 || d7 ? null : why(['posthog']),
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
      source: 'PostHog', rule: STABILITY_RULE, spark: null, empty: null,
    });
  } else {
    kpis.push({
      id: 'stability', label: crash ? 'Crash rate' : 'Unclean exit / crash rate', format: 'pct', value: crash?.rate ?? null, upGood: false,
      delta: crash && crashPrev ? change(crash.rate, crashPrev.rate, true, { pp: true, upGood: false }) : null,
      sub: [], source: crash?.source || null, rule: STABILITY_RULE, spark: null, empty: crash ? null : why(['posthog', platform === 'android' ? 'google' : 'apple']),
    });
  }

  // ---- Conversion: of the players whose seventh day fell inside the range, the share who bought within their 7 days ----
  // Counted like retention, from whole cohorts: a player who has not had 7 days yet may still buy, so counting them
  // as not paying would read low. The sync leaves them out of each install day until they are 7 days old.
  const rcCohorts = new Map(raw.cohorts_rc || []);
  const paid7 = (shift = 0) => {
    let paying = 0, size = 0;
    for (let d = addDays(from, -7 - shift), end = addDays(to, -7 - shift); d <= end; d = addDays(d, 1)) {
      const c = rcCohorts.get(d);
      if (c?.conv_cohort_size > 0) { size += c.conv_cohort_size; paying += c.new_paying_customers || 0; }
    }
    return size ? { rate: paying / size, paying, size, young: false } : null;
  };
  // A game too new to have anyone 7 days old: everyone who has bought over everyone who has played, until it does.
  const rcLive = raw.facts?.['revenuecat.live']?.value?.[platform] || null;
  const young = rcLive?.matured === 0 && rcLive.customers > 0 ? { rate: (rcLive.unique_payers || 0) / rcLive.customers, paying: rcLive.unique_payers || 0, size: rcLive.customers, young: true } : null;
  const conv = paid7() || young, convPrev = paid7(n);
  kpis.push({
    id: 'conversion', label: 'Conversion rate', format: 'pct', value: conv?.rate ?? null,
    delta: conv && !conv.young && convPrev ? change(conv.rate, convPrev.rate, prevLive, { pp: true }) : null,
    sub: conv ? [{ label: 'paying', value: conv.paying, format: 'int' }, { label: conv.young ? 'players so far' : 'players at day 7', value: conv.size, format: 'int' }] : [],
    source: 'RevenueCat',
    rule: conv?.young
      ? 'No player has had 7 days yet, so this is everyone who has bought over everyone who has played, all time. Once players are 7 days old it becomes the share who buy within their first 7 days.'
      : 'Of the players whose seventh day fell in the range, the share who bought within their first 7 days. A player who has not had 7 days yet is left out: they may still buy.',
    spark: null, empty: conv ? null : why(['revenuecat'], 'No players 7 days old in this range'),
  });

  // ---- Charts ----
  const charts = {};
  const revLine = line('revenuecat.revenue');
  charts.revenue = revLine
    ? { dates: chartDays, revenue: clip(revLine), transactions: clip(line('revenuecat.transactions')) || chartDays.map(() => null), quiet: rev.sum > 0 ? null : 'No sales in this range' }
    : { empty: why(['revenuecat']) };

  // What the stores have not posted yet reads as that, not as zero.
  const storeLine = storeKeys.length ? sumLines(storeKeys.map((k) => line(k[0]))) : null;
  const storeLabel = storeKeys.length ? `First downloads · ${storeKeys.map((k) => k[1]).join(' + ')}` : null;
  const byDay = [
    storeLine && { id: 'downloads', label: storeLabel, short: 'Downloads', values: clip(storeLine), late: true },
    newLine && { id: 'new', label: 'New', values: clip(newLine) },
    activeLine && { id: 'active', label: 'Active', values: clip(activeLine) },
    backLine && backLine.some((v) => v != null) && { id: 'returning', label: 'Returning', values: clip(backLine) },
  ].filter(Boolean);
  charts.players = byDay.length ? {
    dates: chartDays, series: byDay,
    sources: [storeLine && storeLabel, newSource && `New · ${newSource}`, activeSource && `Active · ${activeSource}`].filter(Boolean),
    notes: [
      !storeLine && state === 'live' && platform !== 'android' && syncBy.apple && syncBy.apple.state !== 'ok' ? 'App Store first downloads are not connected yet: New is every first launch RevenueCat saw.' : null,
      utcUntil && (!liveSince || utcUntil >= liveSince) ? `Active up to ${utcUntil} is RevenueCat's own count, which uses UTC days.` : null,
    ].filter(Boolean),
  } : { empty: why(['revenuecat', 'posthog']) };

  // ---- Downloads since launch ----
  const lifeKeys = storeKeys.length ? storeKeys.map((k) => k[0]) : raw.life?.['revenuecat.new_customers'] ? ['revenuecat.new_customers'] : raw.life?.['posthog.new_users'] ? ['posthog.new_users'] : [];
  const lifeMaps = lifeKeys.map((k) => new Map(raw.life?.[k] || []));
  const rcLifeMap = new Map(raw.life?.['revenuecat.new_customers'] || []);
  const livePlatforms = (platform === 'all' ? ['ios', 'android'] : [platform]).filter((p) => game.platforms[p].status === 'live');
  const launched = livePlatforms.map((p) => game.platforms[p].launched).filter(Boolean).sort()[0] || null;
  const firstLife = lifeMaps.flatMap((m) => [...m.keys()]).sort()[0] || null;
  const lifeFact = raw.facts?.['revenuecat.live']?.value?.[platform] || null;
  let downloads = null;
  if (lifeKeys.length && firstLife) {
    const start = launched && launched <= to ? launched : firstLife, ds = dates(start, to);
    let run = 0, lastKnown = -1, officialTotal = 0, lastOfficial = -1, tailTotal = 0;
    const daily = ds.map((d, i) => {
      const vs = lifeMaps.map((m) => m.get(d)).filter((v) => v != null);
      if (!vs.length) return null;
      const sum = vs.reduce((a, v) => a + v, 0);
      lastKnown = i; lastOfficial = i; officialTotal += sum;
      return sum;
    });
    // When using official store downloads, add real-time RevenueCat installs (testers excluded) ONLY for unposted days
    // strictly after the store's last posted day. Earlier days stay strictly on the official store count.
    if (storeKeys.length && lastOfficial >= 0 && rcLifeMap.size) {
      for (let i = lastOfficial + 1; i < ds.length; i++) {
        if (rcLifeMap.has(ds[i])) {
          const v = rcLifeMap.get(ds[i]);
          daily[i] = v; lastKnown = i; tailTotal += v;
        }
      }
    }
    const cumulative = daily.map((v, i) => { run += v || 0; return i <= lastKnown ? run : null; });
    const fromRc = lifeKeys[0] === 'revenuecat.new_customers';
    const total = fromRc && lifeFact?.customers != null ? Math.max(run, lifeFact.customers) : run;
    const storeName = storeKeys.map((k) => k[1]).join(' + ');
    downloads = {
      dates: ds, daily, cumulative, total, official_total: storeKeys.length ? officialTotal : null, realtime_tail: storeKeys.length ? tailTotal : 0,
      launched: start, days_live: ds.length,
      today: daily.at(-1), yesterday: ds.length > 1 ? daily.at(-2) : null,
      marks: [1, 7, 14, 30, 60, 90].filter((N) => N <= ds.length && cumulative[N - 1] != null).map((N) => ({ day: N, date: ds[N - 1], value: cumulative[N - 1] })),
      source: storeKeys.length ? storeName : fromRc ? 'New players · RevenueCat' : 'New players · PostHog',
      note: storeKeys.length
        ? (tailTotal > 0 ? `Official ${storeName} count through ${ds[lastOfficial]} (${Math.round(officialTotal).toLocaleString('en-US')}) plus ${Math.round(tailTotal).toLocaleString('en-US')} real-time installs since then from RevenueCat (testers excluded).` : null)
        : 'Until the store’s own count is connected, a download is a first launch.',
    };
  }
  charts.downloads = downloads || { empty: why(['apple', 'revenuecat', 'posthog']) };

  // ---- Where the listing comes up in search ----
  const search = platform !== 'android' ? raw.facts?.['listing.search']?.value : null;
  const checkedDay = search?.checked_at ? dayIn(Date.parse(search.checked_at), zone) : to;
  const ranked = (search?.terms || []).map((t) => {
    const full = line(`listing.${t.key}`);
    const values = clip(full) || chartDays.map(() => null);
    let prev = null, prevDate = null;
    if (full) {
      for (let i = days.length - 1; i >= 0; i--) {
        if (days[i] < checkedDay && full[i] != null) { prev = full[i]; prevDate = days[i]; break; }
      }
    }
    const nowRank = t.rank ?? null;
    const move = nowRank != null && prev != null ? prev - nowRank : null;
    const seenRanks = [...values.filter((v) => v != null), ...(nowRank != null ? [nowRank] : [])];
    return {
      term: t.term,
      now: nowRank,
      prev,
      prev_date: prevDate,
      move,
      best: seenRanks.length ? Math.min(...seenRanks) : null,
      worst: seenRanks.length ? Math.max(...seenRanks) : null,
      values,
    };
  });
  charts.ranks = ranked.length
    ? { dates: chartDays, series: ranked, store: search.store, storefront: String(search.storefront || '').toUpperCase(), depth: search.depth, checked_at: search.checked_at }
    : { empty: why(['listing'], 'No search terms set') };

  const curve = RETENTION_DAYS.map((N) => ({ day: N, ...(kept(N) || {}) })).filter((p) => p.rate != null);
  // Until PostHog has cohorts of its own, the curve is the hand-read one, when there is one.
  // Facts read by hand belong to one platform (the GameAnalytics read and Apple's peers are iOS unless they say otherwise):
  // the combined view takes them, the other platform's view never does.
  const ownFact = (k) => { const v = raw.facts?.[k]?.value || null; return v && (platform === 'all' || (v.platform || 'ios') === platform) ? v : null; };
  const byHand = ownFact('manual.gameanalytics'), handOn = byHand?.read_at ? `${byHand.source || 'GameAnalytics'}, read ${byHand.read_at}` : null;
  const handCurve = Object.entries(byHand?.retention || {}).map(([k, v]) => ({ day: Number(String(k).replace(/^d/, '')), ...v })).filter((p) => p.day > 0 && p.size > 0).map((p) => ({ day: p.day, rate: p.back / p.size, back: p.back, size: p.size })).sort((x, y) => x.day - y.day);
  charts.retention = curve.length ? { points: [{ day: 0, rate: 1, back: curve[0].size, size: curve[0].size }, ...curve], source: 'PostHog' }
    : handCurve.length ? { points: [{ day: 0, rate: 1, back: handCurve[0].size, size: handCurve[0].size }, ...handCurve], source: handOn }
      : { empty: why(['posthog']) };

  const byPrefix = (prefix) => Object.entries(totals).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k.slice(prefix.length), value: v.sum }));
  const words = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  const ftue = byPrefix('posthog.ftue:').filter((s) => /^\d/.test(s.key)).sort((a, b) => (a.key < b.key ? -1 : 1));
  const stepsOf = (list) => list.map((s) => ({ key: s.key, label: words(s.key.replace(/^\d+[a-z]?_/, '')), users: s.value, share: list[0].value > 0 ? s.value / list[0].value : null }));
  const handSteps = (byHand?.ftue || []).filter((s) => /^\d/.test(s.key || '') && s.players != null).map((s) => ({ key: s.key, value: s.players })).sort((x, y) => (x.key < y.key ? -1 : 1));
  charts.ftue = ftue.some((s) => s.value > 0) ? { steps: stepsOf(ftue), source: 'PostHog' }
    : handSteps.some((s) => s.value > 0) ? { steps: stepsOf(handSteps), source: handOn }
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

  // Graphics level: each player once, at the level they last settled on in the range (the posthog.gfx fact). The
  // daily rows count a player again every day they play, so without the fact they are shown as player-days.
  const gfxOnce = raw.facts?.['posthog.gfx']?.value?.ranges?.[range]?.[platform] || null;
  const gfx = (gfxOnce ? Object.entries(gfxOnce).map(([key, value]) => ({ key, value: +value || 0 })) : byPrefix('posthog.gfx_level:')).filter((s) => s.value > 0).sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
  const gfxAll = gfx.reduce((a, s) => a + s.value, 0);
  extras.gfx = gfxAll > 0 ? { unit: gfxOnce ? 'players' : 'player-days', levels: gfx.map((s) => ({ level: s.key, players: s.value, share: s.value / gfxAll })) } : null;

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
  const lastStep = Math.max(0, ...(charts.ftue.steps || []).map((x) => parseInt(x.key, 10) || 0));
  extras.stories = tales.length ? { as_of: told.as_of, since: told.since, limit: told.limit, ftue_steps: lastStep || null, players: tales } : null;

  // ---- Today so far, and the last 24 hours ----
  const rc = state === 'live' ? fact('revenuecat.live') : null, ph = state === 'live' ? fact('posthog.live') : null;
  const rcNow = rc?.[platform]?.today?.date === to ? rc[platform] : null, phNow = ph?.[platform]?.today?.date === to && ph[platform].players > 0 ? ph[platform] : null;
  let today = null;
  if (rcNow || phNow) {
    // New is RevenueCat's (it sees every install); Active and Returning come from whichever saw more players.
    const lead = phNow && (!rcNow || phNow.today.active > rcNow.today.active) ? phNow : rcNow;
    const pick = (span) => ({ new: (rcNow || phNow)[span].new, active: lead[span].active, returning: lead[span].returning });
    const day24 = { ...pick('last24h'), purchases: Math.max(rcNow?.last24h.purchases ?? 0, phNow?.last24h.purchases ?? 0), revenue: rcNow?.last24h.revenue ?? null };
    const now0 = pick('today');
    const where = (rcNow?.countries || []).filter((c) => c.cc && c.cc !== '??');
    const builds = (rcNow?.versions || []).filter((v) => v.version && v.version !== '??');
    const counts = listing ? line('listing.rating_count') : null, before = counts ? counts.slice(0, -1).filter((v) => v != null).at(-1) : null;
    today = {
      date: to, as_of: (lead === phNow ? ph : rc).as_of, day_started: (rc || ph).day_started,
      now: now0, last24h: day24, source: [rcNow && 'RevenueCat', phNow && 'PostHog'].filter(Boolean).join(' + '),
      all_time: downloads ? { value: downloads.total, source: downloads.source } : null,
      countries: where.map((c) => ({ cc: c.cc, active: c.active, new: c.new || 0 })),
      versions: builds.map((v) => ({ version: v.version, active: v.active })),
      store: listing ? { name: listing.store, version: listing.version, pending: (listing.pending || []).map((p) => ({ version: p.version, label: p.label, release: p.release || null })) } : null,
      rating: listing ? { value: listing.rating, count: listing.rating_count, reviews: listing.reviews_total ?? null, change: before != null ? listing.rating_count - before : null } : null,
      testers_out: rc?.testers?.total || 0,
    };
  }

  // ---- Against the average: a game's own numbers beside the average for a launch like it, each with how it is worked out and where the average comes from ----
  // Numbers read by hand from a tool with no sync of its own (GameAnalytics today) are kept as a fact and fill what the synced sources cannot.
  const manual = byHand;
  const readOn = manual?.read_at ? `${manual.source || 'GameAnalytics'}, read ${manual.read_at}` : null;
  let benchmarks = null;
  if (state === 'live' && Object.keys(totals).length) {
    const genre = game.genre || 'games';
    const sums = (k) => T(k)?.sum ?? null, rate = (a, b) => (a != null && b > 0 ? a / b : null);
    const int = (v) => Math.round(v).toLocaleString('en-US'), span = `last ${n} days`;
    const none = { ratio: null, short: null, verdict: null, tone: null };
    // Beside an average, with the usual range when the source gives one; beside a range alone; or beside percentiles.
    const beside = (v, b) => {
      if (v == null) return none;
      const { mid = null, low = null, high = null } = b;
      if (mid == null) return { ratio: null, short: v < low ? 'Below range' : v > high ? 'Above range' : 'In range', verdict: v < low ? 'Under the usual range' : v > high ? 'Above the usual range' : 'Inside the usual range', tone: v < low ? 'bad' : v > high ? 'good' : 'flat' };
      const r = mid > 0 ? v / mid : null; if (r == null) return none;
      const times = r >= 1.15 ? `${r >= 10 ? Math.round(r) : r.toFixed(1)}× the average` : r > 0.87 ? 'About average' : `${Math.round(r * 100)}% of the average`;
      const tail = low != null && v < low ? ', under the usual range' : high != null && v > high ? ', above the usual range' : '';
      return { ratio: r, short: r >= 1.15 ? `${r >= 10 ? Math.round(r) : r.toFixed(1)}×` : r > 0.87 ? 'Typical' : `${Math.round(r * 100)}%`, verdict: times + tail, tone: r >= 1.15 ? 'good' : (low != null ? v < low : r <= 0.87) ? 'bad' : 'flat' };
    };
    const placed = (v, q) => (v == null ? none : { ratio: v / q.p50, short: v < q.p25 ? 'Bottom 25%' : v < q.p50 ? '25th–50th' : v < q.p75 ? '50th–75th' : 'Top 25%', verdict: v < q.p25 ? 'Below the 25th percentile' : v < q.p50 ? 'Between the 25th and 50th percentile' : v < q.p75 ? 'Between the 50th and 75th percentile' : 'Above the 75th percentile', tone: v < q.p25 ? 'bad' : v < q.p50 ? 'flat' : 'good' });
    const rows = [];
    // Apple's peer percentiles are read from its console by hand and kept as a fact: { week, group, <row id>: { p25, p50, p75 } }.
    const peers = ownFact('manual.apple_peers');
    // An average published for one platform (an ios or android block in the config) replaces the shared one on that platform's view.
    const forP = (b) => (b?.[platform] ? { ...b, ...b[platform] } : b);
    const add = (group, id, b0, o) => {
      const b = forP(b0);
      const q = peers?.[id]?.p50 != null ? peers[id] : null, value = o.value ?? null;
      const scale = q ? { average: q.p50, low: q.p25, high: q.p75, top: null, percentiles: true } : { average: b.mid ?? null, low: b.low ?? null, high: b.high ?? null, top: b.top ?? null, percentiles: false };
      rows.push({
        id, group, label: b.label, what: o.what || b.what, format: o.format || 'pct', value, how: value != null ? o.how : null, ...scale,
        peer_group: q ? peers.group || null : null, ...(q ? placed(value, q) : beside(value, b)),
        where: q ? `${b.peers_where}${peers.week ? ` Read from App Store Connect for ${peers.week}.` : ''}` : b.where, source: q ? b.peers_source : b.source, url: q ? b.peers_url : b.url, need: value == null ? o.need || 'No figure yet' : null, note: (value != null && o.note) || null,
      });
    };
    const needApple = 'Needs App Store Connect analytics';

    if (platform !== 'android') {
      // Total downloads: actual real downloads in the first 30 days (never extrapolated to a fictional pace).
      if (downloads) {
        const total = (xs) => xs.reduce((x, v) => x + v, 0), month = downloads.daily.slice(0, 30).filter((v) => v != null);
        const pastMonth = downloads.days_live > 30;
        const actual = pastMonth ? total(month) : downloads.total;
        add('Getting found', 'downloads_month', bench.downloads_month, {
          format: 'int', value: actual,
          how: pastMonth
            ? `${int(actual)} in the first 30 days · ${downloads.source}`
            : `${int(actual)} in the first ${downloads.days_live} ${downloads.days_live === 1 ? 'day' : 'days'} · ${downloads.source}`,
          note: downloads.note || null,
        });
      }
      // Downloads beside page views come from the same analytics reports, so both cover the same days; the sales count stands in without them.
      // Use Apple's Unique Counts (unique devices per day) when present so repeated views by the same shopper do not deflate conversion rates.
      const first = sums('apple.an_downloads') ?? sums('apple.downloads'), again = sums('apple.an_downloads') != null ? sums('apple.an_redownloads') || 0 : null;
      const direct = sums('apple.an_downloads') != null ? sums('apple.an_downloads_direct') || 0 : null;
      const shownU = sums('apple.impressions_unique'), shown = shownU ?? sums('apple.impressions');
      const openedU = sums('apple.page_views_unique'), opened = openedU ?? sums('apple.page_views');
      add('Getting found', 'store_conversion', bench.store_conversion, {
        value: again != null ? rate(first + again, shown) : null, need: needApple,
        how: `${int((first || 0) + (again || 0))} downloads and redownloads ÷ ${int(shown || 0)} ${shownU != null ? 'unique impressions (daily)' : 'impressions'}, ${span}`,
        note: shownU == null && shown != null ? 'Using total impressions until the next App Store sync fills unique counts.' : null,
      });
      // Page to download: all first downloads ÷ unique product page views — matches AppTweak's published benchmark
      // definition (which does not subtract direct Get taps in search results). Direct taps and the page-only rate
      // are noted in the info popover.
      const fromPage = first != null && direct != null ? Math.max(0, first - direct) : null;
      const pageOnly = direct > 0 && opened > 0 ? Math.round((fromPage / opened) * 100) : null;
      add('Getting found', 'page_to_download', bench.page_to_download, {
        value: rate(first, opened), need: needApple,
        how: `${int(first || 0)} first downloads ÷ ${int(opened || 0)} ${openedU != null ? 'unique page views (daily)' : 'page views'}, ${span}`,
        note: [
          direct > 0 ? `${int(direct)} of the ${int(first)} tapped Get in search results without opening the page${pageOnly != null ? ` (page-only: ${pageOnly}%)` : ''}.` : null,
          openedU == null && opened != null ? 'Using total page views until the next App Store sync fills unique counts.' : null,
        ].filter(Boolean).join(' ') || null,
      });
      // Match units on search clicks: unique over unique when both exist, else total over total.
      const sViewsU = sums('apple.page_views_search_unique'), sShownU = sums('apple.impressions_search_unique');
      const useSearchU = sViewsU != null && sShownU != null;
      const searchViews = useSearchU ? sViewsU : sums('apple.page_views_search'), searchShown = useSearchU ? sShownU : sums('apple.impressions_search');
      add('Getting found', 'search_clicks', bench.search_clicks, {
        value: rate(searchViews, searchShown), need: sums('apple.impressions') != null ? 'Comes with the next App Store sync' : needApple,
        how: `${int(searchViews || 0)} ${useSearchU ? 'unique page views' : 'page views'} from search ÷ ${int(searchShown || 0)} ${useSearchU ? 'unique impressions' : 'impressions'} in search, ${span}`,
      });
    }

    // Returning players: day N retention from cohorts (PostHog's, else the hand-read ones). Nothing stands in for
    // them: the share of a day's players who had played before is a different, far higher number.
    const R = bench.retention, thin = (size) => (size < 100 ? 'Fewer than 100 players: read it loosely.' : null);
    for (const N of [1, 7, 30]) {
      const k = kept(N), m = manual?.retention?.[`d${N}`], b = { what: R.what, where: R.where, source: R.source, url: R.url, ...forP(R[`d${N}`]) };
      if (k) add('Playing', `d${N}`, b, { value: k.rate, how: `${int(k.back)} of ${int(k.size)} new players came back on day ${N} · PostHog`, note: thin(k.size) });
      else if (m?.size > 0) add('Playing', `d${N}`, b, { value: m.back / m.size, how: `${int(m.back)} of ${int(m.size)} new players came back on day ${N}${m.cohorts ? `, ${m.cohorts}` : ''} · ${readOn}`, note: [thin(m.size), manual.retention.note].filter(Boolean).join(' ') || null });
      else add('Playing', `d${N}`, b, { need: manual ? `No players ${N} days old yet` : syncBy.posthog?.state === 'ok' ? `No players ${N} ${N === 1 ? 'day' : 'days'} old yet` : 'Needs PostHog' });
    }
    const S = manual?.session;
    if (S?.secs > 0) add('Playing', 'session_length', bench.session_length, { format: 'mins', value: S.secs, how: `${int(S.sessions)} sessions · ${readOn}`, note: S.note || null });
    else { const secs = rate(sums('apple.session_seconds'), sums('apple.sessions')); add('Playing', 'session_length', bench.session_length, { format: 'mins', value: secs, how: `${int(sums('apple.sessions') || 0)} sessions from players who share usage with Apple, ${span}`, need: 'Needs session lengths' }); }
    if (S?.per_player_day_secs > 0) add('Playing', 'playtime', bench.playtime, { format: 'mins', value: S.per_player_day_secs, how: `${int(S.player_days)} days of play, ${(S.sessions / S.player_days).toFixed(1)} sessions each · ${readOn}`, note: S.note || null });

    // Paying.
    add('Paying', 'paying_players', bench.paying_players, conv?.young
      ? { value: conv.rate, how: `${int(conv.paying)} of ${int(conv.size)} players, all time · RevenueCat`, note: 'No player has had 7 days yet, so every player counts. Once some have, only they do.' }
      : conv ? { value: conv.rate, how: `${int(conv.paying)} of the ${int(conv.size)} players whose seventh day fell in the ${span} bought within their 7 days · RevenueCat`, note: 'A player who has not had 7 days yet is left out: they may still buy.' }
        : { need: rcLive || rcCohorts.size ? 'No players 7 days old in this range' : 'Needs RevenueCat' });
    // Proceeds per paying player: all the range's proceeds over everyone who bought in it, each counted once,
    // whenever they first played and however often they bought.
    const proceeds = sums('revenuecat.proceeds'), payers = rcLive?.payers_by_range?.[range] ?? null;
    if (peers?.proceeds_per_payer) add('Paying', 'proceeds_per_payer', bench.proceeds_per_payer, {
      format: 'usd', value: payers > 0 && proceeds != null ? proceeds / payers : null,
      how: `$${(proceeds || 0).toFixed(2)} ÷ ${int(payers || 0)} ${payers === 1 ? 'player' : 'different players'} who bought, ${span} · RevenueCat`,
      note: 'Every player who bought in the range counts once, however often they bought and whenever they first played.',
      need: payers === 0 && !(proceeds > 0) ? 'No paying players in this range' : proceeds != null ? 'Comes with the next RevenueCat sync' : 'Needs RevenueCat',
    });
    const lifeRev = raw.life?.['revenuecat.revenue'], start = downloads?.launched;
    if (lifeRev && start) {
      const end = addDays(start, 29), month = lifeRev.filter(([d]) => d >= start && d <= end), age = Math.min(30, dates(start, to).length);
      add('Paying', 'revenue_month', bench.revenue_month, { format: 'usd', value: month.length ? month.reduce((x, [, v]) => x + (v || 0), 0) : null, how: `In the first ${age} ${age === 1 ? 'day' : 'days'} · RevenueCat`, need: 'The first month is not on record' });
    }
    benchmarks = { genre, groups: ['Getting found', 'Playing', 'Paying'].filter((g) => rows.some((r) => r.group === g)), rows };
  }
  extras.benchmarks = benchmarks;

  // ---- Projected: clearly labeled run-rate estimates, separate from actuals ----
  let projected = null;
  if (state === 'live' && (downloads || rev)) {
    const tiles = [];
    let dlBasis = null, revBasis = null;
    if (downloads) {
      // Average whole completed days (omit today in progress when earlier days exist) so a partial day never drags down pace.
      const completed = downloads.daily.length > 1 ? downloads.daily.slice(0, -1).filter((v) => v != null) : downloads.daily.filter((v) => v != null);
      if (completed.length) {
        const pace = completed.reduce((a, v) => a + v, 0) / completed.length;
        const recent = completed.length >= 7 ? completed.slice(-7) : null;
        const pace7 = recent ? recent.reduce((a, v) => a + v, 0) / recent.length : null;
        const forward = pace7 ?? pace;
        dlBasis = `${pace.toFixed(1)}/day over ${completed.length} completed ${completed.length === 1 ? 'day' : 'days'}${pace7 != null ? ` (last 7d: ${pace7.toFixed(1)}/day)` : ''} · ${downloads.source}`;
        tiles.push({ id: 'dl_pace', label: 'Daily pace', value: pace, format: 'num', sub: pace7 != null ? `7d · ${pace7.toFixed(1)}/day` : 'downloads/day' });
        if (downloads.days_live < 30) {
          const left = 30 - downloads.days_live;
          tiles.push({ id: 'dl_30d', label: 'First 30 days', value: Math.round(downloads.total + pace * left), format: 'int', sub: `projected · ${left}d left` });
        } else {
          tiles.push({ id: 'dl_30d', label: 'Next 30 days', value: Math.round(forward * 30), format: 'int', sub: 'projected' });
        }
        if (downloads.days_live < 90) {
          tiles.push({ id: 'dl_90d', label: '90-day total', value: Math.round(downloads.total + pace * (90 - downloads.days_live)), format: 'int', sub: 'projected' });
        } else {
          tiles.push({ id: 'dl_90d', label: 'Next 90 days', value: Math.round(forward * 90), format: 'int', sub: 'projected' });
        }
        tiles.push({
          id: 'dl_365d',
          label: downloads.days_live < 365 ? 'First year total' : 'Next 12 months',
          value: Math.round(downloads.days_live < 365 ? downloads.total + pace * (365 - downloads.days_live) : forward * 365),
          format: 'int', sub: 'projected',
        });
      }
    }
    if (revLine) {
      const completedRev = revLine.length > 1 ? revLine.slice(0, -1).filter((v) => v != null) : revLine.filter((v) => v != null);
      if (completedRev.length) {
        const revPace = completedRev.reduce((a, v) => a + v, 0) / completedRev.length;
        revBasis = `$${revPace.toFixed(2)}/day over ${completedRev.length} completed ${completedRev.length === 1 ? 'day' : 'days'} in the ${n}D range · RevenueCat`;
        tiles.push({ id: 'rev_30d', label: '30-day revenue', value: revPace * 30, format: 'usd', sub: 'projected' });
        tiles.push({ id: 'rev_365d', label: '12-month revenue', value: revPace * 365, format: 'usd', sub: 'projected' });
      }
    }
    if (tiles.length) projected = { tiles, dl_basis: dlBasis, rev_basis: revBasis };
  }
  extras.projected = projected;

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
  const fullDays = dates(raw.from, raw.to);
  const earliest = views.map((v) => v.charts.revenue?.dates?.[0] || v.charts.players?.dates?.[0]).filter(Boolean).sort()[0];
  const days = earliest && earliest > raw.from && earliest <= raw.to ? dates(earliest, raw.to) : fullDays;
  const align = (seriesDates, values) => {
    if (!seriesDates || !values) return null;
    const byDate = new Map(seriesDates.map((d, i) => [d, values[i]]));
    return days.map((d) => (byDate.has(d) ? byDate.get(d) : null));
  };
  const total = (id, format, label, source) => {
    const ks = views.map((v) => ({ k: v.kpis.find((k) => k.id === id), ds: v.charts.revenue?.dates || v.charts.players?.dates })).filter((x) => x.k.value != null);
    if (!ks.length) return { id, label, format, value: null, delta: null, sub: [], source: null, spark: null, empty: { kind: 'none', badge: 'No live data yet', text: '' } };
    const value = ks.reduce((a, { k }) => a + k.value, 0), withPrev = ks.filter(({ k }) => k.prev != null && k.delta);
    const aligned = ks.map(({ k, ds }) => (k.spark && ds && k.spark.length === ds.length ? align(ds, k.spark) : k.spark));
    const spark = days.map((_, i) => { const vs = aligned.map((s) => s?.[i]).filter((v) => v != null); return vs.length ? vs.reduce((a, v) => a + v, 0) : null; });
    return {
      id, label, format, value, sub: [], source, spark, empty: null,
      delta: withPrev.length === ks.length ? change(value, withPrev.reduce((a, { k }) => a + k.prev, 0)) : null,
    };
  };
  const live = views.filter((v) => v.game.status === 'live').length;
  const withRevenue = views.filter((v) => v.charts.revenue.revenue);
  return {
    range, from: raw.from, to: raw.to, days: fullDays.length, clock: { zone: ZONE, name: zoneName(ZONE, now) },
    totals: [
      total('revenue', 'usd', 'Revenue', 'All games · RevenueCat'),
      total('installs', 'int', 'Installs', 'All games'),
      total('dau', 'num', 'DAU', 'All games, added together'),
      { id: 'live', label: 'Games live', format: 'int', value: live, of: views.length, delta: null, sub: [], source: null, spark: null, empty: null },
    ],
    revenue_by_game: withRevenue.length
      ? { dates: days, series: withRevenue.map((v) => ({ slug: v.game.slug, label: v.game.name, values: align(v.charts.revenue.dates, v.charts.revenue.revenue) })), quiet: withRevenue.some((v) => v.kpis[0].value > 0) ? null : 'No sales in this range' }
      : { empty: { kind: 'none', badge: 'No live data yet', text: '' } },
    games: views.map((v) => ({ game: v.game, state: v.state, state_label: v.state_label, has_data: v.has_data, kpis: v.kpis.map((k) => ({ ...k, spark: k.id === 'revenue' ? k.spark : null })), sync: v.sync })),
    nav: views.map((v) => v.game), sources: SOURCES, generated_at: new Date(now).toISOString(),
  };
}
