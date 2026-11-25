#!/usr/bin/env bun
// Sets the dashboard's sign-in: asks for a username and a password (typed
// twice, not shown) and makes DASHBOARD_USERNAME and DASHBOARD_PASSWORD, the
// password as a salted PBKDF2-SHA256 hash. The password is stored nowhere.
//
//   bun run set-login                       prints the two values to paste into Cloudflare Pages
//   bun run set-login --cloudflare <name>   sets them on that Pages project instead (needs `wrangler login`),
//                                           and a SESSION_SECRET too if --new-secret is given
//   bun run set-login --iterations N        1000 to 100000 (default 100000)
//   printf 'name\npassword\n' | bun run set-login
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { readPiped, askLine, askPasswordTwice } from './prompt.mjs';
import { hashPassword, verifyPassword, usernameOf, MAX_ITERATIONS } from '../server/auth.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const iterations = opt('--iterations') ? Number(opt('--iterations')) : MAX_ITERATIONS;
const project = opt('--cloudflare');
const die = (m) => { console.error(m); process.exit(1); };
if (args.includes('--cloudflare') && !/^[a-z0-9][a-z0-9-]{0,57}$/.test(project || '')) die('Give the Pages project\'s name: bun run set-login --cloudflare <name>');

async function ask() {
  if (!process.stdin.isTTY) { const [u, ...rest] = (await readPiped()).split(/\r?\n/); return [u, rest.join('\n')]; }
  return [await askLine('Username: '), await askPasswordTwice()];
}

const [typed, password] = await ask();
const username = usernameOf({ DASHBOARD_USERNAME: typed });
if (!username) die('The username is 1 to 64 characters with no spaces. Case does not matter.');
if (password.length < 12) die('Use 12 characters or more for the password.');
const hash = await hashPassword(password, iterations);
if (!(await verifyPassword(password, hash))) die('The hash did not verify.');

if (!project) {
  console.error('Set these in Cloudflare Pages (Settings, Variables and Secrets, as secrets), then redeploy:');
  console.log(`DASHBOARD_USERNAME=${username}`);
  console.log(`DASHBOARD_PASSWORD=${hash}`);
  process.exit(0);
}

// The value goes to wrangler on its standard input, so it is never on a command line or the screen.
const put = (name, value) => new Promise((ok, no) => {
  const p = spawn(process.execPath, ['x', 'wrangler', 'pages', 'secret', 'put', name, '--project-name', project], { stdio: ['pipe', 'ignore', 'inherit'] });
  p.on('error', no);
  p.on('close', (code) => (code === 0 ? ok() : no(new Error(`wrangler could not set ${name} (exit ${code})`))));
  p.stdin.end(value);
});
const values = [['DASHBOARD_USERNAME', username], ['DASHBOARD_PASSWORD', hash]];
if (args.includes('--new-secret')) values.push(['SESSION_SECRET', crypto.randomBytes(48).toString('base64url')]);
try { for (const [name, value] of values) { await put(name, value); console.error(`Set ${name} on ${project}.`); } }
catch (e) { die(`${e.message}. Is wrangler signed in (bun x wrangler login), and does the project exist?`); }
console.error('Deploy the project again for the change to take effect. Everyone signed in is signed out.');
