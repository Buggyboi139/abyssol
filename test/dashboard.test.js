// End to end, with nothing outside this process: the real migrations in a
// local Postgres, the sync against stand-in APIs, and the Pages Functions.
import { test, expect, beforeAll } from 'bun:test';
import { makeDb, dbFetch, rpc, LOCAL_KEY } from '../scripts/localdb.mjs';
import { hashPassword, verifyPassword, verifyUsername, makeSession, readSession, signingKey, COOKIE } from '../server/auth.js';
import { buildGame, change, rangeDates, addDays } from '../server/metrics.js';
import { saleOf } from '../functions/api/webhooks/revenuecat.js';
import { sync } from '../sync/run.mjs';
import { loadGames } from '../sync/lib/config.mjs';
import { mockFetch, mockEnv, mockGameDb, mockGames, mockDay } from '../sync/mock/fetch.mjs';
import { tell, tagOf } from '../sync/lib/stories.mjs';
import { dayIn, dayStart } from '../server/zone.js';
import { pages } from './pages.mjs';

const DB = 'http://db.test', USERNAME = 'Owner', PASSWORD = 'correct horse battery staple';
const LOGIN = { username: USERNAME, password: PASSWORD };
let pg, env, call, cookie, realFetch;

beforeAll(async () => {
  pg = await makeDb();
  realFetch = globalThis.fetch;
  // The Functions reach the database through fetch: send those calls to the local one.
  globalThis.fetch = dbFetch(pg, DB, realFetch);
  env = {
    SUPABASE_URL: DB, SUPABASE_SERVICE_ROLE_KEY: LOCAL_KEY, SESSION_SECRET: 'x'.repeat(40),
    DASHBOARD_USERNAME: USERNAME, DASHBOARD_PASSWORD: await hashPassword(PASSWORD, 1000), REVENUECAT_WEBHOOK_AUTH: 'webhook-secret-for-tests',
  };
  call = pages(env);
});

const mockSync = (opts = {}) => {
  const games = mockGames(loadGames()), fake = mockFetch();
  return sync({ what: 'all', games, days: 70, env: { ...mockEnv(games), SUPABASE_URL: DB, SUPABASE_SERVICE_ROLE_KEY: LOCAL_KEY }, fetchImpl: dbFetch(pg, DB, fake), queryGameDb: mockGameDb, pause: 0, ...opts });
};

test('a password matches only its own hash, and a plain password in the variable matches nothing', async () => {
  const hash = await hashPassword(PASSWORD, 1000);
  expect(hash).toMatch(/^pbkdf2-sha256\$1000\$/);
  expect(await verifyPassword(PASSWORD, hash)).toBe(true);
  expect(await verifyPassword(PASSWORD + '!', hash)).toBe(false);
  expect(await verifyPassword(PASSWORD, PASSWORD)).toBe(false);
  expect(await verifyPassword('', hash)).toBe(false);
});

test('a session is good until it runs out, and not once changed or signed with another key', async () => {
  const key = signingKey(env), now = Date.now();
  const token = await makeSession(key, now);
  expect(await readSession(key, token, now)).toBeTruthy();
  expect(await readSession(key, token, now + 15 * 86400000)).toBeNull();
  expect(await readSession(key, token.replace(/^v1\.\d+/, `v1.${Math.floor(now / 1000) + 9e6}`), now)).toBeNull();
  expect(await readSession(signingKey({ ...env, SESSION_SECRET: 'y'.repeat(40) }), token, now)).toBeNull();
  expect(signingKey({ SESSION_SECRET: 'short', DASHBOARD_PASSWORD: env.DASHBOARD_PASSWORD })).toBe('');
  expect(signingKey({ SESSION_SECRET: 'x'.repeat(40), DASHBOARD_PASSWORD: 'plain text' })).toBe('');
  // Changing the username signs everyone out, and with none set nothing is signed.
  expect(await readSession(signingKey({ ...env, DASHBOARD_USERNAME: 'someone-else' }), token, now)).toBeNull();
  expect(signingKey({ ...env, DASHBOARD_USERNAME: '' })).toBe('');
  expect(signingKey({ ...env, DASHBOARD_USERNAME: 'two words' })).toBe('');
});

test('a username matches in any case, and nothing matches when none is set', async () => {
  expect(await verifyUsername('owner', env)).toBe(true);
  expect(await verifyUsername('  OWNER ', env)).toBe(true);
  expect(await verifyUsername('owner2', env)).toBe(false);
  expect(await verifyUsername('', env)).toBe(false);
  expect(await verifyUsername(undefined, env)).toBe(false);
  expect(await verifyUsername('', { DASHBOARD_USERNAME: '' })).toBe(false);
  expect(await verifyUsername('x', {})).toBe(false);
});

test('every data route answers 401 without a session', async () => {
  for (const path of ['/api/overview', '/api/overview?range=7d', '/api/game/pearl-tide', '/api/game/nope', '/api/anything-else']) {
    const r = await call(path);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthorized' });
    expect(r.headers.get('cache-control')).toBe('no-store');
  }
  expect(await (await call('/api/session')).json()).toEqual({ authenticated: false });
  expect((await call('/api/overview', { headers: { cookie: `${COOKIE}=v1.9999999999.abc.def` } })).status).toBe(401);
});

test('login refuses a wrong username, a wrong password and another site, and sets an HttpOnly, Secure, SameSite=Lax cookie for the right pair', async () => {
  const wrongPass = await call('/api/login', { method: 'POST', body: { username: USERNAME, password: 'wrong' } });
  expect(wrongPass.status).toBe(401);
  const wrongUser = await call('/api/login', { method: 'POST', body: { username: 'intruder', password: PASSWORD } });
  expect(wrongUser.status).toBe(401);
  // The answer is the same for both, so it never says which one was wrong.
  expect(await wrongUser.json()).toEqual(await wrongPass.json());
  expect(wrongUser.headers.get('set-cookie')).toBeNull();
  expect((await call('/api/login', { method: 'POST', body: { password: PASSWORD } })).status).toBe(401);
  expect((await call('/api/login', { method: 'POST', body: 'not json' })).status).toBe(400);
  expect((await call('/api/login', { method: 'POST', body: LOGIN, headers: { origin: 'https://evil.test' } })).status).toBe(403);
  expect((await call('/api/login')).status).toBe(405);
  const r = await call('/api/login', { method: 'POST', body: { username: 'owner', password: PASSWORD }, headers: { origin: 'https://dash.test' } });
  expect(r.status).toBe(200);
  const set = r.headers.get('set-cookie');
  expect(set).toMatch(new RegExp(`^${COOKIE}=v1\\.`));
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(set).toContain(attr);
  expect(JSON.stringify(await r.json())).not.toContain(PASSWORD);
  cookie = set.split(';')[0];
  expect(await (await call('/api/session', { headers: { cookie } })).json()).toEqual({ authenticated: true });
});

test('before any sync, every game draws empty states and nothing throws', async () => {
  const r = await call('/api/overview?range=30d', { headers: { cookie } });
  expect(r.status).toBe(200);
  const o = await r.json();
  expect(o.games.map((g) => g.game.slug)).toEqual(['pearl-tide', 'chillwater-lake', 'game-3', 'game-4']);
  expect(o.games.map((g) => g.game.status)).toEqual(['live', 'in_review', 'prelaunch', 'prelaunch']);
  expect(o.revenue_by_game.empty).toBeTruthy();
  for (const g of o.games) for (const k of g.kpis) { expect(k.value).toBeNull(); expect(k.empty.badge).toBeTruthy(); }
});

test('a sync fills the live platform only, and records why the rest were skipped', async () => {
  const { runs } = await mockSync();
  const by = (slug, source) => runs.find((r) => r.game_slug === slug && r.source === source);
  for (const s of ['listing', 'revenuecat', 'posthog', 'apple', 'supabase_game']) expect(by('pearl-tide', s).status).toBe('ok');
  expect(by('pearl-tide', 'google').status).toBe('skipped');
  expect(by('pearl-tide', 'google').message).toMatch(/Android is not live/);
  for (const slug of ['chillwater-lake', 'game-3', 'game-4']) for (const r of runs.filter((x) => x.game_slug === slug)) {
    expect(r.status).toBe('skipped');
    expect(r.message).toMatch(/No live platform/);
  }
  const platforms = await pg.query(`select game_slug, platform, count(*)::int as n from metrics_daily group by 1, 2 order by 1, 2`);
  expect(platforms.rows.map((r) => `${r.game_slug}/${r.platform}`)).toEqual(['pearl-tide/all', 'pearl-tide/ios']);
});

test('the live game has every chart; games in review and before launch have clean empty states', async () => {
  const pt = await (await call('/api/game/pearl-tide?range=30d', { headers: { cookie } })).json();
  expect(pt.state).toBe('live');
  expect(pt.kpis.map((k) => k.id)).toEqual(['revenue', 'installs', 'dau', 'retention', 'stability', 'conversion']);
  for (const k of pt.kpis) { expect(k.value).not.toBeNull(); expect(k.empty).toBeNull(); }
  expect(pt.kpis[0].delta).toBeTruthy();
  expect(pt.charts.revenue.dates.length).toBe(30);
  expect(pt.charts.revenue.revenue.length).toBe(30);
  expect(pt.charts.players.series.map((s) => s.id)).toEqual(['downloads', 'new', 'active', 'returning']);
  expect(pt.charts.retention.points[0]).toMatchObject({ day: 0, rate: 1 });
  expect(pt.charts.retention.points.map((p) => p.day)).toEqual([0, 1, 3, 7, 14, 30]);
  expect(pt.charts.ftue.steps[0]).toMatchObject({ key: '01_Loaded', label: 'Loaded', share: 1 });
  expect(pt.charts.products.items.length).toBeGreaterThan(0);
  expect(pt.sync.map((s) => `${s.source}:${s.state}`)).toEqual(['revenuecat:ok', 'posthog:ok', 'apple:ok', 'google:waiting', 'listing:ok', 'supabase_game:ok']);
  expect(pt.sync[0].last_ok).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(pt.nav.length).toBe(4);

  const android = await (await call('/api/game/pearl-tide?platform=android', { headers: { cookie } })).json();
  expect(android.state).toBe('in_review');
  for (const c of Object.values(android.charts)) expect(c.empty).toMatchObject({ badge: 'In review', text: 'No live data yet' });

  for (const [slug, badge] of [['chillwater-lake', 'In review'], ['game-3', 'Pre-launch'], ['game-4', 'Pre-launch']]) {
    for (const q of ['', '?range=7d&platform=ios', '?range=90d&platform=android']) {
      const r = await call(`/api/game/${slug}${q}`, { headers: { cookie } });
      expect(r.status).toBe(200);
      const v = await r.json();
      expect(v.has_data).toBe(false);
      for (const k of v.kpis) { expect(k.value).toBeNull(); expect(k.delta).toBeNull(); expect(['In review', 'Pre-launch']).toContain(k.empty.badge); }
      for (const c of Object.values(v.charts)) expect(c.empty.text).toBe('No live data yet');
      if (!q) for (const c of Object.values(v.charts)) expect(c.empty.badge).toBe(badge);
      for (const x of Object.values(v.extras)) expect(x).toBeNull();
      for (const s of v.sync) expect(s.state).toBe('waiting');
    }
  }
  expect((await call('/api/game/nope', { headers: { cookie } })).status).toBe(404);
  expect((await call('/api/game/..%2Fsecrets', { headers: { cookie } })).status).toBe(404);
});

test('today, the listing, ranks, downloads, stories and benchmarks come on one clock with testers left out', async () => {
  const zone = 'America/Los_Angeles', { from, to } = rangeDates('30d');
  expect(to).toBe(dayIn(Date.now(), zone));
  const pt = await (await call('/api/game/pearl-tide?range=30d', { headers: { cookie } })).json();
  expect(pt.clock).toEqual({ zone, name: 'Pacific time' });
  expect(pt.from).toBe(from);

  // Today so far: the day is the reporting zone's, and the news says what was left out.
  expect(pt.today.date).toBe(to);
  expect(pt.today.day_started).toBe(new Date(dayStart(to, zone)).toISOString());
  expect(pt.today.now.active).toBeGreaterThanOrEqual(pt.today.now.returning);
  expect(pt.today.last24h.active).toBeGreaterThanOrEqual(pt.today.last24h.new);
  expect(pt.today.all_time.value).toBeGreaterThan(0);
  expect(pt.today.news.length).toBeGreaterThan(4);
  expect(pt.today.news.some((l) => /testers? .* left out/.test(l))).toBe(true);

  // New players a day are the customers the mock made for that day: its testers are not among them.
  const news = pt.charts.players.series.find((s) => s.id === 'new').values, at = pt.charts.players.dates.indexOf(addDays(to, -3));
  expect(news[at]).toBe(mockDay('pearl-tide', 'ios', addDays(to, -3)).newUsers);
  expect(pt.charts.players.dates.at(-1)).toBe(to);

  // Downloads since launch only go up, and the marks are days since launch.
  const d = pt.charts.downloads, known = d.cumulative.filter((v) => v != null);
  expect(known.every((v, i) => i === 0 || v >= known[i - 1])).toBe(true);
  expect(d.total).toBeGreaterThanOrEqual(known.at(-1));
  expect(d.days_live).toBe(d.dates.length);
  expect(d.marks.map((m) => m.day)).toEqual([1, 7, 14, 30, 60, 90].filter((n) => n <= d.days_live));

  // The store listing: a rating, the version waiting, the written reviews.
  const l = pt.extras.listing;
  expect(l.rating).toBeGreaterThan(1); expect(l.rating).toBeLessThanOrEqual(5);
  expect(l.rating_count).toBe(l.by_storefront.reduce((a, s) => a + s.count, 0));
  expect(l.pending[0]).toMatchObject({ version: '1.3.8', label: 'Waiting for review', release: 'manual' });
  expect(l.version).toBe('1.3.7');
  expect(l.reviews.length).toBe(l.reviews_total);

  // A rank a search term, in the order config/games.json lists them.
  const terms = loadGames().find((g) => g.slug === 'pearl-tide').search_terms;
  expect(pt.charts.ranks.series.map((s) => s.term)).toEqual(terms);
  for (const s of pt.charts.ranks.series) { expect(s.now).toBeGreaterThan(0); expect(s.values.at(-1)).toBe(s.now); }

  // The last 48 hours, and what players did, with no analytics id anywhere in the answer.
  expect(pt.extras.hourly.series.map((s) => s.id)).toEqual(['new', 'active']);
  expect(pt.extras.hourly.hours.length).toBe(48);
  const told = pt.extras.stories.players;
  expect(told.length).toBeGreaterThan(3);
  for (const p of told) { expect(p.tag).toMatch(/^[0-9A-F]{5}$/); expect(p.head).toMatch(/^(New|Returning) player/); expect(p.lines.length).toBeGreaterThan(0); }
  expect(JSON.stringify(pt)).not.toMatch(/distinct_id|mock-player|app_user_id|\$RCAnonymousID/);

  // Against the average: every row has a typical figure and a source; the live game has its own number on each.
  const rows = pt.extras.benchmarks.rows;
  expect(rows.map((r) => r.id)).toEqual(['page_to_download', 'impression_to_page', 'impression_to_download', 'd1', 'd7', 'd30', 'first_month']);
  for (const r of rows) { expect(r.typical).toBeGreaterThan(0); expect(r.url).toMatch(/^https:\/\//); expect(r.value).not.toBeNull(); expect(r.verdict).toBeTruthy(); expect(['good', 'flat', 'bad']).toContain(r.tone); }

  // On Android, which is not live, none of it shows.
  const android = await (await call('/api/game/pearl-tide?platform=android', { headers: { cookie } })).json();
  expect(android.today).toBeNull();
});

test('a reporting day starts at the zone\'s midnight, on either side of a clock change', () => {
  const zone = 'America/Los_Angeles';
  expect(dayIn(Date.parse('2026-11-25T07:59:59Z'), zone)).toBe('2026-11-24');
  expect(dayIn(Date.parse('2026-11-25T08:00:00Z'), zone)).toBe('2026-11-25');
  expect(dayStart('2026-11-25', zone)).toBe(Date.parse('2026-11-25T08:00:00Z'));
  expect(dayStart('2026-07-01', zone)).toBe(Date.parse('2026-07-01T07:00:00Z'));
  expect(dayStart('2026-11-01', zone)).toBe(Date.parse('2026-11-01T07:00:00Z')); // the day the clocks go back
  expect(dayStart('2026-11-02', zone)).toBe(Date.parse('2026-11-02T08:00:00Z'));
  expect(dayStart('2026-11-25')).toBe(Date.parse('2026-11-25T00:00:00Z'));
});

test('a player\'s events read as a short story, under a tag that is not their id', () => {
  const since = Date.parse('2026-11-25T08:00:00Z'), id = '$RCAnonymousID:0123456789abcdef';
  const e = (event, n = 1, sum = 0) => ({ event, n, sum, max: sum });
  const p = tell({ id, platform: 'ios', version: '1.3.8', country: 'US', first: since + 60000, last: since + 30 * 60000, events: [
    e('Session:Open:1'), e('Device:Screen:390x844_3'), e('Load:Ready', 1, 21), e('Load:ContextLost', 2), e('FTUE:03_Swam'), e('FTUE:07_Out'),
    e('Area:Sea', 3, 600), e('Area:House', 1, 240), e('Quest:Offer:net', 2), e('Quest:Accept:net'), e('Quest:Done:net'), e('Runway:Open'), e('Runway:Rate', 6),
    e('Shop:Open', 2), e('Store:Tap:pearls.handful'), e('Store:Cancel:pearls.handful'), e('Session:UncleanExit:Loading'), e('Photo:Taken', 3),
  ] }, since);
  expect(p.tag).toBe(tagOf(id)); expect(p.tag).toMatch(/^[0-9A-F]{5}$/); expect(JSON.stringify(p)).not.toContain('0123456789abcdef');
  expect(p.new).toBe(true);
  expect(p.head).toBe('New player on iPhone or iPad, version 1.3.8, US, 390 × 844 screen at 3×');
  expect(p.lines).toContain('Loaded in 21.0 s.');
  expect(p.lines).toContain('First-time steps: reached 7, Out.');
  expect(p.lines).toContain('Played 14 min: Sea 10 min, House 4 min.');
  expect(p.lines).toContain('Quests: 1 accepted, 1 finished.');
  expect(p.lines).toContain('Runway: opened it, rated 6 looks.');
  expect(p.lines.some((l) => l.startsWith('Shop: opened 2 times, tapped a price (pearls.handful), cancelled'))).toBe(true);
  expect(p.lines).toContain('Also: Photo ×3.');
  expect(p.flags).toEqual(['Slow load', 'Lost the graphics context 2 times', 'Closed without a clean exit while loading']);
  const back = tell({ id, platform: 'android', version: '1.3.7', country: 'CA', first: since - 86400000, last: since + 1000, events: [e('Session:Open:4')] }, since);
  expect(back.head).toBe('Returning player, launch 4 on Android, version 1.3.7, CA');
  expect(back.lines).toEqual(['Opened the game; nothing else recorded yet.']);
});

test('no change is shown against a period that is mostly before launch', () => {
  const now = Date.parse('2026-11-25T20:00:00Z'), { from, to } = rangeDates('30d', now);
  const game = (launched) => ({ slug: 'g', display_name: 'G', status: 'live', config: { platforms: { ios: { status: 'live', launched } } } });
  const tot = { sum: 30, avg: 1, last: 1, n: 30 }, raw = (launched) => ({ game: game(launched), platform: 'all', from, to, totals: { 'revenuecat.revenue': tot }, prev: { 'revenuecat.revenue': { ...tot, sum: 10 } }, series: {}, hourly: {}, cohorts: [], sync: [] });
  expect(buildGame(raw(addDays(from, -5)), { range: '30d', now }).kpis[0].delta).toBeNull();
  expect(buildGame(raw(addDays(from, -29)), { range: '30d', now }).kpis[0].delta).toMatchObject({ value: 200, dir: 1 });
  expect(buildGame(raw(null), { range: '30d', now }).kpis[0].delta).toMatchObject({ value: 200 });
});

test('the overview adds the games up and takes bad parameters as the defaults', async () => {
  const o = await (await call('/api/overview?range=nonsense', { headers: { cookie } })).json();
  expect(o.range).toBe('30d');
  expect(o.totals.map((t) => t.id)).toEqual(['revenue', 'installs', 'dau', 'live']);
  expect(o.totals[0].value).toBeGreaterThan(0);
  expect(o.totals[3]).toMatchObject({ value: 1, of: 4 });
  expect(o.revenue_by_game.series.map((s) => s.slug)).toEqual(['pearl-tide']);
  const text = JSON.stringify(o);
  for (const secret of [LOCAL_KEY, env.SESSION_SECRET, env.DASHBOARD_PASSWORD, 'mock-pearl-tide']) expect(text).not.toContain(secret);
});

test('the webhook needs its secret, counts a production sale once, and ignores sandbox ones', async () => {
  const event = { id: 'evt-1', type: 'NON_RENEWING_PURCHASE', environment: 'PRODUCTION', store: 'APP_STORE', price: 4.99, product_id: 'pearls.pouch', purchased_at_ms: Date.now(), commission_percentage: 0.3, tax_percentage: 0 };
  expect(saleOf({ ...event, environment: 'SANDBOX' })).toBeNull();
  expect(saleOf({ ...event, type: 'CANCELLATION' })).toBeNull();
  expect(saleOf(event).metrics).toMatchObject({ revenue: 4.99, transactions: 1, proceeds: 3.493, 'revenue_by_product:pearls.pouch': 4.99 });
  const post = (headers, body = { event }) => call('/api/webhooks/revenuecat?game=pearl-tide', { method: 'POST', headers, body });
  expect((await post({})).status).toBe(401);
  expect((await post({ authorization: 'wrong' })).status).toBe(401);
  const before = (await rpc(pg, 'dashboard_game', { p_slug: 'pearl-tide', p_platform: 'ios', ...span() })).totals['revenuecat.revenue'].sum;
  expect(await (await post({ authorization: env.REVENUECAT_WEBHOOK_AUTH })).json()).toEqual({ ok: true, counted: true });
  expect(await (await post({ authorization: env.REVENUECAT_WEBHOOK_AUTH })).json()).toEqual({ ok: true, counted: false });
  expect(await (await post({ authorization: env.REVENUECAT_WEBHOOK_AUTH }, { event: { ...event, id: 'evt-2', environment: 'SANDBOX' } })).json()).toEqual({ ok: true, counted: false });
  const after = (await rpc(pg, 'dashboard_game', { p_slug: 'pearl-tide', p_platform: 'ios', ...span() })).totals['revenuecat.revenue'].sum;
  expect(after - before).toBeCloseTo(4.99, 5);
  // The next pull never lowers the day in progress below what the webhook counted.
  await mockSync({ what: 'revenuecat' });
  const again = (await rpc(pg, 'dashboard_game', { p_slug: 'pearl-tide', p_platform: 'ios', ...span() })).totals['revenuecat.revenue'].sum;
  expect(again).toBeGreaterThanOrEqual(after - 1e-9);
});
const span = () => { const { from, to } = rangeDates('30d'); return { p_from: from, p_to: to }; };

test('a change is a percentage for counts and points for rates, and says which way is good', () => {
  expect(change(120, 100)).toMatchObject({ value: 20, unit: 'pct', dir: 1, good: true });
  expect(change(0.02, 0.03, true, { pp: true, upGood: false })).toMatchObject({ unit: 'pp', dir: -1, good: true });
  expect(change(5, 0)).toMatchObject({ unit: 'new', value: null });
  expect(change(5, 4, false)).toBeNull();
  expect(change(null, 4)).toBeNull();
});

test('retention counts the players whose day N fell inside the range', () => {
  const now = Date.parse('2026-11-25T12:00:00Z'), { from, to } = rangeDates('7d', now);
  const cohorts = [];
  for (let d = addDays(from, -40); d <= to; d = addDays(d, 1)) cohorts.push([d, { new_users: 10, retained_d1: 4, retained_d7: 2 }]);
  const v = buildGame({ game: { slug: 'g', display_name: 'G', status: 'live', config: { platforms: { ios: { status: 'live' } } } }, platform: 'all', from, to, totals: {}, prev: {}, series: {}, hourly: {}, cohorts, sync: [] }, { range: '7d', now });
  const k = v.kpis.find((x) => x.id === 'retention');
  expect(k.value).toBeCloseTo(0.4, 9);
  expect(k.value2).toBeCloseTo(0.2, 9);
  expect(k.sub[0].value).toBe(60); // six whole cohorts
  expect(k.delta).toMatchObject({ unit: 'pp', dir: 0 });
});

test('the eleventh login attempt in fifteen minutes is turned away', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await call('/api/login', { method: 'POST', body: { username: USERNAME, password: 'wrong' }, headers: { 'cf-connecting-ip': '203.0.113.9' } });
  expect(last.status).toBe(429);
  expect((await call('/api/login', { method: 'POST', body: LOGIN, headers: { 'cf-connecting-ip': '203.0.113.9' } })).status).toBe(429);
  expect((await call('/api/login', { method: 'POST', body: LOGIN, headers: { 'cf-connecting-ip': '198.51.100.7' } })).status).toBe(200);
});

test('with nothing configured the API fails closed', async () => {
  const bare = pages({});
  expect((await bare('/api/overview')).status).toBe(401);
  expect((await bare('/api/login', { method: 'POST', body: LOGIN })).status).toBe(503);
  // A password with no username set is not enough.
  expect((await pages({ ...env, DASHBOARD_USERNAME: '' })('/api/login', { method: 'POST', body: LOGIN })).status).toBe(503);
  expect((await bare('/api/webhooks/revenuecat?game=pearl-tide', { method: 'POST', body: {} })).status).toBe(503);
  const noDb = pages({ ...env, SUPABASE_URL: '' });
  expect((await noDb('/api/overview', { headers: { cookie } })).status).toBe(503);
});
