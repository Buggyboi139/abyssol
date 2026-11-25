// The central Supabase database, through its REST API and the service role key.
// With dryRun set, nothing is sent: rows are kept so the caller can print them.
import { request } from './util.mjs';

export class Store {
  constructor({ url, key, dryRun = false, fetchImpl = fetch }) {
    this.url = String(url || '').replace(/\/+$/, ''); this.key = key; this.dryRun = dryRun; this.fetch = fetchImpl;
    this.kept = { daily: [], hourly: [], runs: [], games: [], facts: [] };
    if (!dryRun && (!this.url || !this.key)) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or pass --dry-run)');
  }

  async rpc(fn, args) {
    const r = await request(this.fetch, `${this.url}/rest/v1/rpc/${fn}`, {
      method: 'POST', body: JSON.stringify(args),
      headers: { apikey: this.key, authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
    });
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  async syncGames(rows) {
    this.kept.games = rows;
    if (this.dryRun) return rows.length;
    return this.rpc('dashboard_sync_games', { p_games: rows });
  }

  async writeMetrics(daily, hourly) {
    this.kept.daily.push(...daily); this.kept.hourly.push(...hourly);
    if (this.dryRun) return daily.length + hourly.length;
    let n = 0;
    // 2,000 rows a call keeps each request small.
    for (let i = 0; i < Math.max(daily.length, hourly.length); i += 2000) {
      n += await this.rpc('dashboard_upsert_metrics', { p_daily: daily.slice(i, i + 2000), p_hourly: hourly.slice(i, i + 2000) });
    }
    return n;
  }

  /** What is not a number a day: [{game_slug, key, value}], each replacing the value kept under its key. */
  async writeFacts(facts) {
    this.kept.facts.push(...facts);
    if (this.dryRun || !facts.length) return facts.length;
    return this.rpc('dashboard_upsert_facts', { p_facts: facts });
  }

  async logRuns(runs) {
    this.kept.runs.push(...runs);
    if (this.dryRun || !runs.length) return runs.length;
    return this.rpc('dashboard_log_runs', { p_runs: runs });
  }
}
