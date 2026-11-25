// Calls to the dashboard's own API. The session lives in an HttpOnly cookie the
// browser sends by itself: this file never sees a password hash or a key.

export class Unauthorized extends Error {}

async function request(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { accept: 'application/json', ...(opts.body ? { 'content-type': 'application/json' } : {}) } });
  } catch { throw Object.assign(new Error('offline'), { code: 'offline' }); }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401 && path !== '/api/login') throw new Unauthorized();
  if (!res.ok) throw Object.assign(new Error(body?.error || `http_${res.status}`), { status: res.status, code: body?.error || `http_${res.status}` });
  return body;
}

export const api = {
  session: () => request('/api/session'),
  login: (password) => request('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request('/api/logout', { method: 'POST', body: '{}' }),
  overview: (range) => request(`/api/overview?range=${encodeURIComponent(range)}`),
  game: (slug, range, platform) => request(`/api/game/${encodeURIComponent(slug)}?range=${encodeURIComponent(range)}&platform=${encodeURIComponent(platform)}`),
};

const WORDS = {
  offline: 'No connection.',
  not_configured: 'The dashboard is not connected to its database yet.',
  database_not_migrated: 'The database has no dashboard tables yet. Run the migrations.',
  database_unreachable: 'The database did not answer.',
  database_error: 'The database returned an error.',
  not_found: 'That game is not on the dashboard.',
  too_many_attempts: 'Too many tries. Wait 15 minutes.',
  invalid_password: 'That password is not right.',
};
export const explain = (e) => WORDS[e?.code] || 'Something went wrong.';
