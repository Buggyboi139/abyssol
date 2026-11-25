// config/games.json, and the environment variables each game reads.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const FILE = path.join(ROOT, 'config/games.json');
export function loadConfig(file = FILE) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { timezone: j.timezone || 'UTC', games: j.games };
}
export const loadGames = (file = FILE) => loadConfig(file).games;
/** The one time zone every live number's day is counted in. */
export const loadZone = (file = FILE) => loadConfig(file).timezone;

/** The rows the `games` table holds: public identifiers, each platform's status and launch day, and the reporting time zone. */
export function gameRows(games, zone = 'UTC') {
  return games.map((g) => ({
    slug: g.slug, display_name: g.display_name, status: g.status,
    ios_bundle_id: g.ios_bundle_id ?? null, android_package_id: g.android_package_id ?? null,
    config: {
      timezone: zone,
      platforms: Object.fromEntries(Object.entries(g.platforms || {}).map(([p, v]) => [p, { status: v.status, ...(v.launched ? { launched: v.launched } : {}) }])),
      ...(g.genre ? { genre: g.genre } : {}),
      ...(g.game_db?.label ? { community_label: g.game_db.label } : {}),
    },
  }));
}

/** The platforms whose data the sync writes: the live ones, or every one with --force. */
export function livePlatforms(game, force = false) {
  return ['ios', 'android'].filter((p) => game.platforms?.[p] && (force || game.platforms[p].status === 'live'));
}

const WORDS = { live: 'live', in_review: 'in review', prelaunch: 'pre-launch' };
export function platformSummary(game) {
  return ['ios', 'android'].map((p) => `${p === 'ios' ? 'iOS' : 'Android'} ${WORDS[game.platforms?.[p]?.status] || 'pre-launch'}`).join(', ');
}

/** Loads KEY=value lines from a local .env file into process.env without overriding what is already set. */
export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
  return true;
}
