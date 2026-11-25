// A game's own Supabase database: a few read-only counts (players, players
// active this week, this week's entries), from the queries in config/games.json.
// Needs <PREFIX>_GAME_DB_URL, a Postgres connection string. Use the session
// pooler's (it answers over IPv4, which GitHub's runners need) and a role that
// can only read (README.md, A read-only role).
import { Rows } from '../lib/util.mjs';
import { ownEnv } from '../lib/env.mjs';

export const source = 'supabase_game';

export async function run(ctx) {
  const { game, env, platforms, today, now } = ctx;
  const queries = game.game_db?.queries;
  if (!queries || !Object.keys(queries).length) return { status: 'skipped', message: 'config/games.json has no game_db queries for this game' };
  if (!platforms.length) return { status: 'skipped', message: 'No live platform' };
  const url = ownEnv(env, game, 'GAME_DB_URL');
  if (!url && !ctx.queryGameDb) return { status: 'skipped', message: `Not connected: set ${game.env_prefix}_GAME_DB_URL` };

  const values = await (ctx.queryGameDb || queryAll)(url, queries, game);
  const rows = new Rows(game.slug, source);
  const hour = new Date(Math.floor(now / 3600000) * 3600000).toISOString();
  for (const [k, v] of Object.entries(values)) { rows.set('all', today, k, v); rows.addHour('all', hour, k, v); }
  return { status: 'ok', daily: rows.daily, hourly: rows.hourly, message: Object.entries(values).map(([k, v]) => `${k.replace(/^community_/, '')} ${v}`).join(', ') };
}

/** Runs each query in one read-only transaction and returns {metric_key: number}. */
async function queryAll(url, queries) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 20, onnotice() {} });
  try {
    return await sql.begin('read only', async (tx) => {
      const out = {};
      for (const [k, q] of Object.entries(queries)) { const [row] = await tx.unsafe(q); out[k] = Number(Object.values(row || { n: 0 })[0]) || 0; }
      return out;
    });
  } finally { await sql.end({ timeout: 5 }); }
}
