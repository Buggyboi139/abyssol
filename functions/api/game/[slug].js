// GET /api/game/:slug?range=7d|30d|90d&platform=all|ios|android: one game.
import { db } from '../../../server/db.js';
import { json } from '../../../server/http.js';
import { RANGES, PLATFORMS, rangeDates, buildGame } from '../../../server/metrics.js';

export async function onRequestGet({ request, env, params }) {
  const slug = String(params.slug || '');
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) return json({ error: 'not_found' }, 404);
  const q = new URL(request.url).searchParams;
  const range = RANGES[q.get('range')] ? q.get('range') : '30d';
  const platform = PLATFORMS.includes(q.get('platform')) ? q.get('platform') : 'all';
  const { from, to } = rangeDates(range);
  const raw = await db(env).rpc('dashboard_game', { p_slug: slug, p_platform: platform, p_from: from, p_to: to });
  if (!raw) return json({ error: 'not_found' }, 404);
  return json(buildGame(raw, { range }));
}
