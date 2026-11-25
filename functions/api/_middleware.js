// Runs before every /api/* route. Without a valid session cookie the answer is
// 401, except for the routes that make or check a session and the webhook,
// which has a secret of its own.
import { authed } from '../../server/auth.js';
import { json, secure, ApiError } from '../../server/http.js';

const OPEN = new Set(['/api/login', '/api/logout', '/api/session']);

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  try {
    if (path.startsWith('/api/webhooks/')) return secure(await next());
    // A form on another site can't post here: the browser names the page it came from.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return secure(json({ error: 'forbidden' }, 403));
    }
    if (!OPEN.has(path) && !(await authed(request, env))) return secure(json({ error: 'unauthorized' }, 401));
    return secure(await next());
  } catch (e) {
    if (e instanceof ApiError) return secure(json({ error: e.code, ...(e.detail ? { message: e.detail } : {}) }, e.status));
    console.error(e?.stack || e);
    return secure(json({ error: 'server_error' }, 500));
  }
}
