// POST /api/webhooks/revenuecat?game=<slug>: RevenueCat calls this when a
// purchase happens, so a sale shows within seconds instead of at the next
// hourly pull. Optional: the hourly pull is the record, and it overwrites each
// finished day with RevenueCat's own totals.
//
// In RevenueCat (Project settings, Integrations, Webhooks) set the URL to this
// route with the game's slug, and the Authorization header value to the same
// text as REVENUECAT_WEBHOOK_AUTH.
import { sameSecret } from '../../../server/auth.js';
import { db } from '../../../server/db.js';
import { json } from '../../../server/http.js';

const SALES = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE']);
const PLATFORM = { APP_STORE: 'ios', MAC_APP_STORE: 'ios', PLAY_STORE: 'android' };
const round = (v) => Math.round(v * 10000) / 10000;

/** The amounts one webhook event adds, or null if it is not a production sale. */
export function saleOf(event) {
  if (!event || !SALES.has(event.type) || event.environment !== 'PRODUCTION') return null;
  const platform = PLATFORM[event.store], price = Number(event.price);
  if (!platform || !event.id || !(price > 0)) return null;
  const at = Number(event.purchased_at_ms || event.event_timestamp_ms);
  if (!Number.isFinite(at)) return null;
  const product = String(event.product_id || 'unknown').trim().replace(/[:\s]+/g, '_').slice(0, 80);
  const cut = (Number(event.commission_percentage) || 0) + (Number(event.tax_percentage) || 0);
  const metrics = { revenue: round(price), transactions: 1, [`revenue_by_product:${product}`]: round(price), [`transactions_by_product:${product}`]: 1 };
  if (cut > 0 && cut < 1) metrics.proceeds = round(price * (1 - cut));
  return { id: String(event.id).slice(0, 120), platform, at: new Date(at).toISOString(), metrics };
}

export async function onRequestPost({ request, env }) {
  const secret = env.REVENUECAT_WEBHOOK_AUTH;
  if (!secret || String(secret).length < 16) return json({ error: 'not_configured' }, 503);
  if (!(await sameSecret(request.headers.get('authorization') || '', secret))) return json({ error: 'unauthorized' }, 401);

  const game = new URL(request.url).searchParams.get('game') || '';
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(game)) return json({ error: 'unknown_game' }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const sale = saleOf(body?.event);
  // Anything that is not a production sale is acknowledged, so RevenueCat doesn't send it again.
  if (!sale) return json({ ok: true, counted: false });
  const counted = await db(env).rpc('dashboard_record_sale', { p_event_id: sale.id, p_game: game, p_platform: sale.platform, p_at: sale.at, p_metrics: sale.metrics });
  return json({ ok: true, counted: counted === true });
}

export const onRequest = () => json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
