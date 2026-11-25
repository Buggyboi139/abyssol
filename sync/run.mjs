#!/usr/bin/env node
// Pulls each source's numbers for each game into the central database.
//
//   node sync/run.mjs <what> [options]
//
//   what       hourly (revenuecat, posthog, supabase_game), daily (apple, google),
//              all, or source names separated by commas
//   --game     one game's slug (default: every game in config/games.json)
//   --days     how many days back to pull (default 3 for hourly, 10 for daily)
//   --dry-run  pull and print, write nothing (no database needed)
//   --mock     answer every outside API from sync/mock (made-up numbers, no network)
//   --force    also pull platforms that are not live
//   --strict   exit 1 if any source reports an error
//   --create-report-request   Apple: make the app's ongoing analytics report request if it has none
//
// A game or platform that is not live is skipped, and the skip is recorded so
// the dashboard can say why it has nothing to show.
import fs from 'node:fs';
import { loadGames, gameRows, livePlatforms, platformSummary, loadDotEnv } from './lib/config.mjs';
import { Store } from './lib/store.mjs';
import { ymd } from './lib/util.mjs';
import * as revenuecat from './sources/revenuecat.mjs';
import * as posthog from './sources/posthog.mjs';
import * as apple from './sources/apple.mjs';
import * as google from './sources/google.mjs';
import * as supabase_game from './sources/supabase_game.mjs';

export const SOURCES = { revenuecat, posthog, apple, google, supabase_game };
export const GROUPS = { hourly: ['revenuecat', 'posthog', 'supabase_game'], daily: ['apple', 'google'], all: Object.keys(SOURCES) };

/**
 * One sync pass. Returns {runs, daily, hourly}: a run per source and game, and
 * the rows written (or, with dryRun, the rows that would have been).
 */
export async function sync({ what = 'all', games = loadGames(), only = null, days = null, dryRun = false, force = false, env = process.env, fetchImpl = fetch, queryGameDb = null, createReportRequest = false, store = null, now = Date.now(), pause, log = () => {} } = {}) {
  const names = [...new Set(what.split(',').flatMap((w) => GROUPS[w] || [w]))];
  for (const n of names) if (!SOURCES[n]) throw new Error(`Unknown source "${n}". Use ${Object.keys(GROUPS).join(', ')}, or ${Object.keys(SOURCES).join(', ')}.`);
  const picked = only ? games.filter((g) => g.slug === only) : games;
  if (only && !picked.length) throw new Error(`No game "${only}" in config/games.json`);
  store ||= new Store({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, dryRun, fetchImpl });
  await store.syncGames(gameRows(games));

  const cache = new Map(), runs = [], today = ymd(now);
  for (const game of picked) {
    const platforms = livePlatforms(game, force);
    for (const name of names) {
      let res;
      if (!platforms.length) res = { status: 'skipped', message: `No live platform (${platformSummary(game)})` };
      else {
        const span = days ?? (GROUPS.daily.includes(name) ? 10 : 3);
        try { res = await SOURCES[name].run({ game, env, fetchImpl, days: span, platforms, today, now, cache, queryGameDb, createReportRequest, pause }); }
        catch (e) { res = { status: 'error', message: e.message }; }
      }
      let wrote = 0;
      if (res.status === 'ok') {
        try { wrote = await store.writeMetrics(res.daily || [], res.hourly || []); }
        catch (e) { res = { status: 'error', message: `Pulled, but the database refused the rows: ${e.message}` }; }
      }
      runs.push({ source: name, game_slug: game.slug, status: res.status, message: res.message || '', rows: wrote });
      log(`${res.status.padEnd(7)} ${game.slug.padEnd(16)} ${name.padEnd(14)} ${res.message || ''}`);
    }
  }
  await store.logRuns(runs.map(({ source, game_slug, status, message }) => ({ source, game_slug, status, message })));
  return { runs, daily: store.kept.daily, hourly: store.kept.hourly };
}

function parseArgs(argv) {
  const o = { what: argv[0] && !argv[0].startsWith('--') ? argv[0] : 'all' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--game') o.only = argv[++i];
    else if (a === '--days') o.days = Math.max(1, parseInt(argv[++i], 10) || 0) || null;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--mock') o.mock = true;
    else if (a === '--force') o.force = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--create-report-request') o.createReportRequest = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  loadDotEnv();
  const games = loadGames();
  let env = process.env, fetchImpl = fetch, queryGameDb = null;
  if (o.mock) {
    const m = await import('./mock/fetch.mjs');
    const real = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
    const fake = m.mockFetch(), dbHost = real.SUPABASE_URL ? new URL(real.SUPABASE_URL).host : null;
    env = { ...m.mockEnv(games), ...real };
    // The database is still the real (or local) one; only the outside APIs are stand-ins.
    fetchImpl = (url, opts) => (dbHost && new URL(url).host === dbHost ? fetch(url, opts) : fake(url, opts));
    queryGameDb = m.mockGameDb; o.pause = 0;
  }
  console.log(`sync ${o.what}${o.only ? ' for ' + o.only : ''}${o.dryRun ? ' (dry run: nothing is written)' : ''}${o.mock ? ' (mock APIs)' : ''}${o.force ? ' (forced: platforms that are not live too)' : ''}`);
  const { runs, daily, hourly } = await sync({ ...o, games, env, fetchImpl, queryGameDb, log: (l) => console.log(l) });

  if (o.dryRun) {
    // Totals by source, platform, and key, so a dry run shows what it read.
    const tot = new Map();
    for (const r of daily) { const k = `${r.game_slug}  ${r.source}  ${r.platform}  ${r.metric_key}`; const t = tot.get(k) || { sum: 0, n: 0 }; t.sum += r.metric_value; t.n++; tot.set(k, t); }
    console.log(`\n${daily.length} daily and ${hourly.length} hourly rows would be written. Sum over the days pulled:`);
    for (const [k, t] of [...tot].sort()) console.log(`  ${k.padEnd(74)} ${String(Math.round(t.sum * 100) / 100).padStart(10)}  (${t.n} days)`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const icon = { ok: '✅', skipped: '⏭️', error: '❌' };
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Sync ${o.what}\n\n| Game | Source | Status | Detail |\n|---|---|---|---|\n` + runs.map((r) => `| ${r.game_slug} | ${r.source} | ${icon[r.status]} ${r.status} | ${String(r.message).replace(/\|/g, '/')} |`).join('\n') + '\n');
  }
  const bad = runs.filter((r) => r.status === 'error');
  if (bad.length) console.log(`\n${bad.length} source${bad.length > 1 ? 's' : ''} reported an error (shown on the dashboard's sync badges).`);
  if (o.strict && bad.length) process.exit(1);
}

const direct = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (direct) main().catch((e) => { console.error('sync failed:', e.message); process.exit(1); });
