// GET /api/overview?range=7d|30d|90d: every game side by side.
import { db } from '../../server/db.js';
import { json } from '../../server/http.js';
import { RANGES, rangeDates, buildOverview } from '../../server/metrics.js';

export async function onRequestGet({ request, env }) {
  const q = new URL(request.url).searchParams;
  const range = RANGES[q.get('range')] ? q.get('range') : '30d';
  const { from, to } = rangeDates(range);
  const raw = await db(env).rpc('dashboard_overview', { p_from: from, p_to: to });
  return json(buildOverview(raw || { from, to, games: [] }, { range }));
}
