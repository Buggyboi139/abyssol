#!/usr/bin/env node
// Makes the value for DASHBOARD_PASSWORD: a salted PBKDF2-SHA256 hash of the
// password you type. The password itself is stored nowhere.
//
//   bun run hash-password                  asks for the password (not shown)
//   bun run hash-password --iterations N   1000 to 100000 (default 100000)
//   echo 'the password' | bun run hash-password
//   bun run hash-password --secret         prints a random SESSION_SECRET instead
import crypto from 'node:crypto';
import readline from 'node:readline';
import { hashPassword, verifyPassword, MAX_ITERATIONS } from '../server/auth.js';

const args = process.argv.slice(2);
if (args.includes('--secret')) { console.log(crypto.randomBytes(48).toString('base64url')); process.exit(0); }
const at = args.indexOf('--iterations'), iterations = at >= 0 ? Number(args[at + 1]) : MAX_ITERATIONS;

async function ask() {
  if (!process.stdin.isTTY) { let s = ''; for await (const c of process.stdin) s += c; return s.replace(/\r?\n$/, ''); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // Typed characters are not echoed.
  rl._writeToOutput = (s) => { if (s.includes('Password')) process.stderr.write(s); };
  const once = (q) => new Promise((ok) => rl.question(q, ok));
  const a = await once('Password: '); process.stderr.write('\n');
  const b = await once('Password again: '); process.stderr.write('\n');
  rl.close();
  if (a !== b) { console.error('The two did not match.'); process.exit(1); }
  return a;
}

const password = await ask();
if (password.length < 12) { console.error('Use 12 characters or more: this password is the only thing in front of the dashboard.'); process.exit(1); }
const hash = await hashPassword(password, iterations);
if (!(await verifyPassword(password, hash))) { console.error('The hash did not verify.'); process.exit(1); }
console.error('Set this as DASHBOARD_PASSWORD in Cloudflare Pages (Settings, Variables and Secrets, as a secret):');
console.log(hash);
