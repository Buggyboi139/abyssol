// Notifications, end to end with nothing outside this process: the payload
// decrypted by an independent implementation (http_ece) as a browser would,
// the VAPID signature checked, the change detector in the real migrations,
// the API behind the session, the webhook's instant push, and the sync's.
import { test, expect, beforeAll } from 'bun:test';
import nodeCrypto from 'node:crypto';
import ece from 'http_ece';
import { makeDb, dbFetch, rpc, LOCAL_KEY } from '../scripts/localdb.mjs';
import { hashPassword } from '../server/auth.js';
import { encrypt, vapidHeader, makeVapidKeys, fromB64u, b64u, vapidOf } from '../server/webpush.js';
import { messages } from '../server/notify.js';
import { sync } from '../sync/run.mjs';
import { loadGames } from '../sync/lib/config.mjs';
import { mockFetch, mockEnv, mockGameDb, mockGames } from '../sync/mock/fetch.mjs';
import { pages } from './pages.mjs';

const DB = 'http://db.test', PUSH = 'https://push.test';
let pg, env, call, cookie, vapid, pushed = [], answer = 201;

/** A browser's side of a subscription: its key pair and auth secret, and how it reads a push. */
function browser(id) {
  const ecdh = nodeCrypto.createECDH('prime256v1'); ecdh.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  return {
    sub: { endpoint: `${PUSH}/send/${id}`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } },
    read: (body) => JSON.parse(ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ecdh, authSecret: b64u(auth) }).toString('utf8')),
  };
}

beforeAll(async () => {
  pg = await makeDb();
  const keys = await makeVapidKeys();
  env = {
    SUPABASE_URL: DB, SUPABASE_SERVICE_ROLE_KEY: LOCAL_KEY, SESSION_SECRET: 'x'.repeat(40),
    DASHBOARD_USERNAME: 'Owner', DASHBOARD_PASSWORD: await hashPassword('correct horse battery staple', 1000),
    REVENUECAT_WEBHOOK_AUTH: 'webhook-secret-for-tests',
    VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'https://dash.test',
  };
  vapid = vapidOf(env);
  // The database is the local one; the push service is a stand-in that keeps what it's sent.
  const push = async (url, opts) => {
    if (!String(url).startsWith(PUSH)) return new Response('not found', { status: 404 });
    pushed.push({ url: String(url), headers: opts.headers, body: opts.body });
    return new Response('', { status: String(url).includes('gone') ? 410 : answer });
  };
  globalThis.fetch = dbFetch(pg, DB, push);
  call = pages(env);
  const r = await call('/api/login', { method: 'POST', body: { username: 'owner', password: 'correct horse battery staple' } });
  cookie = r.headers.get('set-cookie').split(';')[0];
});

test('a payload decrypts with an independent aes128gcm implementation, and the VAPID token is ES256 for the push service', async () => {
  const b = browser('one');
  const body = await encrypt(JSON.stringify({ title: 'Hello', body: 'Ünïcode ✓' }), b.sub.keys);
  expect(body[20]).toBe(65); // the sender's public key rides in the header
  expect(b.read(body)).toEqual({ title: 'Hello', body: 'Ünïcode ✓' });

  const header = await vapidHeader(vapid, `${PUSH}/send/one`, Date.parse('2026-11-27T12:00:00Z'));
  const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  expect(k).toBe(env.VAPID_PUBLIC_KEY);
  const [h, p, sig] = token.split('.');
  expect(JSON.parse(new TextDecoder().decode(fromB64u(h)))).toEqual({ typ: 'JWT', alg: 'ES256' });
  expect(JSON.parse(new TextDecoder().decode(fromB64u(p)))).toEqual({ aud: PUSH, exp: Date.parse('2026-11-27T12:00:00Z') / 1000 + 43200, sub: 'https://dash.test' });
  const pub = await crypto.subtle.importKey('raw', fromB64u(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64u(sig), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  expect(vapidOf({ ...env, VAPID_SUBJECT: 'someone' })).toBeNull();
});

test('the push API needs a session, takes a good subscription, and sends a test to that device alone', async () => {
  expect((await call('/api/push')).status).toBe(401);
  const off = await (await call('/api/push?endpoint=', { headers: { cookie } })).json();
  expect(off).toMatchObject({ configured: true, publicKey: env.VAPID_PUBLIC_KEY, device: null });
  expect(off.kinds.map((k) => k.id)).toEqual(['players', 'downloads', 'sales', 'reviews', 'sync']);

  const b = browser('phone');
  const post = (body, headers = {}) => call('/api/push', { method: 'POST', headers: { cookie, ...headers }, body });
  expect((await post({ subscription: { ...b.sub, endpoint: 'http://push.test/x' } })).status).toBe(400);
  expect((await post({ subscription: { ...b.sub, keys: {} } })).status).toBe(400);
  expect((await post({ subscription: b.sub }, { origin: 'https://evil.test' })).status).toBe(403);
  expect(await (await post({ subscription: b.sub, device: 'Android · app' })).json()).toEqual({ ok: true, device: { kinds: ['downloads', 'players', 'reviews', 'sales', 'sync'] } });
  // Kinds it doesn't know are dropped; null keeps what it had.
  expect((await (await post({ subscription: b.sub, kinds: ['sales', 'downloads', 'nonsense'] })).json()).device.kinds).toEqual(['downloads', 'sales']);
  expect((await (await post({ subscription: b.sub, kinds: null })).json()).device.kinds).toEqual(['downloads', 'sales']);
  expect((await (await call(`/api/push?endpoint=${encodeURIComponent(b.sub.endpoint)}`, { headers: { cookie } })).json()).device.kinds).toEqual(['downloads', 'sales']);

  pushed = [];
  expect((await call('/api/push/test', { method: 'POST', headers: { cookie }, body: { endpoint: b.sub.endpoint } })).status).toBe(200);
  expect(pushed.length).toBe(1);
  expect(pushed[0].headers).toMatchObject({ 'content-encoding': 'aes128gcm', ttl: '86400' });
  expect(b.read(pushed[0].body)).toMatchObject({ title: 'Abyssol', body: 'Notifications work on this device.' });
  expect((await call('/api/push/test', { method: 'POST', headers: { cookie }, body: { endpoint: `${PUSH}/send/nobody` } })).status).toBe(404);

  expect((await call('/api/push', { method: 'DELETE', headers: { cookie }, body: { endpoint: b.sub.endpoint } })).status).toBe(200);
  expect(await rpc(pg, 'dashboard_push_device', { p_endpoint: b.sub.endpoint })).toBeNull();
});

const metric = (slug, source, platform, date, key, value) => pg.query(
  `insert into metrics_daily (game_slug, platform, source, date, metric_key, metric_value) values ($1, $2, $3, $4, $5, $6)
   on conflict (game_slug, platform, source, date, metric_key) do update set metric_value = excluded.metric_value`, [slug, platform, source, date, key, value]);
const games = () => pg.query(`insert into games (slug, display_name, status) values ('pearl-tide', 'Pearl Tide', 'live'), ('chillwater-lake', 'Chillwater Lake', 'in_review') on conflict do nothing`);

test('each rise is told once, a fall and a first sight are noted without a word, and a sync is told when it breaks and when it mends', async () => {
  await games();
  await metric('pearl-tide', 'posthog', 'ios', '2026-11-25', 'new_users', 10);
  await metric('pearl-tide', 'apple', 'ios', '2026-11-24', 'downloads', 40);
  await pg.query(`insert into sync_runs (source, game_slug, status, message) values ('google', 'pearl-tide', 'ok', '')`);
  await metric('pearl-tide', 'posthog', 'android', '2026-11-25', 'new_users', 6);
  expect(await rpc(pg, 'dashboard_push_changes')).toEqual([]);  // whatever was there before is the starting point, on every platform
  expect(await rpc(pg, 'dashboard_push_changes')).toEqual([]);  // and nothing is told twice

  await metric('pearl-tide', 'posthog', 'ios', '2026-11-26', 'new_users', 2);
  await metric('chillwater-lake', 'posthog', 'ios', '2026-11-26', 'new_users', 3); // a source's first sight for a game: noted, not told
  await metric('pearl-tide', 'apple', 'ios', '2026-11-24', 'downloads', 35);       // a store correcting itself
  await pg.query(`insert into sync_runs (source, game_slug, status, message) values ('google', 'pearl-tide', 'error', 'Play said 403')`);
  let c = await rpc(pg, 'dashboard_push_changes');
  expect(c.map((x) => [x.kind, x.platform || x.source, x.delta ?? x.failing])).toEqual([['players', 'ios', 2], ['sync', 'google', true]]);
  expect(messages(c)).toEqual([
    { game_slug: 'pearl-tide', kind: 'players', title: 'Pearl Tide: 2 new players', body: 'First opened the game on iOS.', url: '/#/game/pearl-tide', tag: 'players-pearl-tide' },
    { game_slug: 'pearl-tide', kind: 'sync', title: 'Pearl Tide: Google Play stopped syncing', body: 'Play said 403', url: '/#/game/pearl-tide', tag: 'sync-pearl-tide' },
  ]);
  await pg.query(`insert into sync_runs (source, game_slug, status, message) values ('google', 'pearl-tide', 'error', 'Play said 403')`);
  await metric('pearl-tide', 'posthog', 'android', '2026-11-27', 'new_users', 1); // the source is watched for this game: counts from 0
  await metric('pearl-tide', 'posthog', 'ios', '2026-11-27', 'new_users', 1);
  await metric('pearl-tide', 'apple', 'ios', '2026-11-25', 'downloads', 8);
  await pg.query(`insert into sync_runs (source, game_slug, status, message) values ('google', 'pearl-tide', 'skipped', 'not live')`);
  c = await rpc(pg, 'dashboard_push_changes');
  expect(messages(c).map((m) => `${m.title} | ${m.body}`)).toEqual([
    'Pearl Tide: 2 new players | First opened the game (1 iOS, 1 Android).',
    'Pearl Tide: 8 new downloads | App Store reported them on iOS.',
  ]);
  await pg.query(`insert into sync_runs (source, game_slug, status, message) values ('google', 'pearl-tide', 'ok', '12 rows')`);
  expect(messages(await rpc(pg, 'dashboard_push_changes')).map((m) => m.title)).toEqual(['Pearl Tide: Google Play syncing again']);
});

test('a written review is told with its stars and words, a rating with the new average', async () => {
  await games();
  await metric('pearl-tide', 'listing', 'ios', '2026-11-26', 'reviews_total', 4);
  await metric('pearl-tide', 'listing', 'ios', '2026-11-26', 'rating_count', 30);
  await metric('pearl-tide', 'listing', 'ios', '2026-11-26', 'rating', 4.6);
  await rpc(pg, 'dashboard_push_changes');
  await rpc(pg, 'dashboard_upsert_facts', { p_facts: [{ game_slug: 'pearl-tide', key: 'listing.ios', value: { reviews: [{ rating: 5, title: 'Lovely', body: 'So calm.' }] } }] });
  await metric('pearl-tide', 'listing', 'ios', '2026-11-27', 'reviews_total', 5);
  await metric('pearl-tide', 'listing', 'ios', '2026-11-27', 'rating_count', 31);
  await metric('pearl-tide', 'listing', 'ios', '2026-11-27', 'rating', 4.61);
  expect(messages(await rpc(pg, 'dashboard_push_changes')).map((m) => `${m.title} | ${m.body}`)).toEqual(['Pearl Tide: a new review on the App Store | ★★★★★ Lovely: So calm.']);
  await metric('pearl-tide', 'listing', 'ios', '2026-11-28', 'rating_count', 33);
  await metric('pearl-tide', 'listing', 'ios', '2026-11-28', 'rating', 4.58);
  await metric('pearl-tide', 'listing', 'ios', '2026-11-28', 'reviews_total', 5);
  expect(messages(await rpc(pg, 'dashboard_push_changes')).map((m) => `${m.title} | ${m.body}`)).toEqual(['Pearl Tide: 2 new ratings on the App Store | Average 4.58 ★.']);
  // A move in the average alone says nothing.
  await metric('pearl-tide', 'listing', 'ios', '2026-11-28', 'rating', 4.59);
  expect(messages(await rpc(pg, 'dashboard_push_changes'))).toEqual([]);
});

test('a sale reaches the phone from the webhook within the request, named, and only to devices that want sales; a gone device is forgotten', async () => {
  await games();
  await metric('pearl-tide', 'revenuecat', 'ios', '2026-11-20', 'transactions', 0); // RevenueCat is already watched; this is Android's first sale
  await rpc(pg, 'dashboard_push_changes');
  const wants = browser('sales-phone'), not = browser('quiet-phone'), gone = browser('gone');
  await rpc(pg, 'dashboard_push_subscribe', { p_endpoint: wants.sub.endpoint, p_p256dh: wants.sub.keys.p256dh, p_auth: wants.sub.keys.auth, p_kinds: ['sales'] });
  await rpc(pg, 'dashboard_push_subscribe', { p_endpoint: not.sub.endpoint, p_p256dh: not.sub.keys.p256dh, p_auth: not.sub.keys.auth, p_kinds: ['players'] });
  await rpc(pg, 'dashboard_push_subscribe', { p_endpoint: gone.sub.endpoint, p_p256dh: gone.sub.keys.p256dh, p_auth: gone.sub.keys.auth });
  pushed = [];
  const event = { id: 'evt-push-1', type: 'NON_RENEWING_PURCHASE', environment: 'PRODUCTION', store: 'PLAY_STORE', price: 4.99, product_id: 'pack.nixie', purchased_at_ms: Date.now() };
  const r = await call('/api/webhooks/revenuecat?game=pearl-tide', { method: 'POST', headers: { authorization: env.REVENUECAT_WEBHOOK_AUTH }, body: { event } });
  expect(await r.json()).toEqual({ ok: true, counted: true });
  expect(pushed.map((p) => p.url).sort()).toEqual([`${PUSH}/send/gone`, `${PUSH}/send/sales-phone`]);
  const got = wants.read(pushed.find((p) => p.url.endsWith('sales-phone')).body);
  expect(got).toEqual({ title: 'Pearl Tide: a sale, $4.99', body: 'A purchase · pack.nixie on Android.', url: '/#/game/pearl-tide', tag: 'sales-pearl-tide' });
  expect(pushed[0].headers.urgency).toBe('high');
  expect(await rpc(pg, 'dashboard_push_device', { p_endpoint: gone.sub.endpoint })).toBeNull();
  expect((await rpc(pg, 'dashboard_push_recent', {}))[0]).toMatchObject({ kind: 'sales', title: 'Pearl Tide: a sale, $4.99', sent: 1 });
  // A retried delivery tells no one again.
  pushed = [];
  await call('/api/webhooks/revenuecat?game=pearl-tide', { method: 'POST', headers: { authorization: env.REVENUECAT_WEBHOOK_AUTH }, body: { event } });
  expect(pushed).toEqual([]);
  await rpc(pg, 'dashboard_push_forget', { p_endpoints: [wants.sub.endpoint, not.sub.endpoint] });
});

test('the hourly sync tells the phone what it brought in, and a push service that is down never fails the sync', async () => {
  const phone = browser('sync-phone');
  await rpc(pg, 'dashboard_push_subscribe', { p_endpoint: phone.sub.endpoint, p_p256dh: phone.sub.keys.p256dh, p_auth: phone.sub.keys.auth });
  const g = mockGames(loadGames()), fake = mockFetch();
  const run = (days) => sync({ what: 'hourly', games: g, days, env: { ...mockEnv(g), ...env }, fetchImpl: dbFetch(pg, DB, (u, o) => (String(u).startsWith(PUSH) ? globalThis.fetch(u, o) : fake(u, o))), queryGameDb: mockGameDb, pause: 0 });
  await run(3);
  await rpc(pg, 'dashboard_push_changes');
  // Days further back come in: sales the phone hasn't heard about.
  pushed = [];
  const { pushed: res, runs } = await run(9);
  expect(runs.some((r) => r.status === 'ok')).toBe(true);
  expect(res.messages.map((m) => m.kind)).toContain('sales');
  const titles = pushed.map((p) => phone.read(p.body).title);
  expect(titles.some((t) => /^Pearl Tide: (a sale|\d+ sales), \$\d+\.\d\d$/.test(t))).toBe(true);
  expect(res.sent).toBe(pushed.length);

  answer = 503; pushed = [];
  await metric('pearl-tide', 'posthog', 'ios', '2026-08-01', 'new_users', 99);
  const down = await run(1);
  expect(down.pushed.failed).toBeGreaterThan(0);
  expect(await rpc(pg, 'dashboard_push_device', { p_endpoint: phone.sub.endpoint })).not.toBeNull(); // kept: one bad round isn't the end
  answer = 201;
});
