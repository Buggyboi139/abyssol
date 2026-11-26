// End to end, with nothing outside this process: the real migrations in a
// local Postgres, the sync against stand-in APIs, and the Pages Functions.
import { test, expect, beforeAll } from 'bun:test';
import { makeDb, dbFetch, rpc, LOCAL_KEY } from '../scripts/localdb.mjs';
import { hashPassword, verifyPassword, verifyUsername, makeSession, readSession, signingKey, COOKIE } from '../server/auth.js';
import { buildGame, dates, change, rangeDates, addDays, RANGES } from '../server/metrics.js';
import { saleOf } from '../functions/api/webhooks/revenuecat.js';
import { sync } from '../sync/run.mjs';
import { loadGames } from '../sync/lib/config.mjs';
import { RANGES as SYNC_RANGES } from '../sync/lib/util.mjs';
import { run as revenuecatRun } from '../sync/sources/revenuecat.mjs';
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

test('an App Store analytics day is read once from its newest file, and the processing day is not filled with zeros', async () => {
  const today = dayIn(Date.now(), 'America/Los_Angeles');
  const got = await pg.query(`select date::text as date, metric_key, metric_value::float8 as v from metrics_daily where game_slug = 'pearl-tide' and source = 'apple' and platform = 'ios' and metric_key in ('an_downloads', 'an_downloads_direct', 'impressions', 'page_views', 'downloads') order by date`);
  const at = (k, d) => got.rows.find((r) => r.metric_key === k && r.date === d)?.v ?? null;
  // Every file restates two days, so each day arrives in two files: it is one day's count, not their sum.
  for (const back of [3, 4, 10]) {
    const d = addDays(today, -back), x = mockDay('pearl-tide', 'ios', d);
    expect(at('an_downloads', d)).toBe(x.newUsers);
    expect(at('impressions', d)).toBe(x.newUsers * 40);
    expect(at('page_views', d)).toBe(x.newUsers * 4); // the listing's own views: not the looks at its screenshots, nor the developer page
    expect(at('an_downloads_direct', d)).toBe(Math.floor(x.newUsers * 0.4));
  }
  // The newest file is stamped yesterday and carries the two days before it: yesterday has no analytics row yet.
  expect(at('an_downloads', addDays(today, -2))).not.toBeNull();
  for (const k of ['an_downloads', 'impressions', 'page_views']) expect(at(k, addDays(today, -1))).toBeNull();
});

test('the live game has every chart; games in review and before launch have clean empty states', async () => {
  const pt = await (await call('/api/game/pearl-tide?range=30d', { headers: { cookie } })).json();
  expect(pt.state).toBe('live');
  expect(pt.kpis.map((k) => k.id)).toEqual(['revenue', 'installs', 'dau', 'retention', 'stability', 'conversion']);
  for (const k of pt.kpis) { expect(k.value).not.toBeNull(); expect(k.empty).toBeNull(); expect(k.rule.length).toBeGreaterThan(20); expect(k.source).toBeTruthy(); }
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

  // Today so far: the day is the reporting zone's, in numbers and short labels, with no sentences to read.
  expect(pt.today.date).toBe(to);
  expect(pt.today.day_started).toBe(new Date(dayStart(to, zone)).toISOString());
  expect(pt.today.now.active).toBeGreaterThanOrEqual(pt.today.now.returning);
  expect(pt.today.last24h.active).toBeGreaterThanOrEqual(pt.today.last24h.new);
  expect(pt.today.all_time.value).toBeGreaterThan(0);
  expect(pt.today.news).toBeUndefined();
  expect(pt.today.testers_out).toBeGreaterThan(0);
  expect(pt.today.countries.length).toBeGreaterThan(0); for (const c of pt.today.countries) { expect(c.cc).toMatch(/^[A-Z]{2}$/); expect(c.active).toBeGreaterThan(0); }
  for (const v of pt.today.versions) { expect(v.version).toMatch(/^\d/); expect(v.active).toBeGreaterThan(0); }
  expect(pt.today.store).toMatchObject({ name: 'App Store' }); expect(pt.today.store.version).toMatch(/^\d/); expect(Array.isArray(pt.today.store.pending)).toBe(true);
  expect(pt.today.rating.count).toBeGreaterThan(0); expect(pt.today.rating.value).toBeGreaterThan(0);

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
  for (const p of told) { expect(p.tag).toMatch(/^[0-9A-F]{5}$/); expect(p.head).toMatch(/^(New|Returning) player/); expect(p.lines.length).toBeGreaterThan(0); expect(Array.isArray(p.facts.marks)).toBe(true); expect(Array.isArray(p.facts.areas)).toBe(true); }
  expect(pt.extras.stories.ftue_steps).toBeGreaterThan(1);
  expect(JSON.stringify(pt)).not.toMatch(/distinct_id|mock-player|app_user_id|\$RCAnonymousID/);

  // Against the average: every row has an average or a usual range, how ours is worked out, and where the average comes from.
  const rows = pt.extras.benchmarks.rows;
  expect(rows.map((r) => r.id)).toEqual(['downloads_month', 'store_conversion', 'page_to_download', 'search_clicks', 'd1', 'd7', 'd30', 'session_length', 'paying_players', 'revenue_month']);
  expect(pt.extras.benchmarks.groups).toEqual(['Getting found', 'Playing', 'Paying']);
  for (const r of rows) {
    expect(r.average != null || (r.low != null && r.high != null)).toBe(true); expect(r.where.length).toBeGreaterThan(20); expect(r.url).toMatch(/^https:\/\//);
    if (r.value == null) { expect(r.need).toBeTruthy(); expect(r.verdict).toBeNull(); expect(r.short).toBeNull(); } else { expect(r.how).toBeTruthy(); expect(r.verdict).toBeTruthy(); expect(r.short.length).toBeLessThan(14); expect(['good', 'flat', 'bad']).toContain(r.tone); }
  }

  // Graphics levels: each player once (the posthog.gfx fact), fewer than the daily rows, which count a player every day they play.
  expect(pt.extras.gfx.unit).toBe('players');
  const shares = [0.05, 0.3, 0.2, 0.25, 0.15, 0.05], range = dates(from, to);
  expect(pt.extras.gfx.levels.map((l) => l.players)).toEqual(shares.map((s) => range.reduce((a, d) => a + Math.round(mockDay('pearl-tide', 'ios', d).newUsers * s), 0)));
  const playerDays = await pg.query(`select sum(metric_value)::float8 as v from metrics_daily where game_slug = 'pearl-tide' and platform = 'all' and source = 'posthog' and metric_key like 'gfx_level:%' and date between $1 and $2`, [from, to]);
  expect(pt.extras.gfx.levels.reduce((a, l) => a + l.players, 0)).toBeLessThan(playerDays.rows[0].v);
  // Conversion: an install day counts only the players who have had 7 days, so the last week reads zero and older days are whole.
  const conv = await pg.query(`select date::text as date, metric_value::float8 as v from metrics_daily where game_slug = 'pearl-tide' and platform = 'all' and source = 'revenuecat' and metric_key = 'conv_cohort_size'`);
  const cohort = (d) => conv.rows.find((r) => r.date === d)?.v;
  for (const back of [0, 1, 5]) expect(cohort(addDays(to, -back))).toBe(0);
  for (const back of [9, 20]) expect(cohort(addDays(to, -back))).toBe(mockDay('pearl-tide', 'ios', addDays(to, -back)).newUsers);
  expect(pt.kpis.find((k) => k.id === 'conversion').sub[1].label).toBe('players at day 7');
  // Apple's unique counts are stored so store conversion, page-to-download, and search clicks count unique devices.
  expect((await pg.query(`select count(*)::int as n from metrics_daily where metric_key like '%\\_unique'`)).rows[0].n).toBeGreaterThan(0);

  // The store funnel starts at the shop opening (Shop:Open in Pearl Tide, Store:Open in Chillwater Lake).
  expect(pt.extras.store.steps.map((x) => x.key).slice(0, 2)).toEqual(['Open', 'Tap']);
  expect(pt.extras.store.steps[0].count).toBeGreaterThan(pt.extras.store.steps[1].count);

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
  // The same story as tokens for the page: numbers and short labels, each flag with its tone.
  expect(p.facts).toMatchObject({ load_secs: 21, ftue: { step: 7, name: 'Out' }, screen: '390 × 844', areas: [{ name: 'Sea', secs: 600 }, { name: 'House', secs: 240 }], quests: { accepted: 1, done: 1 }, runway: { opened: 1, rated: 6 }, shop: { opens: 2, taps: 1, cancels: 1, bought: [] } });
  expect(p.facts.marks).toEqual([{ label: 'Slow load', tone: 'warn' }, { label: 'Context lost ×2', tone: 'bad' }, { label: 'Unclean exit, loading', tone: 'bad' }]);
  expect(tell({ id, platform: 'ios', version: '1', country: '', first: since - 86400000, last: since + 1000, events: [e('Store:Bought:pearls.pouch'), e('App:Error', 2)] }, since).facts.marks).toEqual([{ label: 'Bought', tone: 'good' }, { label: 'App error ×2', tone: 'bad' }]);
  const back = tell({ id, platform: 'android', version: '1.3.7', country: 'CA', first: since - 86400000, last: since + 1000, events: [e('Session:Open:4')] }, since);
  expect(back.head).toBe('Returning player, launch 4 on Android, version 1.3.7, CA');
  expect(back.lines).toEqual(['Opened the game; nothing else recorded yet.']);

  // The fifth launch and later come as Session:Open:5plus, with the real count as the value when the game sends one.
  const fifth = (max) => tell({ id, platform: 'ios', version: '1.3.8', country: 'US', first: since - 86400000, last: since + 1000, events: [{ event: 'Session:Open:5plus', n: 1, sum: max, max }] }, since).head;
  expect(fifth(12)).toBe('Returning player, launch 12 on iPhone or iPad, version 1.3.8, US');
  expect(fifth(0)).toBe('Returning player, launch 5 or later on iPhone or iPad, version 1.3.8, US');

  // Pearl Tide sends the chapter as a property of Chapter:Complete; either game may put it in the name.
  const story = (events) => tell({ id, platform: 'ios', version: '1', country: '', first: since - 86400000, last: since + 1000, events }, since).lines;
  expect(story([{ ...e('Chapter:Start', 2), chapters: ['1', '2'] }, { ...e('Chapter:Complete'), chapters: ['1'] }])).toContain('Finished chapter 1, started 2.');
  expect(story([e('Chapter:Complete:3'), e('Chapter:Complete:10')])).toContain('Finished chapters 3 and 10.');
  expect(story([{ ...e('Chapter:Start'), chapters: ['2'] }])).toContain('Started chapter 2.');
  expect(story([e('Chapter:Complete', 2)])).toContain('Finished 2 chapters.');

  // Chillwater Lake's store: Store:Open as the sheet opens, Store:Buy:<product> at a buy button.
  const lake = story([e('Store:Open', 2, 80), e('Store:Buy:coins.small'), e('Store:Buy:rod.carbon'), e('Store:Cancel:coins.small')]);
  expect(lake).toContain('Shop: opened 2 times, tapped a price (coins.small and rod.carbon), cancelled.');
  expect(story([e('Store:Open'), e('Store:Buy:coins.small'), e('Store:Bought:coins.small')])).toContain('Bought coins.small.');
});

test('no change is shown against a period that is mostly before launch', () => {
  const now = Date.parse('2026-11-25T20:00:00Z'), { from, to } = rangeDates('30d', now);
  const game = (launched) => ({ slug: 'g', display_name: 'G', status: 'live', config: { platforms: { ios: { status: 'live', launched } } } });
  const tot = { sum: 30, avg: 1, last: 1, n: 30 }, raw = (launched) => ({ game: game(launched), platform: 'all', from, to, totals: { 'revenuecat.revenue': tot }, prev: { 'revenuecat.revenue': { ...tot, sum: 10 } }, series: {}, hourly: {}, cohorts: [], sync: [] });
  expect(buildGame(raw(addDays(from, -5)), { range: '30d', now }).kpis[0].delta).toBeNull();
  expect(buildGame(raw(addDays(from, -29)), { range: '30d', now }).kpis[0].delta).toMatchObject({ value: 200, dir: 1 });
  expect(buildGame(raw(null), { range: '30d', now }).kpis[0].delta).toMatchObject({ value: 200 });
});

test('without sales reports the App Store\'s analytics downloads stand in, and the store rates use them beside page views', () => {
  const now = Date.parse('2026-11-25T20:00:00Z'), { from, to } = rangeDates('30d', now);
  const game = { slug: 'g', display_name: 'G', status: 'live', config: { genre: 'simulation', platforms: { ios: { status: 'live', launched: addDays(from, -3) } } } };
  const days = dates(from, addDays(to, -2)), pts = (v) => days.map((d) => [d, v]), tot = (v) => ({ sum: v * days.length, avg: v, last: v, n: days.length });
  const raw = (more = {}) => ({ game, platform: 'all', from, to, prev: {}, hourly: {}, cohorts: [], sync: [],
    totals: { 'apple.an_downloads': tot(3), 'apple.page_views': tot(10), 'apple.impressions': tot(200), ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k, tot(v)])) },
    series: { 'apple.an_downloads': pts(3), ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k, pts(v)])) },
    life: { 'apple.an_downloads': pts(3), ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k, pts(v)])) } });
  const row = (g, id) => g.extras.benchmarks.rows.find((r) => r.id === id);

  const an = buildGame(raw(), { range: '30d', now });
  expect(an.charts.players.series[0]).toMatchObject({ id: 'downloads', label: 'First downloads · App Store' });
  expect(an.charts.downloads).toMatchObject({ source: 'App Store', total: 3 * days.length, note: null });
  // Without unique counts on record, store rates fall back to total counts and note it.
  expect(row(an, 'page_to_download').value).toBeCloseTo(0.3, 9); expect(row(an, 'store_conversion').value).toBeCloseTo(3 / 200, 9);
  expect(row(an, 'store_conversion').how).toContain('impressions'); expect(row(an, 'page_to_download').note).toContain('total page views');
  // Page to download matches AppTweak's benchmark (all first downloads ÷ unique page views), and notes direct search Get taps + page-only rate.
  const direct = buildGame(raw({ 'apple.an_downloads_direct': 1, 'apple.an_redownloads': 1, 'apple.page_views_search': 4, 'apple.impressions_search': 50 }), { range: '30d', now });
  expect(row(direct, 'page_to_download').value).toBeCloseTo(3 / 10, 9); expect(row(direct, 'page_to_download').note).toContain('tapped Get in search results'); expect(row(direct, 'page_to_download').note).toContain('page-only: 20%');
  expect(row(direct, 'store_conversion').value).toBeCloseTo((3 + 1) / 200, 9);
  expect(row(direct, 'search_clicks').value).toBeCloseTo(4 / 50, 9); expect(row(direct, 'search_clicks').how).toContain('impressions in search');
  // With Apple's unique counts present, all three store rates use unique counts (matched unique over unique on search clicks).
  const uniq = buildGame(raw({ 'apple.an_downloads_direct': 1, 'apple.an_redownloads': 1, 'apple.page_views_search': 4, 'apple.impressions_search': 50, 'apple.impressions_unique': 150, 'apple.page_views_unique': 5, 'apple.page_views_search_unique': 3, 'apple.impressions_search_unique': 30 }), { range: '30d', now });
  expect(row(uniq, 'store_conversion').value).toBeCloseTo((3 + 1) / 150, 9);
  expect(row(uniq, 'page_to_download').value).toBeCloseTo(3 / 5, 9); expect(row(uniq, 'page_to_download').note).toContain('page-only: 40%');
  expect(row(uniq, 'search_clicks').value).toBeCloseTo(3 / 30, 9);
  // The share of a day's players who had played before is not day 1 retention, and no longer stands in for it.
  expect(row(buildGame(raw({ 'revenuecat.returning_customers': 6, 'revenuecat.active_customers': 10 }), { range: '30d', now }), 'd1')).toMatchObject({ value: null, need: 'Needs PostHog' });
  // Total downloads in Against the average uses the real download total, never a 30-day pace projection.
  const youngGame = { slug: 'g', display_name: 'G', status: 'live', config: { genre: 'simulation', platforms: { ios: { status: 'live', launched: addDays(to, -18) } } } };
  const youngDays = dates(addDays(to, -18), addDays(to, -2)); // 17 official Apple days, 2 unposted tail days
  const youngRaw = {
    game: youngGame, platform: 'all', from, to, prev: {}, hourly: {}, cohorts: [], sync: [],
    totals: { 'apple.downloads': { sum: 17 * 8, avg: 8, last: 8, n: 17 }, 'revenuecat.new_customers': { sum: 17 * 10 + 14 + 12, avg: 10, last: 12, n: 19 } },
    series: { 'apple.downloads': youngDays.map((d) => [d, 8]), 'revenuecat.new_customers': [...youngDays.map((d) => [d, 10]), [addDays(to, -1), 14], [to, 12]] },
    life: { 'apple.downloads': youngDays.map((d) => [d, 8]), 'revenuecat.new_customers': [...youngDays.map((d) => [d, 10]), [addDays(to, -1), 14], [to, 12]] },
  };
  const youngView = buildGame(youngRaw, { range: '30d', now });
  // Official Apple (136) + real-time tail only for the 2 unposted days (14 + 12 = 26) = 162 — actuals never extrapolate.
  expect(youngView.charts.downloads.total).toBe(162);
  expect(youngView.charts.downloads.official_total).toBe(136);
  expect(youngView.charts.downloads.realtime_tail).toBe(26);
  expect(youngView.kpis.find((k) => k.id === 'installs').value).toBe(162);
  expect(row(youngView, 'downloads_month').value).toBe(162);
  // Projections live in their own clearly labeled panel (18 completed days: 17*8 + 14 = 150 -> 8.33/day; + 11 days left = 254).
  expect(youngView.extras.projected.tiles.find((t) => t.id === 'dl_30d')).toMatchObject({ label: 'First 30 days', value: Math.round(162 + (150 / 18) * 11), sub: 'projected · 11d left' });
  // Search clicks wait for the search-only counts; retention with no cohorts says what it needs.
  expect(row(an, 'search_clicks')).toMatchObject({ value: null, verdict: null, need: 'Comes with the next App Store sync', average: null });
  expect(row(an, 'd1')).toMatchObject({ value: null, need: 'Needs PostHog' });

  // Numbers read by hand from GameAnalytics fill retention, session length, playtime and the first-session funnel until PostHog has cohorts.
  const hand = { source: 'GameAnalytics', read_at: '2026-01-02', retention: { d1: { back: 11, size: 50, cohorts: 'Jan 1' }, note: 'A note.' }, session: { secs: 600, sessions: 40, per_player_day_secs: 1200, player_days: 20 }, ftue: [{ key: '01_Loaded', players: 50 }, { key: '02_Wardrobe', players: 40 }] };
  const peers = { week: 'the week of January 1', group: 'Simulation', store_conversion: { p25: 0.01, p50: 0.03, p75: 0.05 }, proceeds_per_payer: { p25: 4, p50: 8, p75: 16 } };
  const byHand = buildGame({ ...raw({ 'apple.impressions_unique': 150 }), facts: { 'manual.gameanalytics': { value: hand, at: now }, 'manual.apple_peers': { value: peers, at: now } } }, { range: '30d', now });
  expect(row(byHand, 'd1')).toMatchObject({ verdict: 'About average', short: 'Typical', tone: 'flat' }); expect(row(byHand, 'd1').value).toBeCloseTo(0.22);
  expect(row(byHand, 'd1').how).toContain('GameAnalytics, read 2026-01-02'); expect(row(byHand, 'd1').note).toContain('Fewer than 100 players');
  expect(row(byHand, 'd7').need).toBe('No players 7 days old yet');
  expect(row(byHand, 'session_length')).toMatchObject({ value: 600, format: 'mins' }); expect(row(byHand, 'playtime').value).toBe(1200);
  expect(byHand.charts.retention).toMatchObject({ source: 'GameAnalytics, read 2026-01-02' }); expect(byHand.charts.retention.points.map((p) => p.day)).toEqual([0, 1]);
  // Apple's peer percentiles, kept as a fact, take the place of the published average.
  expect(row(an, 'store_conversion')).toMatchObject({ percentiles: false, average: 0.011 }); expect(row(an, 'proceeds_per_payer')).toBeUndefined();
  expect(row(byHand, 'store_conversion')).toMatchObject({ percentiles: true, average: 0.03, low: 0.01, high: 0.05, verdict: 'Between the 25th and 50th percentile', short: '25th–50th', source: 'App Store Connect peer benchmarks' });
  expect(row(byHand, 'store_conversion').where).toContain('the week of January 1'); expect(row(byHand, 'proceeds_per_payer')).toMatchObject({ average: 8, value: null });
  expect(row(byHand, 'store_conversion').note).toBeNull();
  expect(byHand.charts.ftue.steps.map((x) => x.key)).toEqual(['01_Loaded', '02_Wardrobe']);

  // With sales reports the count shown is theirs; the rates stay on the analytics count, which covers the same days as page views.
  const both = buildGame(raw({ 'apple.downloads': 4 }), { range: '30d', now });
  expect(both.charts.downloads.total).toBe(4 * days.length);
  expect(row(both, 'page_to_download').value).toBeCloseTo(0.3);
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

test('a buyer on day 5 is credited on a 3-day run, players not yet 7 days old are left out, and a repeat buyer is one paying player', async () => {
  const DAY = 86400000, now = Date.parse('2026-11-25T12:00:00Z'), today = '2026-11-25', day = (t) => new Date(t).toISOString().slice(0, 10);
  const who = [
    { id: 'a', first: now - 8.25 * DAY, last: now - 3 * DAY, buys: [now - 3.25 * DAY, now - 3.2 * DAY] }, // bought twice, on their day 5
    { id: 'b', first: now - 8.3 * DAY, last: now - 8 * DAY, buys: [] },
    { id: 'c', first: now - 3 * DAY, last: now - 3600000, buys: [now - 2 * DAY] }, // bought, but has not had 7 days
    { id: 'd', first: now - 2 * DAY, last: now - DAY, buys: [] },
    { id: 'e', first: now - 80 * DAY, last: now - 20 * DAY, buys: [now - 60 * DAY, now - 20 * DAY] }, // an old player who still buys
  ];
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const fake = async (url) => {
    const u = new URL(url), path = u.pathname, q = u.searchParams; let m;
    if (path.endsWith('/projects')) return json({ items: [{ id: 'proj' }] });
    if ((m = /\/customers\/([^/]+)\/purchases$/.exec(path))) return json({ items: who.find((c) => c.id === m[1]).buys.map((at, i) => ({ id: `${m[1]}-${i}`, environment: 'production', store: 'app_store', product_id: 'p', purchased_at: at, quantity: 1, status: 'owned', revenue_in_usd: { gross: 1, proceeds: 0.7 } })), next_page: null });
    if (path.endsWith('/customers')) return json({ items: who.map((c) => ({ id: c.id, first_seen_at: c.first, last_seen_at: c.last, last_seen_platform: 'iOS', last_seen_app_version: '', last_seen_country: 'US' })), next_page: null });
    if (path.endsWith('/charts/revenue')) {
      // RevenueCat's chart: a sale shows on its UTC day, and only the days asked for come back.
      const days = [...new Set(who.flatMap((c) => c.buys.map(day)))].filter((d) => d >= q.get('start_date') && d <= q.get('end_date'));
      return json({ measures: [{ display_name: 'Revenue' }, { display_name: 'Transactions' }], values: days.flatMap((d) => [{ cohort: Date.parse(d) / 1000, measure: 0, value: 1 }, { cohort: Date.parse(d) / 1000, measure: 1, value: 1 }]) });
    }
    if (path.endsWith('/products')) return json({ items: [], next_page: null });
    return json({ measures: [], segments: [], values: [] });
  };
  const game = { slug: 'g', env_prefix: 'G', platforms: { ios: { status: 'live', launched: '2026-08-01' } } };
  // The hourly run: 3 days.
  const res = await revenuecatRun({ game, env: { G_REVENUECAT_API_KEY: 'k' }, fetchImpl: fake, days: 3, platforms: ['ios'], today, now, zone: 'UTC', cache: new Map(), pause: 0 });
  expect(res.status).toBe('ok');
  const at = (d, k, p = 'all') => res.daily.find((r) => r.platform === p && r.date === d && r.metric_key === k)?.metric_value;
  // a and b installed 8 days ago, outside the run's 3 days: their install day is still rewritten, with a's day-5 purchase on it.
  expect(at('2026-11-17', 'conv_cohort_size')).toBe(2); expect(at('2026-11-17', 'new_paying_customers')).toBe(1); expect(at('2026-11-17', 'new_paying_customers', 'ios')).toBe(1);
  expect(at('2026-11-17', 'new_customers')).toBeUndefined();
  // c bought and d has not, but neither has had 7 days: their install days read zero, not a share that can only go up.
  for (const d of ['2026-11-22', '2026-11-23', today]) { expect(at(d, 'conv_cohort_size')).toBe(0); expect(at(d, 'new_paying_customers')).toBe(0); }
  expect(res.daily.find((r) => r.metric_key === 'conv_cohort_size' && r.mode)).toBeUndefined();
  expect(at('2026-11-22', 'new_customers')).toBe(1); expect(at('2026-11-22', 'transactions')).toBe(2); expect(at('2026-11-22', 'proceeds')).toBeCloseTo(1.4, 9);
  // Different customers who bought in each range: a's two purchases are one paying player, and e, who installed long ago, counts where they bought.
  const live = res.facts.find((f) => f.key === 'revenuecat.live').value;
  expect(live.all.payers_by_range).toEqual({ '7d': 2, '30d': 3, '90d': 3 }); expect(live.ios.payers_by_range).toEqual({ '7d': 2, '30d': 3, '90d': 3 });
  expect(live.all).toMatchObject({ unique_payers: 3, matured: 3, customers: 5 });
  expect(SYNC_RANGES).toEqual(RANGES);

  // On the page: conversion is the players whose seventh day fell in the range, and proceeds are spread over everyone who bought in it.
  const from = addDays(today, -6), cohorts = new Map();
  for (const r of res.daily) if (r.platform === 'all' && /^(conv_cohort_size|new_paying_customers)$/.test(r.metric_key)) cohorts.set(r.date, { ...cohorts.get(r.date), [r.metric_key]: r.metric_value });
  const proceeds = res.daily.filter((r) => r.platform === 'all' && r.metric_key === 'proceeds' && r.date >= from).reduce((a, r) => a + r.metric_value, 0);
  const view = (more = {}) => buildGame({
    game: { slug: 'g', display_name: 'G', status: 'live', config: { timezone: 'UTC', platforms: { ios: { status: 'live' } } } }, platform: 'all', from, to: today, prev: {}, series: {}, hourly: {}, cohorts: [], sync: [],
    // The old count of new players who paid is on record too, and is not what proceeds are divided by.
    totals: { 'revenuecat.proceeds': { sum: proceeds, avg: proceeds / 7, last: 0, n: 7 }, 'revenuecat.new_paying_customers': { sum: 1, avg: 1, last: 0, n: 7 } },
    cohorts_rc: [...cohorts].sort(), facts: { 'revenuecat.live': { value: live, at: now }, 'manual.apple_peers': { value: { proceeds_per_payer: { p25: 1, p50: 2, p75: 4 } }, at: now } }, ...more,
  }, { range: '7d', now });
  const v = view(), conv = v.kpis.find((k) => k.id === 'conversion'), row = (g, id) => g.extras.benchmarks.rows.find((r) => r.id === id);
  expect(conv.value).toBeCloseTo(0.5, 9); expect(conv.sub).toEqual([{ label: 'paying', value: 1, format: 'int' }, { label: 'players at day 7', value: 2, format: 'int' }]);
  expect(row(v, 'paying_players').value).toBeCloseTo(0.5, 9);
  expect(proceeds).toBeCloseTo(2.1, 9); expect(row(v, 'proceeds_per_payer').value).toBeCloseTo(2.1 / 2, 9); expect(row(v, 'proceeds_per_payer').how).toContain('2 different players');
  // Before the sync has counted them, the row waits: it never falls back to the new players who paid.
  expect(row(view({ facts: { 'manual.apple_peers': { value: { proceeds_per_payer: { p25: 1, p50: 2, p75: 4 } }, at: now } } }), 'proceeds_per_payer')).toMatchObject({ value: null, need: 'Comes with the next RevenueCat sync' });

  // A game with nobody 7 days old yet: everyone who has bought over everyone who has played, and the card says so.
  const young = view({ cohorts_rc: [], facts: { 'revenuecat.live': { value: { all: { customers: 20, unique_payers: 1, matured: 0, payers_by_range: { '7d': 1 } } }, at: now } } }).kpis.find((k) => k.id === 'conversion');
  expect(young.value).toBeCloseTo(0.05, 9); expect(young.rule).toContain('all time'); expect(young.sub[1]).toMatchObject({ label: 'players so far', value: 20 }); expect(young.delta).toBeNull();
  // An older game with nobody whose seventh day fell in the range has no rate, and no all-time stand-in.
  const synced = [{ source: 'revenuecat', last_status: 'ok', last_ok: new Date(now).toISOString(), last_run: new Date(now).toISOString(), last_message: '' }];
  const none = view({ sync: synced, cohorts_rc: [], facts: { 'revenuecat.live': { value: { all: { customers: 20, unique_payers: 1, matured: 9, payers_by_range: { '7d': 1 } } }, at: now } } }).kpis.find((k) => k.id === 'conversion');
  expect(none.value).toBeNull(); expect(none.empty.badge).toBe('No players 7 days old in this range');
});

test('DAU is never compared with a count that has testers in it, and graphics levels count each player once', () => {
  const now = Date.parse('2026-11-25T12:00:00Z'), { from, to } = rangeDates('7d', now), days = dates(from, to);
  const tot = (v, n = days.length) => ({ sum: v * n, avg: v, last: v, n });
  const raw = (prev, more = {}) => ({ game: { slug: 'g', display_name: 'G', status: 'live', config: { platforms: { ios: { status: 'live' } } } }, platform: 'all', from, to, hourly: {}, cohorts: [], sync: [],
    totals: { 'revenuecat.active_customers': tot(10), 'posthog.gfx_level:1': tot(4), 'posthog.gfx_level:3': tot(12) }, series: { 'revenuecat.active_customers': days.map((d) => [d, 10]) }, prev, ...more });
  const dau = (g) => g.kpis.find((k) => k.id === 'dau');
  // RevenueCat's chart counts testers: with only that for the period before, there is no change to show.
  const chartOnly = dau(buildGame(raw({ 'revenuecat.active_customers_chart': tot(50) }), { range: '7d', now }));
  expect(chartOnly.value).toBe(10); expect(chartOnly.prev).toBeNull(); expect(chartOnly.delta).toBeNull();
  // With a tester-free count for the period before, that is the one used, however much larger the chart's is.
  const both = dau(buildGame(raw({ 'revenuecat.active_customers_chart': tot(50), 'revenuecat.active_customers': tot(8) }), { range: '7d', now }));
  expect(both.prev).toBe(8); expect(both.delta).toMatchObject({ value: 25, dir: 1 });

  // Daily rows count a player again every day they play: without the deduplicated fact the bars are player-days.
  const daily = buildGame(raw({}), { range: '7d', now }).extras.gfx;
  expect(daily).toMatchObject({ unit: 'player-days' }); expect(daily.levels.map((l) => [l.level, l.players])).toEqual([['1', 28], ['3', 84]]);
  // With it, each player counts once, for the range and platform asked for.
  const fact = { ranges: { '7d': { all: { 3: 6, 1: 2, 5: 0 }, ios: { 3: 5 } }, '30d': { all: { 3: 30 } } } };
  const once = buildGame(raw({}, { facts: { 'posthog.gfx': { value: fact, at: now } } }), { range: '7d', now }).extras.gfx;
  expect(once.unit).toBe('players'); expect(once.levels).toEqual([{ level: '1', players: 2, share: 0.25 }, { level: '3', players: 6, share: 0.75 }]);
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
