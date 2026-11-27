// Runs the Pages Functions in the tests the way Cloudflare Pages does: the
// /api middleware first, then the route's handler for the request's method.
import * as middleware from '../functions/api/_middleware.js';
import * as login from '../functions/api/login.js';
import * as logout from '../functions/api/logout.js';
import * as session from '../functions/api/session.js';
import * as overview from '../functions/api/overview.js';
import * as game from '../functions/api/game/[slug].js';
import * as revenuecat from '../functions/api/webhooks/revenuecat.js';
import * as push from '../functions/api/push/index.js';
import * as pushTest from '../functions/api/push/test.js';

const ROUTES = [
  [/^\/api\/login$/, login], [/^\/api\/logout$/, logout], [/^\/api\/session$/, session], [/^\/api\/overview$/, overview],
  [/^\/api\/game\/([^/]+)$/, game, 'slug'], [/^\/api\/webhooks\/revenuecat$/, revenuecat],
  [/^\/api\/push$/, push], [/^\/api\/push\/test$/, pushTest],
];

export function pages(env) {
  return async (path, { method = 'GET', headers = {}, body } = {}) => {
    const request = new Request(`https://dash.test${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const { pathname } = new URL(request.url);
    const next = async () => {
      for (const [re, mod, param] of ROUTES) {
        const m = re.exec(pathname);
        if (!m) continue;
        const name = `onRequest${method[0]}${method.slice(1).toLowerCase()}`;
        const handler = mod[name] || mod.onRequest;
        if (!handler) return new Response('Method Not Allowed', { status: 405 });
        return handler({ request, env, params: param ? { [param]: decodeURIComponent(m[1]) } : {} });
      }
      return new Response('Not Found', { status: 404 });
    };
    return middleware.onRequest({ request, env, next });
  };
}
