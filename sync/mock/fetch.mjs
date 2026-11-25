// A stand-in for every outside API, for `--mock` and the tests: it answers the
// requests the sync sources make with made-up numbers in each API's real
// response shape, the same numbers for the same day every run. No network.
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { ymd, addDays, dateRange } from '../lib/util.mjs';

// A number from 0 to 1 that depends only on the text given.
const rnd = (s) => crypto.createHash('md5').update(String(s)).digest().readUInt32BE(0) / 2 ** 32;
const int = (s, lo, hi) => Math.floor(lo + rnd(s) * (hi - lo + 1));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const PRODUCTS = [['pearls.handful', 0.99], ['pearls.pouch', 4.99], ['pack.nixie', 4.99], ['early.hallowstide', 2.99], ['pearls.chest', 9.99]];
const day0 = (d) => Math.floor(Date.parse(d) / 1000);

/** What a platform's day looks like; every mock API draws from this so the sources agree with each other. */
export function mockDay(game, platform, date) {
  const k = platform === 'ios' ? 1 : 0.3, s = `${game}|${platform}|${date}`;
  const newUsers = Math.round(int(s + 'n', 10, 26) * k), dau = Math.round(int(s + 'd', 42, 84) * k) + newUsers;
  const sales = PRODUCTS.map(([id, price], i) => ({ id, price, n: rnd(s + id) < (0.5 - i * 0.09) * k ? int(s + id + 'q', 1, 2) : 0 })).filter((p) => p.n);
  const revenue = sales.reduce((a, p) => a + p.n * p.price, 0);
  return { newUsers, dau, sales, revenue, transactions: sales.reduce((a, p) => a + p.n, 0), sessions: Math.round(dau * 1.8), payers: Math.min(newUsers, sales.length ? 1 : 0) };
}

export function mockFetch({ today = ymd(Date.now()) } = {}) {
  const calls = [];
  const handler = async (url, opts = {}) => {
    const u = new URL(url); calls.push(`${opts.method || 'GET'} ${u.host}${u.pathname}`);
    const body = typeof opts.body === 'string' ? opts.body : '';
    if (u.host === 'api.revenuecat.com') return revenuecat(u, opts);
    if (u.host.endsWith('posthog.com')) return posthog(u, JSON.parse(body), today);
    if (u.host === 'api.appstoreconnect.apple.com' || u.host === 'mock-apple-files.test') return apple(u, today);
    if (u.host === 'api.frankfurter.dev') return json({ base: 'USD', rates: { EUR: 0.9, GBP: 0.8, CAD: 1.4 } });
    if (u.host === 'oauth2.googleapis.com') return json({ access_token: 'mock-token', expires_in: 3600 });
    if (u.host.endsWith('googleapis.com')) return google(u, body ? JSON.parse(body) : null, today);
    return json({ error: 'the mock has no answer for ' + u.host }, 501);
  };
  handler.calls = calls;
  return handler;
}

// ---- RevenueCat ----
function revenuecat(u, opts) {
  const game = (opts.headers?.authorization || '').replace(/^Bearer mock-/, '') || 'game';
  if (u.pathname === '/v2/projects') return json({ items: [{ id: 'projmock', name: game }] });
  const name = u.pathname.split('/').pop(), q = u.searchParams;
  const dates = dateRange(q.get('start_date'), q.get('end_date')), segment = q.get('segment');
  const lastDay = dates[dates.length - 1];
  const cell = (d, measure, seg, value) => ({ cohort: day0(d), incomplete: d === lastDay, measure, ...(seg === null ? {} : { segment: seg }), value: Math.round(value * 100) / 100 });
  const plats = [['ios', 'App Store', 'iOS'], ['android', 'Play Store', 'Android']];
  if (name === 'revenue') {
    const proceeds = /proceeds/.test(q.get('selectors') || '');
    const measures = [{ display_name: proceeds ? 'Proceeds' : 'Revenue' }, { display_name: 'Transactions' }];
    if (segment === 'store') {
      const values = [];
      for (const d of dates) plats.forEach(([p], i) => { const m = mockDay(game, p, d); values.push(cell(d, 0, i + 1, m.revenue * (proceeds ? 0.7 : 1)), cell(d, 1, i + 1, m.transactions)); });
      return json({ measures, segments: [{ display_name: 'Total', is_total: true }, ...plats.map(([, s]) => ({ display_name: s, is_total: false }))], values });
    }
    if (segment === 'product_id') {
      const store = JSON.parse(q.get('filters') || '[]')[0]?.values?.[0], p = store === 'play_store' ? 'android' : 'ios', values = [];
      for (const d of dates) for (const s of mockDay(game, p, d).sales) { const i = PRODUCTS.findIndex(([id]) => id === s.id) + 1; values.push(cell(d, 0, i, s.n * s.price), cell(d, 1, i, s.n)); }
      return json({ measures, segments: [{ display_name: 'Total', is_total: true }, ...PRODUCTS.map(([id]) => ({ display_name: id, is_total: false }))], values });
    }
  }
  if (name === 'customers_new' || name === 'customers_active') {
    if (segment !== 'platform') return json({ type: 'parameter_error', message: 'Invalid segment' }, 400);
    const values = [];
    for (const d of dates) plats.forEach(([p], i) => { const m = mockDay(game, p, d); values.push(cell(d, 0, i + 1, name === 'customers_new' ? m.newUsers : m.dau)); });
    return json({ measures: [{ display_name: name === 'customers_new' ? 'New Customers' : 'Active Customers' }], segments: [{ display_name: 'Total', is_total: true }, ...plats.map(([, , s]) => ({ display_name: s, is_total: false }))], values });
  }
  if (name === 'conversion_to_paying') {
    if (segment === 'platform') return json({ type: 'parameter_error', message: 'Invalid segment: platform' }, 400);
    const values = [];
    for (const d of dates) plats.forEach(([p], i) => { const m = mockDay(game, p, d); values.push(cell(d, 0, i + 1, m.newUsers), cell(d, 1, i + 1, m.payers), cell(d, 2, i + 1, m.newUsers ? m.payers / m.newUsers : 0)); });
    return json({ measures: [{ display_name: 'New Customers' }, { display_name: 'Paying Customers (7 days)' }, { display_name: 'Conversion Rate (7 days)' }], segments: [{ display_name: 'Total', is_total: true }, ...plats.map(([, , s]) => ({ display_name: s, is_total: false }))], values });
  }
  return json({ type: 'resource_missing' }, 404);
}

// ---- PostHog ----
const FTUE = ['01_Loaded', '01b_Swam', '02_Wardrobe', '03_Gift', '04_Tapped', '05_Bought', '06_Dressed', '07_Out', '08_Pearl', '09_Swim', '10_Quest', '11_QuestDone', '12_Home', '13_Decorate', '14_Camera', '15_Runway'];
const KEEP = [1, 0.93, 0.74, 0.86, 0.69, 0.41, 0.66, 0.9, 0.71, 0.55, 0.43, 0.36, 0.33, 0.21, 0.17, 0.09];
function posthog(u, body, today) {
  const game = u.pathname.split('/')[3], q = body.query.query;
  const found = [...q.matchAll(/'(\d{4}-\d\d-\d\d)/g)].map((m) => m[1]);
  const plats = ['ios', 'android'], out = (columns, results) => json({ columns, results });
  if (q.includes('toStartOfHour')) {
    const rows = [], t0 = Math.floor(Date.now() / 3600000) * 3600000;
    for (let h = 47; h >= 0; h--) for (const p of plats) { const t = new Date(t0 - h * 3600000).toISOString(); const n = Math.round(int(game + p + t, 2, 14) * (p === 'ios' ? 1 : 0.3)); if (n) rows.push([t.slice(0, 19).replace('T', ' '), p, n, n * 23]); }
    return out(['hour', 'platform', 'users', 'n'], rows);
  }
  if (q.includes('groupUniqArray')) {
    const rows = [];
    for (const d of dateRange(found[0], found[1])) for (const p of plats) {
      const c = mockDay(game, p, d).newUsers, age = (Date.parse(today) - Date.parse(d)) / 86400000;
      const back = (n, share) => (age >= n ? Math.round(c * share * (0.8 + 0.4 * rnd(game + p + d + n))) : 0);
      rows.push([d, p, c, back(1, 0.34), back(3, 0.22), back(7, 0.14), back(14, 0.09), back(30, 0.05)]);
    }
    return out(['first_day', 'platform', 'cohort', 'd1', 'd3', 'd7', 'd14', 'd30'], rows);
  }
  if (q.includes('arrayJoin(range(7))')) {
    const rows = [];
    for (const d of dateRange(found[2], found[3])) for (const p of plats) rows.push([d, p, Math.round(mockDay(game, p, d).dau * 3.1)]);
    return out(['wday', 'platform', 'users'], rows);
  }
  const dates = dateRange(found[0], addDays(found[1], -1));
  if (q.includes("'FTUE:%'")) {
    const rows = [];
    for (const d of dates) for (const p of plats) {
      const m = mockDay(game, p, d);
      FTUE.forEach((s, i) => { const n = Math.round(m.newUsers * KEEP[i]); if (n) rows.push([d, p, `FTUE:${s}`, n, n]); });
      rows.push([d, p, 'FTUE:Start:Sea', m.newUsers, m.newUsers]);
      const taps = Math.round(m.dau * 0.12);
      for (const [e, n] of [['Store:State:open', Math.round(m.dau * 0.3)], ['Store:Tap:pearls.handful', taps], ['Store:Sheet:pearls.handful', Math.round(taps * 0.8)], ['Store:Cancel:pearls.handful', Math.round(taps * 0.6)], ['Store:Bought:pearls.handful', m.transactions]]) if (n) rows.push([d, p, e, n, n]);
      const bad = int(game + p + d + 'u', 0, 3);
      if (bad) rows.push([d, p, 'Session:UncleanExit:Playing', bad, bad]);
      if (rnd(game + p + d + 'l') < 0.3) rows.push([d, p, 'Session:UncleanExit:Loading', 1, 1]);
      if (rnd(game + p + d + 'e') < 0.4) rows.push([d, p, 'App:Error', int(game + p + d + 'en', 1, 4), 1]);
      [0.05, 0.3, 0.2, 0.25, 0.15, 0.05].forEach((share, i) => { const n = Math.round(m.newUsers * share); if (n) rows.push([d, p, `Gfx:Level:${i + 1}`, n, n]); });
    }
    return out(['day', 'platform', 'event', 'n', 'users'], rows);
  }
  const rows = [];
  for (const d of dates) for (const p of plats) { const m = mockDay(game, p, d); rows.push([d, p, m.dau, m.sessions, Math.round(m.sessions * 0.9)]); }
  return out(['day', 'platform', 'users', 'sessions', 'launches'], rows);
}

// ---- App Store Connect ----
const gz = (text) => new Response(zlib.gzipSync(Buffer.from(text)), { status: 200, headers: { 'content-type': 'application/a-gzip' } });
const APPLE_REPORTS = ['App Store Discovery and Engagement Standard', 'App Store Discovery and Engagement Detailed', 'App Downloads Standard', 'App Sessions Standard', 'App Crashes', 'App Store Purchases Standard'];
function apple(u, today) {
  const p = u.pathname, q = u.searchParams;
  let m;
  if ((m = /^\/v1\/apps\/(\d+)$/.exec(p))) return json({ data: { id: m[1], attributes: { sku: 'SKU' + m[1] } } });
  if (p === '/v1/salesReports') {
    const d = q.get('filter[reportDate]');
    if (d >= addDays(today, -1)) return json({ errors: [{ status: '404', code: 'NOT_FOUND', detail: 'Report is not available yet. Daily reports for the Americas are available by 5 am Pacific Time.' }] }, 404);
    const head = ['Provider', 'Provider Country', 'SKU', 'Developer', 'Title', 'Version', 'Product Type Identifier', 'Units', 'Developer Proceeds', 'Begin Date', 'End Date', 'Customer Currency', 'Country Code', 'Currency of Proceeds', 'Apple Identifier', 'Customer Price', 'Promo Code', 'Parent Identifier'];
    const lines = [head.join('\t')];
    for (const app of ['6820164397', '6838396514']) {
      const x = mockDay('pearl-tide', 'ios', d);
      const row = (type, units, proceeds, cur, id, parent) => lines.push(['APPLE', 'US', 'x', 'dev', 't', '1.0', type, units, proceeds, d, d, cur, 'US', cur, id, '0', '', parent].join('\t'));
      row('1F', x.newUsers, 0, 'USD', app, ''); row('3F', Math.round(x.newUsers * 0.2), 0, 'USD', app, ''); row('7F', Math.round(x.dau * 0.1), 0, 'USD', app, '');
      x.sales.forEach((s, i) => row('IA1', s.n, (s.price * 0.7).toFixed(2), i % 2 ? 'EUR' : 'USD', '99' + i, 'SKU' + app));
    }
    return gz(lines.join('\n'));
  }
  if ((m = /^\/v1\/apps\/(\d+)\/analyticsReportRequests$/.exec(p))) return json({ data: [{ id: 'req-' + m[1], attributes: { accessType: 'ONGOING', stoppedDueToInactivity: false } }] });
  if ((m = /^\/v1\/analyticsReportRequests\/req-(\d+)\/reports$/.exec(p))) return json({ data: APPLE_REPORTS.map((name, i) => ({ id: `rep-${m[1]}-${i}`, attributes: { name } })) });
  if ((m = /^\/v1\/analyticsReports\/(rep-\d+-\d+)\/instances$/.exec(p))) return json({ data: dateRange(addDays(today, -40), addDays(today, -2)).map((d) => ({ id: `${m[1]}_${d}`, attributes: { granularity: 'DAILY', processingDate: d } })) });
  if ((m = /^\/v1\/analyticsReportInstances\/(.+)\/segments$/.exec(p))) return json({ data: [{ id: 's1', attributes: { url: `https://mock-apple-files.test/${m[1]}?sig=secret` } }] });
  if (u.host === 'mock-apple-files.test') {
    const [, app, idx, d] = /rep-(\d+)-(\d+)_(.+)$/.exec(p), x = mockDay('pearl-tide', 'ios', d), base = `${d}\tGame\t${app}`;
    const files = {
      0: `Date\tApp Name\tApp Apple Identifier\tEvent\tPage Type\tSource Type\tCounts\tUnique Counts\n${base}\tImpression\tStore sheet\tApp Store search\t${x.newUsers * 31}\t${x.newUsers * 24}\n${base}\tImpression\tProduct page\tApp Store browse\t${x.newUsers * 9}\t${x.newUsers * 7}\n${base}\tPage view\tProduct page\tApp Store search\t${x.newUsers * 4}\t${x.newUsers * 3}\n${base}\tTap\tProduct page\tApp Store search\t5\t4`,
      2: `Date\tApp Name\tApp Apple Identifier\tDownload Type\tApp Version\tDevice\tCounts\n${base}\tFirst-time download\t1.3.7\tiPhone\t${x.newUsers}\n${base}\tRedownload\t1.3.7\tiPhone\t${Math.round(x.newUsers * 0.2)}\n${base}\tAuto-update\t1.3.7\tiPhone\t9`,
      3: `Date\tApp Name\tApp Apple Identifier\tApp Version\tDevice\tSessions\tTotal Session Duration\tUnique Devices\n${base}\t1.3.7\tiPhone\t${Math.round(x.sessions * 0.4)}\t${x.sessions * 240}\t${Math.round(x.dau * 0.4)}`,
      4: `Date\tApp Name\tApp Apple Identifier\tApp Version\tDevice\tCrashes\tUnique Devices\n${base}\t1.3.7\tiPhone\t${int(d + 'c', 0, 2)}\t1`,
      5: `Date\tApp Name\tApp Apple Identifier\tPurchase Type\tContent Name\tPurchases\tProceeds in USD\tSales in USD\tPaying Users\n${base}\tIn-App Purchase\tPearls\t${x.transactions}\t${(x.revenue * 0.7).toFixed(2)}\t${x.revenue.toFixed(2)}\t${x.payers}`,
    };
    return gz(files[idx] || 'Date\n');
  }
  return json({ errors: [{ status: '404' }] }, 404);
}

// ---- Google Play ----
function google(u, body, today) {
  const p = u.pathname; let m;
  if ((m = /\/apps\/([^/]+)\/(crashRateMetricSet|anrRateMetricSet)$/.exec(p))) { const [year, month, day] = addDays(today, -1).split('-').map(Number); return json({ freshnessInfo: { freshnesses: [{ aggregationPeriod: 'DAILY', latestEndTime: { year, month, day, timeZone: { id: 'America/Los_Angeles' } } }] } }); }
  if ((m = /\/apps\/([^/]+)\/(crashRateMetricSet|anrRateMetricSet):query$/.exec(p))) {
    const s = body.timelineSpec, at = (t) => `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
    const rows = dateRange(at(s.startTime), addDays(at(s.endTime), -1)).map((d) => { const [year, month, day] = d.split('-').map(Number); return { aggregationPeriod: 'DAILY', startTime: { year, month, day, timeZone: { id: 'America/Los_Angeles' } }, metrics: body.metrics.map((k) => ({ metric: k, decimalValue: { value: k === 'distinctUsers' ? String(mockDay(m[1], 'android', d).dau) : (0.002 + rnd(d + k) * 0.01).toFixed(5) } })) }; });
    return json({ rows });
  }
  if (u.host === 'storage.googleapis.com') {
    const object = decodeURIComponent(p.split('/o/')[1]), f = /stats\/(installs|ratings)\/\1_(.+)_(\d{6})_overview\.csv/.exec(object);
    if (!f) return json({ error: { code: 404 } }, 404);
    const month = `${f[3].slice(0, 4)}-${f[3].slice(4)}`, days = dateRange(`${month}-01`, today).filter((d) => d.startsWith(month));
    const lines = f[1] === 'installs'
      ? ['Date,Package Name,Daily Device Installs,Daily Device Uninstalls,Daily Device Upgrades,Total User Installs,Daily User Installs,Daily User Uninstalls,Active Device Installs,Install events,Update events,Uninstall events', ...days.map((d) => { const x = mockDay(f[2], 'android', d); return `${d},${f[2]},${x.newUsers + 1},2,0,0,${x.newUsers},1,"1,${String(100 + x.dau).padStart(3, '0')}",0,0,0`; })]
      : ['Date,Package Name,Daily Average Rating,Total Average Rating', ...days.map((d) => `${d},${f[2]},${rnd(d) < 0.5 ? 'NA' : '5.00'},4.6`)];
    return new Response(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\n'), 'utf16le')]), { status: 200 });
  }
  if (/\/reviews$/.test(p)) return json({ reviews: [{ comments: [{ userComment: { starRating: 5 } }] }, { comments: [{ userComment: { starRating: 4 } }] }] });
  return json({ error: { code: 404, message: 'not found' } }, 404);
}

/** Environment variables that make every source run against the mock, with keys made on the spot. */
export function mockEnv(games) {
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const env = {
    ASC_KEY_ID: 'MOCKKEY', ASC_ISSUER_ID: 'mock-issuer', ASC_PRIVATE_KEY: ec, ASC_VENDOR_NUMBER: '80000000',
    GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'mock@mock.iam.gserviceaccount.com', private_key: rsa, token_uri: 'https://oauth2.googleapis.com/token' }),
    GOOGLE_PLAY_BUCKET: 'pubsite_prod_rev_mock', POSTHOG_PERSONAL_API_KEY: 'phx_mock',
  };
  for (const g of games) { env[`${g.env_prefix}_REVENUECAT_API_KEY`] = `mock-${g.slug}`; env[`${g.env_prefix}_POSTHOG_PROJECT_ID`] = g.slug; }
  return env;
}

export const mockGameDb = async (url, queries, game) => Object.fromEntries(Object.keys(queries).map((k, i) => [k, [17, 9, 5][i] ?? int(game.slug + k, 1, 20)]));
