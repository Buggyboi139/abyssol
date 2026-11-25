// RevenueCat API v2: players and sales, counted here from the customer list
// and each customer's purchases rather than from RevenueCat's charts, because
// the charts count UTC days, count testers, and count the owner's own test
// purchases. Counted here:
//   - a day is a day in the reporting time zone (config/games.json, "timezone")
//   - a tester is left out: a customer on a platform that is not live, first
//     seen before the platform's launch day, last seen on a build that is not
//     a release or is newer than the one on sale, with a sandbox purchase, or
//     named in <PREFIX>_REVENUECAT_EXCLUDE (customer or purchase ids, comma separated)
//   - sales are production purchases by the customers left
// Daily: new_customers (exact), active_customers and returning_customers (who
// was last seen that day, kept at its highest: exact for today), revenue,
// transactions, proceeds, both by product, and active_customers_chart
// (RevenueCat's own UTC count, for the days before this pull began).
// Conversion, by install day: conv_cohort_size is the day's new customers who
// have had their 7 days, new_paying_customers those of them who bought within
// the 7. A customer is counted only once 7 days old, so a day reads zero until
// then and never changes after day 8; every run rewrites the last CONV_BACK
// install days, however short its window.
// Hourly: new customers and sales. Fact revenuecat.live: today and the last 24
// hours, by country and version, and how many different customers bought in
// each of the dashboard's ranges (payers_by_range) and ever (unique_payers).
// Needs a v2 secret key that can read customers, purchases, products, and
// charts: <PREFIX>_REVENUECAT_API_KEY. One-time purchases only: a game that
// sells subscriptions needs /subscriptions read too.
import { Rows, getJson, ymd, addDays, dateRange, sleep, keyPart, DAY, RANGES } from '../lib/util.mjs';
import { ownEnv } from '../lib/env.mjs';
import { dayIn, dayStart } from '../../server/zone.js';
import { onSale, versionParts, versionNewer } from './listing.mjs';

export const source = 'revenuecat';
const ORIGIN = 'https://api.revenuecat.com', API = `${ORIGIN}/v2`, HOUR = 3600000;
const platformOf = (s) => (/^(ios|iphone|ipad|mac)/i.test(s || '') ? 'ios' : /^android/i.test(s || '') ? 'android' : null);
const STORE_PLATFORM = { app_store: 'ios', mac_app_store: 'ios', play_store: 'android' };
// A purchase on day 4 to 7 changes an install day up to 7 days back, so the conversion rows reach back at least 8
// days whatever the run's window; 14 also rides out a week of missed runs.
const CONV_BACK = 14, MATURE = 7 * DAY;
// Purchases are read as far back as the longest range, so each range's count of paying customers is whole.
const PAYERS_BACK = Math.max(...Object.values(RANGES));

export async function run(ctx) {
  const { game, env, fetchImpl, days, platforms, today, now, zone = 'UTC' } = ctx;
  const key = ownEnv(env, game, 'REVENUECAT_API_KEY');
  if (!key) return { status: 'skipped', message: `Not connected: set ${game.env_prefix}_REVENUECAT_API_KEY` };
  const headers = { authorization: `Bearer ${key}` };
  const get = (path) => getJson(fetchImpl, path.startsWith('http') ? path : path.startsWith('/v2') ? ORIGIN + path : API + path, { headers });
  const pages = async (path, max = 5000) => {
    const out = []; let next = path;
    for (let i = 0; next && i < max; i++) { const j = await get(next); out.push(...(j.items || [])); next = j.next_page || null; }
    return out;
  };
  const notes = [];

  let project = ownEnv(env, game, 'REVENUECAT_PROJECT_ID');
  if (!project) {
    project = (await get('/projects')).items?.[0]?.id;
    if (!project) return { status: 'error', message: 'The key sees no RevenueCat project' };
  }
  const base = `/projects/${project}`;
  const from = addDays(today, -days), dates = dateRange(from, today), inWindow = new Set(dates);
  const live = new Set(platforms), yesterday = addDays(today, -1);
  const todayStart = dayStart(today, zone), dayAgo = now - DAY;
  const convDates = dateRange(addDays(today, -Math.max(days, CONV_BACK)), today), inConv = new Set(convDates);
  const rangeStart = Object.fromEntries(Object.entries(RANGES).map(([k, n]) => [k, dayStart(addDays(today, -(n - 1)), zone)]));

  // ---- Everyone RevenueCat has seen, and who is a tester ----
  const excluded = new Set(String(ownEnv(env, game, 'REVENUECAT_EXCLUDE') || '').split(/[\s,]+/).filter(Boolean));
  const launch = {}, sale = {};
  for (const p of platforms) {
    launch[p] = game.platforms?.[p]?.launched ? dayStart(game.platforms[p].launched, zone) : 0;
    sale[p] = await onSale(ctx, game, p);
  }
  const testers = { not_live: 0, prelaunch: 0, build: 0, excluded: 0, sandbox: 0 };
  const customers = [];
  for (const c of await pages(`${base}/customers?limit=100`)) {
    const p = platformOf(c.last_seen_platform), first = +c.first_seen_at || 0, last = Math.max(+c.last_seen_at || 0, first), version = c.last_seen_app_version || '';
    let why = null;
    if (!live.has(p)) why = 'not_live';
    else if (excluded.has(c.id)) why = 'excluded';
    else if (first < launch[p]) why = 'prelaunch';
    else if (version && (!versionParts(version) || (sale[p] && versionNewer(version, sale[p])))) why = 'build';
    if (why) testers[why]++;
    else customers.push({ id: c.id, p, first, last, version, cc: String(c.last_seen_country || '').toUpperCase().slice(0, 2), firstDay: dayIn(first, zone), lastDay: dayIn(last, zone), buys: [] });
  }
  // Every customer is read every run, which keeps the tester rule exact. That stops being possible somewhere past
  // 15,000 customers (RevenueCat's rate limit, the workflow's 15 minutes): say so well before then.
  const readWhole = customers.length + Object.values(testers).reduce((a, n) => a + n, 0);
  if (readWhole > 8000) notes.push(`${readWhole} customers are read whole every run: move to an incremental pull before about 15,000`);

  // ---- Purchases: read for whoever was around on a day RevenueCat's chart shows a sale, and for today's players ----
  // The chart is asked for the longest range, not the run's window: who paid in the last 90 days, and whether a
  // customer who installed a week ago has bought since, both need sales from before a 3-day window.
  const windowStart = dayStart(addDays(today, -Math.max(days, PAYERS_BACK)), zone), limit = Math.max(800, days * 150);
  let saleDays = null;
  try {
    const qs = new URLSearchParams({ start_date: addDays(ymd(windowStart), -1), end_date: addDays(ymd(now), 1), resolution: 'day' });
    const j = await get(`${base}/charts/revenue?${qs}`);
    const at = (j.measures || []).findIndex((m) => /transaction/i.test(m.display_name || ''));
    saleDays = (j.values || []).filter((v) => (v.measure ?? 0) === at && +v.value > 0).map((v) => v.cohort * 1000);
  } catch (e) { notes.push(`revenue chart: ${e.message}`); }
  const around = (c, t0, t1) => c.first < t1 && c.last >= t0;
  const recent = customers.filter((c) => c.last >= Math.min(todayStart, dayAgo));
  const scan = new Set();
  if (saleDays === null) { for (const c of customers) if (around(c, windowStart, now + DAY)) scan.add(c); } // no chart: everyone in the window
  else for (const t of saleDays) for (const c of customers) if (around(c, t - DAY / 2, t + DAY * 1.5)) scan.add(c);
  if (recent.length <= 200) for (const c of recent) scan.add(c);
  let list = [...scan].sort((a, b) => b.last - a.last);
  if (list.length > limit) { notes.push(`purchases read for the ${limit} most recent of ${list.length} customers, so paying customers may be undercounted`); list = list.slice(0, limit); }
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (i) await sleep(ctx.pause ?? 140); // 480 calls a minute
    for (const b of await pages(`${base}/customers/${encodeURIComponent(c.id)}/purchases?limit=100`, 20)) {
      if (String(b.environment).toLowerCase() !== 'production') { c.tester = true; continue; }
      const p = STORE_PLATFORM[b.store];
      if (!live.has(p) || excluded.has(b.id) || /refund/i.test(b.status || '')) continue;
      c.buys.push({ p, at: +b.purchased_at || 0, product: b.product_id, n: +b.quantity || 1, gross: +b.revenue_in_usd?.gross || 0, proceeds: +b.revenue_in_usd?.proceeds || 0 });
    }
  }
  const players = customers.filter((c) => { if (c.tester) testers.sandbox++; return !c.tester; });
  const buys = players.flatMap((c) => c.buys.map((b) => ({ ...b, c })));
  let productOf = null;
  if (buys.length) {
    try { productOf = new Map((await pages(`${base}/products?limit=100`, 50)).map((x) => [x.id, x.store_identifier || x.id])); }
    catch (e) { notes.push(`products: ${e.message}`); }
  }

  // ---- Daily rows ----
  const rows = new Rows(game.slug, source);
  const each = (p, fn) => { fn(p); fn('all'); };
  // Today is still being counted: its rows only ever go up (a sale the webhook reported is kept).
  const mode = (d) => (d === today ? 'max' : undefined);
  for (const d of dates) for (const p of [...platforms, 'all']) for (const k of ['new_customers', 'revenue', 'transactions', 'proceeds']) rows.add(p, d, k, 0, mode(d));
  // Conversion rows are worked out whole each run, so they are set, never kept at their highest.
  for (const d of convDates) for (const p of [...platforms, 'all']) for (const k of ['conv_cohort_size', 'new_paying_customers']) rows.add(p, d, k, 0);
  for (const c of players) {
    if (inWindow.has(c.firstDay)) each(c.p, (p) => rows.add(p, c.firstDay, 'new_customers', 1, mode(c.firstDay)));
    // Only a customer who has had the whole 7 days counts: a newer one who has not bought yet may still.
    if (inConv.has(c.firstDay) && c.first <= now - MATURE) {
      const paid = c.buys.some((b) => b.at - c.first < MATURE);
      each(c.p, (p) => { rows.add(p, c.firstDay, 'conv_cohort_size', 1); if (paid) rows.add(p, c.firstDay, 'new_paying_customers', 1); });
    }
    // Last seen is all RevenueCat keeps, so a day's active count is whoever was last seen on it: exact while the day
    // is in progress, a floor afterwards. Kept at its highest.
    for (const d of [today, yesterday]) {
      if (c.lastDay !== d) continue;
      each(c.p, (p) => { rows.add(p, d, 'active_customers', 1, 'max'); if (c.firstDay < d) rows.add(p, d, 'returning_customers', 1, 'max'); });
    }
  }
  for (const d of [today, yesterday]) for (const p of [...platforms, 'all']) for (const k of ['active_customers', 'returning_customers']) rows.add(p, d, k, 0, 'max');
  for (const b of buys) {
    const d = dayIn(b.at, zone); if (!inWindow.has(d)) continue;
    const id = keyPart(productOf?.get(b.product) || b.product);
    each(b.p, (p) => {
      rows.add(p, d, 'revenue', b.gross, mode(d)); rows.add(p, d, 'transactions', b.n, mode(d)); rows.add(p, d, 'proceeds', b.proceeds, mode(d));
      rows.add(p, d, `revenue_by_product:${id}`, b.gross, mode(d)); rows.add(p, d, `transactions_by_product:${id}`, b.n, mode(d));
    });
  }

  // RevenueCat's own active count (UTC days, testers in): what there is for the days before this pull began.
  try {
    const qs = new URLSearchParams({ start_date: from, end_date: today, resolution: 'day', segment: 'platform' });
    const j = await get(`${base}/charts/customers_active?${qs}`), segs = j.segments || [];
    for (const d of dates) for (const p of [...platforms, 'all']) rows.add(p, d, 'active_customers_chart', 0);
    for (const v of j.values || []) {
      const s = segs[v.segment ?? 0], p = platformOf(s?.display_name), d = ymd(v.cohort * 1000);
      if (!s?.is_total && live.has(p) && inWindow.has(d)) each(p, (q) => rows.add(q, d, 'active_customers_chart', +v.value || 0));
    }
  } catch (e) { notes.push(`customers_active: ${e.message}`); }

  // ---- The last 48 hours, by the hour ----
  const hourOf = (t) => new Date(Math.floor(t / HOUR) * HOUR).toISOString(), since = Math.floor(now / HOUR) * HOUR - 47 * HOUR;
  for (let t = since; t <= now; t += HOUR) for (const p of [...platforms, 'all']) rows.addHour(p, hourOf(t), 'new_customers', 0);
  for (const c of players) if (c.first >= since) each(c.p, (p) => rows.addHour(p, hourOf(c.first), 'new_customers', 1));
  for (const b of buys) if (b.at >= since) each(b.p, (p) => { rows.addHour(p, hourOf(b.at), 'revenue', b.gross); rows.addHour(p, hourOf(b.at), 'transactions', b.n); });

  // ---- What is true right now ----
  const count = (xs, pick) => { const m = new Map(); for (const x of xs) { const k = pick(x) || '??'; m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)); };
  const liveFor = (xs) => {
    const activeToday = xs.filter((c) => c.last >= todayStart), active24 = xs.filter((c) => c.last >= dayAgo), buys24 = xs.flatMap((c) => c.buys).filter((b) => b.at >= dayAgo);
    const settled = xs.filter((c) => c.firstDay < today); // had at least one later day to come back on
    const newBy = new Map(count(activeToday.filter((c) => c.firstDay === today), (c) => c.cc));
    return {
      today: { date: today, new: activeToday.filter((c) => c.firstDay === today).length, active: activeToday.length, returning: activeToday.filter((c) => c.firstDay < today).length },
      last24h: { new: active24.filter((c) => c.first >= dayAgo).length, active: active24.length, returning: active24.filter((c) => c.first < dayAgo).length, purchases: buys24.reduce((a, b) => a + b.n, 0), revenue: Math.round(buys24.reduce((a, b) => a + b.gross, 0) * 100) / 100 },
      countries: count(activeToday, (c) => c.cc).slice(0, 8).map(([cc, n]) => ({ cc, active: n, new: newBy.get(cc) || 0 })),
      versions: count(activeToday, (c) => c.version).slice(0, 6).map(([version, n]) => ({ version, active: n })),
      customers: xs.length,
      came_back: { cohort: settled.length, back: settled.filter((c) => c.lastDay > c.firstDay).length },
    };
  };
  // Different customers who bought: in each range (the same days the range's proceeds cover) and ever. By the store
  // the purchase was made in, as the proceeds are. `matured` is how many customers have had their 7 days.
  const payersFor = (p, xs) => {
    const bought = (c, t0) => c.buys.some((b) => (p === 'all' || b.p === p) && b.at >= t0);
    return {
      payers_by_range: Object.fromEntries(Object.entries(rangeStart).map(([k, t0]) => [k, players.filter((c) => bought(c, t0)).length])),
      unique_payers: players.filter((c) => bought(c, 0)).length,
      matured: xs.filter((c) => c.first <= now - MATURE).length,
    };
  };
  const block = (p) => { const xs = p === 'all' ? players : players.filter((c) => c.p === p); return { ...liveFor(xs), ...payersFor(p, xs) }; };
  const left = Object.values(testers).reduce((a, n) => a + n, 0);
  const facts = [{ key: 'revenuecat.live', value: {
    as_of: new Date(now).toISOString(), zone, day_started: new Date(todayStart).toISOString(),
    all: block('all'), ...Object.fromEntries(platforms.map((p) => [p, block(p)])),
    testers: { total: left, ...testers },
  } }];

  const daily = rows.daily, hourly = rows.hourly;
  const sum = (k) => daily.filter((r) => r.platform === 'all' && r.metric_key === k).reduce((a, r) => a + r.metric_value, 0);
  return {
    status: 'ok', daily, hourly, facts,
    message: `${daily.length + hourly.length} rows, ${days} days: $${sum('revenue').toFixed(2)} revenue, ${sum('transactions')} transactions, ${sum('new_customers')} new customers, ${left} testers left out, ${list.length} purchase lists read${notes.length ? '. ' + notes.join('; ') : ''}`,
  };
}
