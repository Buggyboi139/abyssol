// Turns what changed (dashboard_push_changes) into notifications and sends
// them to every device that asked for that kind. Shared by the hourly sync
// (Bun) and the RevenueCat webhook (Cloudflare), through any object with
// rpc(fn, args), the shape of both server/db.js and the sync's Store.
import { vapidOf, sendPush } from './webpush.js';

export const KINDS = [
  ['players', 'New players', 'Someone opens a game for the first time (PostHog, within the hour).'],
  ['downloads', 'Store downloads', 'The App Store and Google Play report downloads (a day or two late).'],
  ['sales', 'Sales', 'A purchase, within seconds with the RevenueCat webhook, else within the hour.'],
  ['reviews', 'Ratings and reviews', 'A new App Store rating or written review.'],
  ['sync', 'Sync problems', 'A source stops syncing, and when it works again.'],
];

const PLAT = { ios: 'iOS', android: 'Android' };
const SOURCE = { revenuecat: 'RevenueCat', posthog: 'PostHog', apple: 'App Store Connect', google: 'Google Play', listing: 'the store listing', supabase_game: "the game's database" };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const whole = (v) => Math.round(Number(v) || 0);
const money = (v) => `$${(Math.round((Number(v) || 0) * 100) / 100).toFixed(2)}`;
const stars = (n) => '★'.repeat(Math.max(0, Math.min(5, whole(n)))) + '☆'.repeat(Math.max(0, 5 - Math.min(5, whole(n))));
const split = (rows) => {
  const by = rows.filter((r) => whole(r.delta) > 0);
  return by.length > 1 ? ` (${by.map((r) => `${whole(r.delta)} ${PLAT[r.platform]}`).join(', ')})` : by.length === 1 ? ` on ${PLAT[by[0].platform]}` : '';
};

/**
 * The notifications for a list of changes: one per game and kind.
 * `sale` is the webhook's own sale, so its product can be named.
 */
export function messages(changes, { sale } = {}) {
  const groups = new Map();
  for (const c of changes || []) {
    const key = `${c.game_slug}|${c.kind}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const out = [];
  for (const [key, rows] of groups) {
    const [slug, kind] = key.split('|'), game = rows[0].game, url = `/#/game/${slug}`;
    const of = (metric) => rows.filter((r) => r.metric === metric);
    const sum = (metric) => of(metric).reduce((n, r) => n + Number(r.delta || 0), 0);
    let title = null, body = null;
    if (kind === 'players') {
      const n = whole(sum('new_users'));
      if (n > 0) { title = `${game}: ${plural(n, 'new player')}`; body = `First opened the game${split(of('new_users'))}.`; }
    } else if (kind === 'downloads') {
      const n = whole(sum('downloads') + sum('installs'));
      if (n > 0) {
        const stores = [of('downloads').some((r) => r.delta > 0) && 'App Store', of('installs').some((r) => r.delta > 0) && 'Google Play'].filter(Boolean).join(' and ');
        title = `${game}: ${plural(n, 'new download')}`; body = `${stores} reported them${split([...of('downloads'), ...of('installs')])}.`;
      }
    } else if (kind === 'sales') {
      const n = whole(sum('transactions')), amount = sum('revenue');
      if (n > 0) {
        const named = sale && sale.game === slug && n === 1 && sale.product ? ` · ${sale.product}` : '';
        title = `${game}: ${n === 1 ? 'a sale' : `${n} sales`}${amount > 0 ? `, ${money(amount)}` : ''}`;
        body = `${n === 1 ? 'A purchase' : 'Purchases'}${named}${split(of('transactions'))}.`;
      }
    } else if (kind === 'reviews') {
      const written = whole(sum('reviews_total')), ratings = whole(sum('rating_count')), avg = of('rating')[0]?.now;
      const review = of('reviews_total')[0]?.detail;
      if (written > 0) {
        title = `${game}: ${written === 1 ? 'a new review' : `${written} new reviews`} on the App Store`;
        body = review ? `${stars(review.rating)} ${review.title ? `${review.title}: ` : ''}${String(review.body || '').slice(0, 160)}` : 'Open the dashboard to read it.';
      } else if (ratings > 0) {
        title = `${game}: ${plural(ratings, 'new rating')} on the App Store`;
        body = avg != null ? `Average ${(Math.round(avg * 100) / 100).toFixed(2)} ★.` : 'Open the dashboard for the average.';
      }
    } else if (kind === 'sync') {
      const bad = rows.filter((r) => r.failing), good = rows.filter((r) => !r.failing);
      if (bad.length) { title = `${game}: ${bad.map((r) => SOURCE[r.source] || r.source).join(', ')} stopped syncing`; body = bad.map((r) => r.message).filter(Boolean).join(' · ').slice(0, 240) || 'See the sync badges on the dashboard.'; }
      else if (good.length) { title = `${game}: ${good.map((r) => SOURCE[r.source] || r.source).join(', ')} syncing again`; body = 'The last pull worked.'; }
    }
    if (title) out.push({ game_slug: slug, kind, title, body, url, tag: `${kind}-${slug}`.slice(0, 32) });
  }
  return out;
}

/**
 * Sends each message to the devices that want its kind. Returns
 * { sent, failed, gone, messages } and records the round in the database.
 */
export async function deliver(env, store, list, { fetchImpl = fetch, only = null } = {}) {
  const vapid = vapidOf(env);
  const result = { sent: 0, failed: 0, gone: 0, messages: list };
  if (!vapid || !list.length) return result;
  const subs = only ? [only] : await store.rpc('dashboard_push_subscriptions', {});
  if (!subs?.length) return result;
  const ok = new Set(), failed = new Set(), gone = new Set(), log = [];
  for (const m of list) {
    let sent = 0, bad = 0;
    for (const s of subs) {
      if (!only && !(s.kinds || []).includes(m.kind)) continue;
      if (gone.has(s.endpoint)) continue;
      const r = await sendPush(vapid, s, { title: m.title, body: m.body, url: m.url, tag: m.tag }, { fetchImpl, urgency: m.kind === 'sales' ? 'high' : 'normal', topic: m.tag.replace(/[^A-Za-z0-9_-]/g, '_') });
      if (r.ok) { ok.add(s.endpoint); sent++; }
      else if (r.gone) { gone.add(s.endpoint); bad++; }
      else { failed.add(s.endpoint); bad++; }
    }
    result.sent += sent; result.failed += bad;
    log.push({ game_slug: m.game_slug || null, kind: m.kind, title: m.title, body: m.body, sent, failed: bad });
  }
  result.gone = gone.size;
  if (gone.size) await store.rpc('dashboard_push_forget', { p_endpoints: [...gone] });
  if (!only) await store.rpc('dashboard_push_sent', { p_ok: [...ok], p_failed: [...failed].filter((e) => !ok.has(e)), p_log: log });
  return result;
}

/** Asks the database what changed and tells every device that wants to hear it. */
export async function notifyChanges(env, store, { fetchImpl = fetch, sale } = {}) {
  const changes = await store.rpc('dashboard_push_changes', {});
  return deliver(env, store, messages(changes, { sale }), { fetchImpl });
}
