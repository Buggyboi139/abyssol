// End to end, with nothing outside this process: the real migrations in a
// local Postgres, the sync against stand-in APIs, and the Pages Functions.
import { test, expect, beforeAll } from 'bun:test';
import { makeDb, dbFetch, rpc, LOCAL_KEY } from '../scripts/localdb.mjs';
import { hashPassword, verifyPassword, makeSession, readSession, signingKey, COOKIE } from '../server/auth.js';
import { buildGame, change, rangeDates, addDays } from '../server/metrics.js';
import { saleOf } from '../functions/api/webhooks/revenuecat.js';
import { sync } from '../sync/run.mjs';
import { loadGames } from '../sync/lib/config.mjs';
import { mockFetch, mockEnv, mockGameDb } from '../sync/mock/fetch.mjs';
import { pages } from './pages.mjs';

const DB = 'http://db.test', PASSWORD = 'correct horse battery staple';
let pg, env, call, cookie, realFetch;

beforeAll(async () => {
  pg = await makeDb();
  realFetch = globalThis.fetch;
  // The Functions reach the database through fetch: send those calls to the local one.
  globalThis.fetch = dbFetch(pg, DB, realFetch);
  env = {
    SUPABASE_URL: DB, SUPABASE_SERVICE_ROLE_KEY: LOCAL_KEY, SESSION_SECRET: 'x'.repeat(40),
    DASHBOARD_PASSWORD: await hashPassword(PASSWORD, 1000), REVENUECAT_WEBHOOK_AUTH: 'webhook-secret-for-tests',
  };
  call = pages(env);
});

const mockSync = (opts = {}) => {
  const games = loadGames(), fake = mockFetch();
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

test('login refuses a wrong password and another site, and sets an HttpOnly, Secure, SameSite=Lax cookie for the right one', async () => {
  expect((await call('/api/login', { method: 'POST', body: { password: 'wrong' } })).status).toBe(401);
  expect((await call('/api/login', { method: 'POST', body: 'not json' })).status).toBe(400);
  expect((await call('/api/login', { method: 'POST', body: { password: PASSWORD }, headers: { origin: 'https://evil.test' } })).status).toBe(403);
  expect((await call('/api/login')).status).toBe(405);
  const r = await call('/api/login', { method: 'POST', body: { password: PASSWORD }, headers: { origin: 'https://dash.test' } });
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
  for (const s of ['revenuecat', 'posthog', 'apple', 'supabase_game']) expect(by('pearl-tide', s).status).toBe('ok');
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
  expect(pt.charts.audience.series.map((s) => s.id)).toEqual(['dau', 'installs']);
  expect(pt.charts.retention.points[0]).toMatchObject({ day: 0, rate: 1 });
  expect(pt.charts.retention.points.map((p) => p.day)).toEqual([0, 1, 3, 7, 14, 30]);
  expect(pt.charts.ftue.steps[0]).toMatchObject({ key: '01_Loaded', label: 'Loaded', share: 1 });
  expect(pt.charts.products.items.length).toBeGreaterThan(0);
  expect(pt.sync.map((s) => `${s.source}:${s.state}`)).toEqual(['revenuecat:ok', 'posthog:ok', 'apple:ok', 'google:waiting', 'supabase_game:ok']);
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
  for (let i = 0; i < 12; i++) last = await call('/api/login', { method: 'POST', body: { password: 'wrong' }, headers: { 'cf-connecting-ip': '203.0.113.9' } });
  expect(last.status).toBe(429);
  expect((await call('/api/login', { method: 'POST', body: { password: PASSWORD }, headers: { 'cf-connecting-ip': '203.0.113.9' } })).status).toBe(429);
  expect((await call('/api/login', { method: 'POST', body: { password: PASSWORD }, headers: { 'cf-connecting-ip': '198.51.100.7' } })).status).toBe(200);
});

test('with nothing configured the API fails closed', async () => {
  const bare = pages({});
  expect((await bare('/api/overview')).status).toBe(401);
  expect((await bare('/api/login', { method: 'POST', body: { password: PASSWORD } })).status).toBe(503);
  expect((await bare('/api/webhooks/revenuecat?game=pearl-tide', { method: 'POST', body: {} })).status).toBe(503);
  const noDb = pages({ ...env, SUPABASE_URL: '' });
  expect((await noDb('/api/overview', { headers: { cookie } })).status).toBe(503);
});
