// The central Supabase database, through its REST API. The service role key
// stays on the server: only Pages Functions import this file.
import { ApiError } from './http.js';

export function db(env, fetchImpl = fetch) {
  const url = String(env?.SUPABASE_URL || '').replace(/\/+$/, ''), key = env?.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new ApiError(503, 'not_configured', 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set');
  return {
    /** Calls a database function and returns its JSON result. */
    async rpc(fn, args = {}) {
      let res;
      try {
        res = await fetchImpl(`${url}/rest/v1/rpc/${fn}`, {
          method: 'POST', body: JSON.stringify(args),
          headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        });
      } catch { throw new ApiError(502, 'database_unreachable'); }
      if (!res.ok) {
        // The database's own message goes to the Functions log, never to the browser.
        console.error(`database ${fn} ${res.status}: ${(await res.text()).slice(0, 300)}`);
        throw new ApiError(502, res.status === 404 ? 'database_not_migrated' : 'database_error');
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    },
  };
}
