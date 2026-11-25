// A local stand-in for the central Supabase database, for development and the
// tests: Postgres in this process (PGlite) with the real migrations applied,
// answering the one kind of request the dashboard and the sync make,
// POST /rest/v1/rpc/<function>. No Docker, no account, nothing kept on disk.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_KEY = 'local-service-role-key';

/** A fresh database with every migration in supabase/migrations applied, in order. */
export async function makeDb() {
  const pg = new PGlite();
  const dir = path.join(ROOT, 'supabase/migrations');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await pg.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  return pg;
}

/** Calls a public function by its argument names, as PostgREST does. */
export async function rpc(pg, fn, args = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw Object.assign(new Error('no such function'), { status: 404 });
  const meta = await pg.query(
    `select p.proargnames as names, array(select format_type(t, null) from unnest(p.proargtypes::oid[]) with ordinality as x (t, ord) order by ord) as types
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [fn]);
  if (!meta.rows.length) throw Object.assign(new Error('no such function'), { status: 404 });
  const { names, types } = meta.rows[0], keys = Object.keys(args), values = [];
  const parts = keys.map((k, i) => {
    const at = (names || []).indexOf(k);
    if (at < 0) throw Object.assign(new Error(`no argument ${k}`), { status: 404 });
    values.push(/json/.test(types[at]) ? JSON.stringify(args[k]) : args[k]);
    return `${k} => $${i + 1}::${types[at]}`;
  });
  const out = await pg.query(`select public.${fn}(${parts.join(', ')}) as r`, values);
  return out.rows[0]?.r ?? null;
}

/** A fetch that answers database calls from `pg` and hands everything else to `other`. */
export function dbFetch(pg, base, other = fetch) {
  return async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith(`${base}/rest/v1/rpc/`)) return other(url, opts);
    const h = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (h.apikey !== LOCAL_KEY) return new Response('{"message":"Invalid API key"}', { status: 401 });
    try { return new Response(JSON.stringify(await rpc(pg, u.slice(`${base}/rest/v1/rpc/`.length).split('?')[0], JSON.parse(opts.body || '{}'))), { status: 200, headers: { 'content-type': 'application/json' } }); }
    catch (e) { return new Response(JSON.stringify({ message: e.message }), { status: e.status || 400 }); }
  };
}

/** The same thing over HTTP, for `wrangler pages dev` and the sync CLI. */
export async function serveDb(pg, port = 54329) {
  const answer = dbFetch(pg, `http://127.0.0.1:${port}`, async () => new Response('{"message":"not found"}', { status: 404 }));
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await answer(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(await r.text());
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return server;
}
