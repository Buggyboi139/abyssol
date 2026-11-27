// POST /api/push/test {endpoint}: one notification to this device alone, to see that it works.
import { db } from '../../../server/db.js';
import { json, ApiError } from '../../../server/http.js';
import { vapidOf } from '../../../server/webpush.js';
import { deliver } from '../../../server/notify.js';

export async function onRequestPost({ request, env }) {
  if (!vapidOf(env)) throw new ApiError(503, 'push_not_configured');
  let b;
  try { b = await request.json(); } catch { throw new ApiError(400, 'bad_request'); }
  const store = db(env);
  const subs = await store.rpc('dashboard_push_subscriptions', {});
  const sub = (subs || []).find((s) => s.endpoint === b?.endpoint);
  if (!sub) throw new ApiError(404, 'not_subscribed');
  const r = await deliver(env, store, [{ kind: 'test', title: 'Abyssol', body: 'Notifications work on this device.', url: '/', tag: 'test' }], { only: sub });
  if (!r.sent) throw new ApiError(502, r.gone ? 'subscription_gone' : 'push_failed');
  return json({ ok: true });
}
