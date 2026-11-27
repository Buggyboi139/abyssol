#!/usr/bin/env node
// Everything the dashboard needs to run on this machine, with made-up numbers:
//
//   bun run local            a local database on port 54329, filled by a mock
//                            sync, and a .dev.vars file for `bun run pages`
//   bun run local --force    also fills the games that are not live, to see
//                            every chart drawn
//   bun run local --empty    the database with no numbers at all
//
// Then, in two more terminals: `bun run build && bun run pages` (the site and
// its Functions on http://localhost:8788) or `bun run dev` for live reload.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeDb, serveDb, LOCAL_KEY } from './localdb.mjs';
import { hashPassword } from '../server/auth.js';
import { makeVapidKeys } from '../server/webpush.js';
import { sync } from '../sync/run.mjs';
import { loadGames } from '../sync/lib/config.mjs';
import { mockFetch, mockEnv, mockGameDb, mockGames } from '../sync/mock/fetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), flag = (f) => args.includes(f);
const port = Number(args[args.indexOf('--port') + 1]) || 54329;
const USERNAME = 'admin', PASSWORD = 'abyssol-local';

const pg = await makeDb();
await serveDb(pg, port);
const url = `http://127.0.0.1:${port}`;

if (!flag('--empty')) {
  const games = mockGames(loadGames()), fake = mockFetch();
  const env = { ...mockEnv(games), SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: LOCAL_KEY };
  const fetchImpl = (u, o) => (String(u).startsWith(url) ? fetch(u, o) : fake(u, o));
  const { runs } = await sync({ what: 'all', games, days: 130, force: flag('--force'), env, fetchImpl, queryGameDb: mockGameDb, pause: 0 });
  for (const r of runs) console.log(`${r.status.padEnd(7)} ${r.game_slug.padEnd(16)} ${r.source.padEnd(14)} ${r.message}`);
}

// Settings for `wrangler pages dev`. The file is ignored by git.
const vars = path.join(ROOT, '.dev.vars'), vapid = await makeVapidKeys();
fs.writeFileSync(vars, [
  `SUPABASE_URL=${url}`,
  `SUPABASE_SERVICE_ROLE_KEY=${LOCAL_KEY}`,
  `DASHBOARD_USERNAME=${USERNAME}`,
  `DASHBOARD_PASSWORD=${await hashPassword(PASSWORD)}`,
  `SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`,
  `REVENUECAT_WEBHOOK_AUTH=local-webhook-${crypto.randomBytes(8).toString('hex')}`,
  `VAPID_PUBLIC_KEY=${vapid.publicKey}`,
  `VAPID_PRIVATE_KEY=${vapid.privateKey}`,
  'VAPID_SUBJECT=https://localhost',
].join('\n') + '\n', { mode: 0o600 });

console.log(`\nLocal database on ${url} (made-up numbers; it lasts until you stop this).`);
console.log(`Wrote .dev.vars. The local sign-in is "${USERNAME}" and "${PASSWORD}".`);
console.log('Next: bun run build && bun run pages   then open http://localhost:8788');
