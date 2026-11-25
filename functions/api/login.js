// POST /api/login {password}: checks the password against DASHBOARD_PASSWORD's
// hash and, if it matches, sets the signed session cookie.
import { verifyPassword, isHash, signingKey, makeSession, sessionCookie, clientBucket } from '../../server/auth.js';
import { db } from '../../server/db.js';
import { json } from '../../server/http.js';

export async function onRequestPost({ request, env }) {
  if (!isHash(env.DASHBOARD_PASSWORD) || String(env.SESSION_SECRET || '').length < 32) {
    return json({ error: 'not_configured', message: 'Set DASHBOARD_PASSWORD (a hash from `bun run hash-password`) and SESSION_SECRET (32 characters or more).' }, 503);
  }
  // Ten tries per caller per 15 minutes. If the database can't be reached the
  // check is skipped: the password hash is what guards the door.
  try {
    const allowed = await db(env).rpc('dashboard_login_attempt', { p_bucket: await clientBucket(request, env), p_limit: 10 });
    if (allowed === false) return json({ error: 'too_many_attempts' }, 429, { 'retry-after': '900' });
  } catch { /* counted nowhere; carry on */ }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
  if (!(await verifyPassword(typeof body?.password === 'string' ? body.password : '', env.DASHBOARD_PASSWORD))) {
    return json({ error: 'invalid_password' }, 401);
  }
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(await makeSession(signingKey(env))) });
}

export const onRequest = () => json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
