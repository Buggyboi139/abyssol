// /api/push: this device's notifications. The middleware has checked the session.
//   GET    ?endpoint=<url>   the public key, and what this device gets (null if nothing)
//   POST   {subscription, kinds, device}   turn on, or change what it gets
//   DELETE {endpoint}        turn off
import { db } from '../../../server/db.js';
import { json, ApiError } from '../../../server/http.js';
import { vapidOf } from '../../../server/webpush.js';
import { KINDS } from '../../../server/notify.js';

const ENDPOINT = /^https:\/\/[^\s/]+\/\S{1,1800}$/, KEY = /^[A-Za-z0-9_-]{16,120}$/;
const kindsOf = (v) => (Array.isArray(v) ? v.filter((k) => KINDS.some(([id]) => id === k)) : null);

async function bodyOf(request) {
  try { return await request.json(); } catch { throw new ApiError(400, 'bad_request'); }
}

export async function onRequestGet({ request, env }) {
  const vapid = vapidOf(env), endpoint = new URL(request.url).searchParams.get('endpoint') || '';
  const device = vapid && ENDPOINT.test(endpoint) ? await db(env).rpc('dashboard_push_device', { p_endpoint: endpoint }) : null;
  const recent = vapid ? await db(env).rpc('dashboard_push_recent', { p_limit: 12 }) : [];
  return json({ configured: !!vapid, publicKey: vapid?.publicKey || null, device, recent, kinds: KINDS.map(([id, label, about]) => ({ id, label, about })) });
}

export async function onRequestPost({ request, env }) {
  if (!vapidOf(env)) throw new ApiError(503, 'push_not_configured');
  const b = await bodyOf(request), s = b?.subscription;
  if (!s || !ENDPOINT.test(s.endpoint || '') || !KEY.test(s.keys?.p256dh || '') || !KEY.test(s.keys?.auth || '')) throw new ApiError(400, 'bad_subscription');
  const device = await db(env).rpc('dashboard_push_subscribe', {
    p_endpoint: s.endpoint, p_p256dh: s.keys.p256dh, p_auth: s.keys.auth,
    p_kinds: kindsOf(b.kinds), p_device: typeof b.device === 'string' ? b.device.slice(0, 80) : null,
  });
  return json({ ok: true, device });
}

export async function onRequestDelete({ request, env }) {
  const b = await bodyOf(request);
  if (!ENDPOINT.test(b?.endpoint || '')) throw new ApiError(400, 'bad_subscription');
  await db(env).rpc('dashboard_push_forget', { p_endpoints: [b.endpoint] });
  return json({ ok: true });
}
