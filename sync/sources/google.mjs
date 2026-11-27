// Google Play, for a game whose Android platform is live.
//   Play Developer Reporting API (Android vitals): crash, ANR, low-memory-kill
//     and slow-frame rates, and active devices. Play reports them
//     only once enough devices run the app.
//   Play's monthly statistics exports (a Cloud Storage bucket): installs,
//     uninstalls, ratings, daily crash and ANR counts, and store listing
//     visitors and the installs they made, overall and from Play search and
//     Explore. The Reporting API has none of these, so they need
//     GOOGLE_PLAY_BUCKET (Play Console, Download reports, Statistics: the
//     pubsite_prod_... name in "Copy Cloud Storage URI"). Play writes them
//     several days late.
//   Android Publisher API: the last week's written reviews.
// Play Console's peer comparison (Statistics, Compare to peers) has no API: it is
// read by hand into the manual.google_peers fact (README, Numbers read by hand).
// Needs GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, a service account invited in Play
// Console with "View app information and download bulk reports".
import { Rows, request, getJson, signJwt, parseTable, col, num, addDays, HttpError } from '../lib/util.mjs';
import { sharedEnv } from '../lib/env.mjs';

export const source = 'google';
const REPORTING = 'https://playdeveloperreporting.googleapis.com/v1beta1';
const TZ = 'America/Los_Angeles'; // the only zone Play's daily vitals come in
const SCOPES = 'https://www.googleapis.com/auth/playdeveloperreporting https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/devstorage.read_only';

export async function run(ctx) {
  const { game, env, fetchImpl, days, platforms, today } = ctx;
  if (!platforms.includes('android')) return { status: 'skipped', message: `Android is not live (${game.platforms?.android?.status || 'pre-launch'})` };
  const pkg = game.android_package_id;
  if (!pkg) return { status: 'skipped', message: 'config/games.json has no android_package_id' };
  const raw = sharedEnv(env, game, 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
  if (!raw) return { status: 'skipped', message: 'Not connected: set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON' };
  let sa; try { sa = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')); } catch { return { status: 'error', message: 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not JSON (or base64 of it)' }; }

  const token = await accessToken(ctx, sa);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const rows = new Rows(game.slug, source);
  const notes = []; let parts = 0;
  const ymdOf = (t) => `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
  const asDate = (s) => { const [year, month, day] = s.split('-').map(Number); return { year, month, day, timeZone: { id: TZ } }; };

  // ---- Vitals ----
  const vitals = async (set, metrics, map) => {
    const info = await getJson(fetchImpl, `${REPORTING}/apps/${pkg}/${set}`, { headers });
    const fresh = info.freshnessInfo?.freshnesses?.find((f) => f.aggregationPeriod === 'DAILY')?.latestEndTime;
    if (!fresh) return 0;
    const end = ymdOf(fresh), start = addDays(end, -days);
    let page = '', n = 0;
    do {
      const j = await getJson(fetchImpl, `${REPORTING}/apps/${pkg}/${set}:query`, {
        method: 'POST', headers,
        body: JSON.stringify({ timelineSpec: { aggregationPeriod: 'DAILY', startTime: asDate(start), endTime: asDate(end) }, metrics, dimensions: [], pageSize: 1000, ...(page ? { pageToken: page } : {}) }),
      });
      for (const r of j.rows || []) {
        const d = ymdOf(r.startTime);
        for (const m of r.metrics || []) { const k = map[m.metric]; if (k && m.decimalValue?.value !== undefined) { rows.set('android', d, k, num(m.decimalValue.value)); n++; } }
      }
      page = j.nextPageToken || '';
    } while (page);
    return n;
  };
  // Each set on its own: Play may answer one and refuse another (a set it has no data for, or one it has not opened to the app).
  const SETS = [
    ['crashRateMetricSet', ['crashRate', 'userPerceivedCrashRate', 'distinctUsers'], { crashRate: 'crash_rate', userPerceivedCrashRate: 'user_perceived_crash_rate', distinctUsers: 'active_devices' }],
    ['anrRateMetricSet', ['anrRate', 'userPerceivedAnrRate'], { anrRate: 'anr_rate', userPerceivedAnrRate: 'user_perceived_anr_rate' }],
    ['lmkRateMetricSet', ['userPerceivedLmkRate'], { userPerceivedLmkRate: 'user_perceived_lmk_rate' }],
    ['slowRenderingRateMetricSet', ['slowRenderingRate30Fps'], { slowRenderingRate30Fps: 'slow_rendering_rate' }],
  ];
  let got = 0; const refused = [];
  for (const [set, metrics, map] of SETS) {
    try { got += await vitals(set, metrics, map); } catch (e) { refused.push(`${set.replace('MetricSet', '')} (${explain(e)})`); }
  }
  if (refused.length < SETS.length) parts++;
  notes.push(`vitals: ${got ? `${got} values` : 'Play has none for this app yet (it reports them once enough devices run it)'}${refused.length ? `; not read: ${refused.join(', ')}` : ''}`);

  // ---- Installs and ratings, from the statistics exports ----
  const bucket = sharedEnv(env, game, 'GOOGLE_PLAY_BUCKET').replace(/^gs:\/\//, '').replace(/\/.*$/, '');
  if (!bucket) notes.push('installs and ratings: set GOOGLE_PLAY_BUCKET');
  else {
    const since = addDays(today, -days), months = new Set([since.slice(0, 7).replace('-', ''), today.slice(0, 7).replace('-', '')]);
    const stats = async (kind, read, file = 'overview') => {
      let n = 0;
      for (const m of months) {
        const object = `stats/${kind}/${kind}_${pkg}_${m}_${file}.csv`;
        let r;
        try { r = await request(fetchImpl, `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`, { headers, timeout: 60000 }); }
        catch (e) { if (e instanceof HttpError && e.status === 404) continue; throw e; }
        const buf = Buffer.from(await r.arrayBuffer());
        // Play writes these as UTF-16 with a byte order mark.
        const text = buf[0] === 0xff && buf[1] === 0xfe ? new TextDecoder('utf-16le').decode(buf) : buf.toString('utf8');
        for (const row of parseTable(text, ',')) { const d = (col(row, /^date$/i) || '').slice(0, 10); if (d >= since) { read(row, d); n++; } }
      }
      return n;
    };
    try {
      const i = await stats('installs', (row, d) => {
        rows.set('android', d, 'installs', num(col(row, /^daily user installs$/i)));
        rows.set('android', d, 'device_installs', num(col(row, /^daily device installs$/i)));
        rows.set('android', d, 'uninstalls', num(col(row, /^daily user uninstalls$/i)));
        rows.set('android', d, 'active_installs', num(col(row, /^active device installs$/i)));
      });
      const r = await stats('ratings', (row, d) => {
        const day = col(row, /^daily average rating$/i), total = col(row, /^total average rating$/i);
        if (day && !/^na$/i.test(day)) rows.set('android', d, 'rating_daily', num(day));
        if (total && !/^na$/i.test(total)) rows.set('android', d, 'rating_total', num(total));
      });
      parts++; notes.push(`statistics: ${i} install days, ${r} rating days`);
    } catch (e) { notes.push(`statistics: ${explain(e)}`); }
    // Crashes and ANRs as counts, which Play writes even when it has too few devices for the vitals' rates.
    try {
      const c = await stats('crashes', (row, d) => {
        rows.set('android', d, 'crashes', num(col(row, /^daily crashes$/i)));
        rows.set('android', d, 'anrs', num(col(row, /^daily anrs$/i)));
      });
      parts++; notes.push(`crash counts: ${c} days`);
    } catch (e) { notes.push(`crash counts: ${explain(e)}`); }
    // Store listing visitors and the installs they made, from the store performance export: one row a country a
    // day for the totals, and one a traffic source a day for what came from Play search and from Explore.
    try {
      const day = new Map(), add = (d, k, v) => { const t = day.get(d) || day.set(d, {}).get(d); t[k] = (t[k] || 0) + v; };
      await stats('store_performance', (row, d) => {
        add(d, 'store_acquisitions', num(col(row, /^store listing acquisitions$/i))); add(d, 'store_visitors', num(col(row, /^store listing visitors$/i)));
      }, 'country');
      await stats('store_performance', (row, d) => {
        const from = /search/i.test(col(row, /^traffic source$/i) || '') ? 'search' : /explore/i.test(col(row, /^traffic source$/i) || '') ? 'explore' : null;
        add(d, 'store_visitors_search', 0); add(d, 'store_visitors_explore', 0); add(d, 'store_acquisitions_search', 0); add(d, 'store_acquisitions_explore', 0);
        if (from) { add(d, `store_acquisitions_${from}`, num(col(row, /^store listing acquisitions$/i))); add(d, `store_visitors_${from}`, num(col(row, /^store listing visitors$/i))); }
      }, 'traffic_source');
      for (const [d, t] of day) for (const [k, v] of Object.entries(t)) rows.set('android', d, k, v);
      parts++; notes.push(`store listing: ${day.size} days`);
    } catch (e) { notes.push(`store listing: ${explain(e)}`); }
  }

  // ---- Reviews written in the last week ----
  try {
    const j = await getJson(fetchImpl, `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}/reviews?maxResults=100`, { headers });
    const stars = (j.reviews || []).map((r) => r.comments?.[0]?.userComment?.starRating).filter((s) => s > 0);
    rows.set('android', today, 'reviews_7d', stars.length);
    if (stars.length) rows.set('android', today, 'reviews_7d_rating', stars.reduce((a, s) => a + s, 0) / stars.length);
    parts++; notes.push(`reviews: ${stars.length} in the last week`);
  } catch (e) { notes.push(`reviews: ${explain(e)}`); }

  const daily = rows.daily;
  if (!parts) return { status: 'error', message: notes.join('. ') };
  return { status: 'ok', daily, hourly: [], message: `${daily.length} rows. ${notes.join('. ')}` };
}

function explain(e) {
  if (e instanceof HttpError && e.status === 403) return 'the service account has no access (403)';
  return e.message;
}

/** An OAuth access token for the service account, shared by every game in a run. */
async function accessToken(ctx, sa) {
  const id = `google-token:${sa.client_email}`;
  if (ctx.cache.has(id)) return ctx.cache.get(id);
  const iat = Math.floor(ctx.now / 1000), uri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const assertion = signJwt({ alg: 'RS256', payload: { iss: sa.client_email, scope: SCOPES, aud: uri, iat, exp: iat + 3000 }, privateKey: sa.private_key });
  const j = await getJson(ctx.fetchImpl, uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() });
  if (!j.access_token) throw new Error('Google refused the service account');
  ctx.cache.set(id, j.access_token);
  return j.access_token;
}
