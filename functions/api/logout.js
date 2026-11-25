// POST /api/logout: clears the session cookie.
import { clearCookie } from '../../server/auth.js';
import { json } from '../../server/http.js';

export const onRequestPost = () => json({ ok: true }, 200, { 'set-cookie': clearCookie() });
export const onRequest = () => json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
