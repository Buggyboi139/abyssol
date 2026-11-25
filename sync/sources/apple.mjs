// App Store Connect API, for a game whose iOS platform is live.
//   Sales reports (daily summary): first downloads, redownloads, updates,
//     in-app purchase units, and proceeds. Needs ASC_VENDOR_NUMBER and a key
//     with the Sales, Finance, or Admin role.
//   Analytics reports: impressions, product page views, downloads, sessions,
//     active devices, crashes, and proceeds in USD. Needs an ONGOING report
//     request for the app, which only an Admin key can create
//     (run once with --create-report-request); a Sales and Reports key
//     reads it from then on. Their days are UTC days.
// Apple delivers both a day at a time, a day or two late.
import zlib from 'node:zlib';
import { Rows, request, getJson, signJwt, pem, parseTable, col, num, addDays, dateRange, HttpError } from '../lib/util.mjs';
import { sharedEnv } from '../lib/env.mjs';

export const source = 'apple';
const API = 'https://api.appstoreconnect.apple.com';

// Which analytics reports are read, and the columns each adds up.
const REPORTS = [
  { name: /^App Store Discovery and Engagement Standard/i, read(r, add) {
    const ev = col(r, /^event$/i) || '', page = col(r, /^page type$/i) || '', n = num(col(r, /^counts$/i)), u = num(col(r, /^unique counts$/i));
    // Read both total Counts and Unique Counts. Apple's App Store Connect conversion and product-page rates use
    // Unique Counts (unique devices per day/slice) so repeated views by the same shopper do not drag rates down.
    // The same counts again for App Store search alone: a search result is a different shopper from a browse or a link.
    const search = /search/i.test(col(r, /^source type$/i) || '');
    if (/^impression/i.test(ev)) { add('impressions', n); add('impressions_unique', u); if (search) { add('impressions_search', n); add('impressions_search_unique', u); } }
    // "Page view" is also every look at a screenshot or video (Media view), the developer page, and the version
    // history. Only the listing itself counts, on the App Store or as a sheet inside another app.
    else if (/^page view/i.test(ev) && (!page || /^(product page|store sheet)$/i.test(page))) { add('page_views', n); add('page_views_unique', u); if (search) { add('page_views_search', n); add('page_views_search_unique', u); } }
  }, zero: ['impressions', 'impressions_unique', 'page_views', 'page_views_unique', 'impressions_search', 'impressions_search_unique', 'page_views_search', 'page_views_search_unique'] },
  { name: /^App Downloads Standard/i, read(r, add) {
    const t = col(r, /^download type$/i) || '', n = num(col(r, /^counts$/i));
    // A download with no page is Get tapped in the search results, the listing never opened.
    if (/first.?time/i.test(t)) { add('an_downloads', n); if (/^no page$/i.test(col(r, /^page type$/i) || '')) add('an_downloads_direct', n); if (/search/i.test(col(r, /^source type$/i) || '')) add('an_downloads_search', n); }
    else if (/^redownload/i.test(t)) add('an_redownloads', n);
  }, zero: ['an_downloads', 'an_downloads_direct', 'an_downloads_search', 'an_redownloads'] },
  { name: /^App Sessions Standard/i, read(r, add) {
    add('sessions', num(col(r, /^sessions$/i))); add('active_devices', num(col(r, /^unique devices$/i))); add('session_seconds', num(col(r, /^total session duration$/i)));
  }, zero: ['sessions', 'active_devices'] },
  { name: /^App Crashes$/i, alt: /^App Crashes/i, read(r, add) { add('crashes', num(col(r, /^crashes$/i))); }, zero: ['crashes'] },
  { name: /^App Store Purchases Standard/i, read(r, add) {
    add('an_purchases', num(col(r, /^purchases$/i))); add('an_proceeds', num(col(r, /^proceeds in usd$/i))); add('an_paying_users', num(col(r, /^paying users$/i)));
  }, zero: ['an_purchases', 'an_proceeds'] },
];

export async function run(ctx) {
  const { game, env, fetchImpl, days, platforms, today } = ctx;
  if (!platforms.includes('ios')) return { status: 'skipped', message: `iOS is not live (${game.platforms?.ios?.status || 'pre-launch'})` };
  const appId = game.platforms.ios.app_store_id;
  if (!appId) return { status: 'skipped', message: 'config/games.json has no platforms.ios.app_store_id' };
  const keyId = sharedEnv(env, game, 'ASC_KEY_ID'), issuer = sharedEnv(env, game, 'ASC_ISSUER_ID'), key = pem(sharedEnv(env, game, 'ASC_PRIVATE_KEY'));
  if (!keyId || !issuer || !key) return { status: 'skipped', message: 'Not connected: set ASC_KEY_ID, ASC_ISSUER_ID, and ASC_PRIVATE_KEY' };

  const iat = Math.floor(ctx.now / 1000);
  const token = signJwt({ alg: 'ES256', header: { kid: keyId }, payload: { iss: issuer, iat, exp: iat + 900, aud: 'appstoreconnect-v1' }, privateKey: key });
  const headers = { authorization: `Bearer ${token}` };
  const api = (path, opts = {}) => getJson(fetchImpl, API + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });

  const rows = new Rows(game.slug, source);
  const notes = []; let parts = 0;

  // ---- Sales reports ----
  const vendor = sharedEnv(env, game, 'ASC_VENDOR_NUMBER');
  if (!vendor) notes.push('sales: set ASC_VENDOR_NUMBER');
  else {
    try {
      const sku = (await api(`/v1/apps/${appId}?fields[apps]=sku`)).data?.attributes?.sku;
      const rates = await usdRates(ctx);
      let got = 0, foreign = 0;
      for (const date of dateRange(addDays(today, -days), addDays(today, -1))) {
        const report = await salesReport(ctx, headers, vendor, date);
        if (report === null) continue; // not out yet
        got++;
        for (const k of ['downloads', 'redownloads', 'updates', 'iap_units', 'proceeds']) rows.add('ios', date, k, 0);
        for (const r of report) {
          const isApp = col(r, /^apple identifier$/i) === String(appId), isIap = sku && col(r, /^parent identifier$/i) === sku;
          if (!isApp && !isIap) continue;
          const type = col(r, /^product type identifier$/i) || '', units = num(col(r, /^units$/i));
          if (/^1/.test(type)) rows.add('ios', date, 'downloads', units);
          else if (/^3/.test(type)) rows.add('ios', date, 'redownloads', units);
          else if (/^7/.test(type)) rows.add('ios', date, 'updates', units);
          else if (/^IA/i.test(type)) rows.add('ios', date, 'iap_units', units);
          const each = num(col(r, /^developer proceeds$/i)), cur = col(r, /^currency of proceeds$/i) || 'USD';
          if (each) {
            if (cur === 'USD') rows.add('ios', date, 'proceeds', each * units);
            else if (rates?.[cur]) rows.add('ios', date, 'proceeds', (each * units) / rates[cur]);
            else foreign++;
          }
        }
      }
      parts++;
      notes.push(`sales: ${got} daily reports${foreign ? `, ${foreign} rows in currencies with no rate left out of proceeds` : ''}`);
    } catch (e) { notes.push(`sales: ${explain(e)}`); }
  }

  // ---- Analytics reports ----
  try {
    const reqs = await api(`/v1/apps/${appId}/analyticsReportRequests?filter[accessType]=ONGOING`);
    let requestId = reqs.data?.find((d) => !d.attributes?.stoppedDueToInactivity)?.id || reqs.data?.[0]?.id;
    if (!requestId && ctx.createReportRequest) {
      const made = await api('/v1/analyticsReportRequests', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { type: 'analyticsReportRequests', attributes: { accessType: 'ONGOING' }, relationships: { app: { data: { type: 'apps', id: String(appId) } } } } }),
      });
      requestId = made.data?.id;
      notes.push('analytics: report request made, Apple fills it within a day or two');
    }
    if (!requestId) notes.push('analytics: no ongoing report request yet (run once with --create-report-request and an Admin key)');
    else {
      const list = await api(`/v1/analyticsReportRequests/${requestId}/reports?limit=200`);
      const since = addDays(today, -days); let files = 0;
      for (const want of REPORTS) {
        const rep = list.data?.find((d) => want.name.test(d.attributes?.name || '')) || (want.alt && list.data?.find((d) => want.alt.test(d.attributes?.name || '')));
        if (!rep) continue;
        const inst = await api(`/v1/analyticsReports/${rep.id}/instances?filter[granularity]=DAILY&limit=200`);
        // A daily file is stamped with the day Apple processed it and restates the two or three days before
        // it, each in its Date column. So a day is read whole from the newest file that has it (oldest file
        // first, a later one replacing it), never added up across files, and a day counts as zero only when
        // a file has rows for it: the processing day itself has none yet.
        const fresh = (inst.data || []).filter((i) => i.attributes?.processingDate >= since).sort((a, b) => a.attributes.processingDate.localeCompare(b.attributes.processingDate));
        for (const i of fresh) {
          const pd = i.attributes.processingDate, byDay = new Map();
          const segs = await api(`/v1/analyticsReportInstances/${i.id}/segments`);
          for (const s of segs.data || []) {
            const url = s.attributes?.url; if (!url) continue;
            const r = await request(fetchImpl, url, { timeout: 60000 });
            for (const row of parseTable(gunzip(Buffer.from(await r.arrayBuffer())))) {
              if (col(row, /^app apple identifier$/i) && col(row, /^app apple identifier$/i) !== String(appId)) continue;
              const d = (col(row, /^date$/i) || pd).slice(0, 10);
              if (!byDay.has(d)) byDay.set(d, Object.fromEntries(want.zero.map((k) => [k, 0])));
              const day = byDay.get(d);
              want.read(row, (k, v) => { if (Number.isFinite(v)) day[k] = (day[k] || 0) + v; });
            }
            files++;
          }
          for (const [d, sums] of byDay) for (const [k, v] of Object.entries(sums)) rows.set('ios', d, k, v);
        }
      }
      parts++;
      notes.push(`analytics: ${files} report files`);
    }
  } catch (e) { notes.push(`analytics: ${explain(e)}`); }

  const daily = rows.daily;
  if (!parts) return { status: 'error', message: notes.join('. ') };
  return { status: 'ok', daily, hourly: [], message: `${daily.length} rows. ${notes.join('. ')}` };
}

function gunzip(buf) { return (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8'); }

function explain(e) {
  if (e instanceof HttpError && e.status === 403) return 'the API key\'s role does not allow this (403)';
  if (e instanceof HttpError && e.status === 401) return 'the API key was refused (401)';
  return e.message;
}

/** One day's sales summary for the vendor, shared by every game in a run. null when Apple has not produced it yet. */
async function salesReport(ctx, headers, vendor, date) {
  const id = `apple-sales:${vendor}:${date}`;
  if (ctx.cache.has(id)) return ctx.cache.get(id);
  const qs = new URLSearchParams({ 'filter[frequency]': 'DAILY', 'filter[reportType]': 'SALES', 'filter[reportSubType]': 'SUMMARY', 'filter[vendorNumber]': vendor, 'filter[reportDate]': date, 'filter[version]': '1_1' });
  let out;
  try {
    const r = await request(ctx.fetchImpl, `${API}/v1/salesReports?${qs}`, { headers: { ...headers, accept: 'application/a-gzip' }, timeout: 60000 });
    out = parseTable(gunzip(Buffer.from(await r.arrayBuffer())));
  } catch (e) {
    // 404: no sales that day (a day of zeros), or the report is not out yet.
    if (e instanceof HttpError && e.status === 404) out = /no sales/i.test(String(e.body)) ? [] : null;
    else throw e;
  }
  ctx.cache.set(id, out);
  return out;
}

/** Units of each currency a US dollar buys (European Central Bank rates), to turn proceeds into dollars. */
async function usdRates(ctx) {
  if (ctx.cache.has('usd-rates')) return ctx.cache.get('usd-rates');
  let rates = null;
  try { rates = (await getJson(ctx.fetchImpl, 'https://api.frankfurter.dev/v1/latest?base=USD', { retries: 1, timeout: 10000 })).rates || null; } catch { /* dollars only */ }
  ctx.cache.set('usd-rates', rates);
  return rates;
}
