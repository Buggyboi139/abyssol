#!/usr/bin/env bun
// Makes the VAPID key pair that signs the dashboard's notifications, and sets
// it where the senders read it: the Pages project (the webhook and the test
// button) and the repository's Actions secrets (the hourly and daily syncs).
// The private key goes to wrangler and gh on their standard input, never on a
// command line; without --cloudflare or --github it is printed.
//
//   bun run push-keys --subject https://<your dashboard>                      print the three values
//   bun run push-keys --subject <s> --cloudflare <project> --github <owner/repo>
//
// A new pair makes every device's subscription useless: turn notifications
// off and on again on each phone afterwards.
import { spawn } from 'node:child_process';
import { makeVapidKeys } from '../server/webpush.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const die = (m) => { console.error(m); process.exit(1); };
const subject = opt('--subject'), project = opt('--cloudflare'), repo = opt('--github');
if (!/^(https:\/\/|mailto:)\S+$/.test(subject || '')) die('Give --subject: the dashboard\'s https:// address (push services may use it to reach whoever sends).');
if (args.includes('--cloudflare') && !/^[a-z0-9][a-z0-9-]{0,57}$/.test(project || '')) die('Give the Pages project\'s name: --cloudflare <name>');
if (args.includes('--github') && !/^[\w.-]+\/[\w.-]+$/.test(repo || '')) die('Give the repository: --github <owner/repo>');

const { publicKey, privateKey } = await makeVapidKeys();
const values = [['VAPID_PUBLIC_KEY', publicKey], ['VAPID_PRIVATE_KEY', privateKey], ['VAPID_SUBJECT', subject]];
if (!project && !repo) { for (const [k, v] of values) console.log(`${k}=${v}`); process.exit(0); }

const run = (cmd, argv, value) => new Promise((ok, no) => {
  const p = spawn(cmd, argv, { stdio: ['pipe', 'ignore', 'inherit'] });
  p.on('error', no);
  p.on('close', (code) => (code === 0 ? ok() : no(new Error(`${cmd} ${argv.slice(0, 3).join(' ')} exited ${code}`))));
  p.stdin.end(value);
});
try {
  for (const [name, value] of values) {
    if (project) { await run(process.execPath, ['x', 'wrangler', 'pages', 'secret', 'put', name, '--project-name', project], value); console.error(`Set ${name} on the Pages project ${project}.`); }
    if (repo) { await run('gh', ['secret', 'set', name, '--repo', repo], value); console.error(`Set ${name} in ${repo}'s Actions secrets.`); }
  }
} catch (e) { die(`${e.message}. Are wrangler and gh signed in?`); }
console.error(project ? 'Deploy the Pages project again for it to read them.' : '');
