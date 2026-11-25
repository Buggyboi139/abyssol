// GET /api/session: whether this browser is signed in, so the page can choose
// between the login screen and the dashboard without a failed request.
import { authed } from '../../server/auth.js';
import { json } from '../../server/http.js';

export const onRequestGet = async ({ request, env }) => json({ authenticated: await authed(request, env) });
