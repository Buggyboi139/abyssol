// The dashboard's password check and session cookie, on Web Crypto, so the
// same code runs in Cloudflare's Functions, Node 20+, and Bun.
//
// DASHBOARD_PASSWORD holds a hash, never the password:
//   pbkdf2-sha256$<iterations>$<salt, base64>$<hash, base64>
// (`bun run hash-password` makes one). SESSION_SECRET signs the cookie.

const enc = new TextEncoder();
const toB64 = (buf) => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64Url = (buf) => toB64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const COOKIE = '__Host-abyssol';
export const SESSION_DAYS = 14;
/** Cloudflare's Web Crypto refuses more PBKDF2 iterations than this. */
export const MAX_ITERATIONS = 100000;
const HASH = /^pbkdf2-sha256\$(\d+)\$([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*)$/;

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password, iterations = MAX_ITERATIONS) {
  if (!(iterations >= 1000 && iterations <= MAX_ITERATIONS)) throw new Error(`iterations must be 1000 to ${MAX_ITERATIONS}`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${toB64(salt)}$${toB64(await pbkdf2(password, salt, iterations))}`;
}

export const isHash = (stored) => { const m = HASH.exec(String(stored || '').trim()); return !!m && +m[1] >= 1000 && +m[1] <= MAX_ITERATIONS; };

/** Compares two byte arrays in the same time whatever they hold. */
export function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** True only for the password the stored hash was made from. Anything that is not a hash matches nothing. */
export async function verifyPassword(password, stored) {
  const m = HASH.exec(String(stored || '').trim());
  if (!m || !isHash(stored) || typeof password !== 'string' || !password || password.length > 1024) return false;
  let salt, want;
  try { salt = fromB64(m[2]); want = fromB64(m[3]); } catch { return false; }
  return equal(await pbkdf2(password, salt, +m[1]), want);
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

/** What sessions are signed with. The password's hash is part of it, so changing the password signs everyone out. */
export function signingKey(env) {
  const secret = String(env?.SESSION_SECRET || '');
  if (secret.length < 32 || !isHash(env?.DASHBOARD_PASSWORD)) return '';
  return `${secret}\n${String(env.DASHBOARD_PASSWORD).trim()}`;
}

export async function makeSession(key, now = Date.now(), days = SESSION_DAYS) {
  if (!key) throw new Error('no signing key');
  const body = `v1.${Math.floor(now / 1000) + days * 86400}.${toB64Url(crypto.getRandomValues(new Uint8Array(12)))}`;
  return `${body}.${toB64Url(await hmac(key, body))}`;
}

/** {exp} for a token this key signed that has not run out, else null. */
export async function readSession(key, token, now = Date.now()) {
  if (!key || typeof token !== 'string' || token.length > 200) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || !/^\d+$/.test(parts[1])) return null;
  const want = toB64Url(await hmac(key, parts.slice(0, 3).join('.')));
  if (!equal(enc.encode(want), enc.encode(parts[3]))) return null;
  const exp = +parts[1];
  return exp > now / 1000 ? { exp } : null;
}

const ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Lax';
export const sessionCookie = (token, days = SESSION_DAYS) => `${COOKIE}=${token}; ${ATTRS}; Max-Age=${days * 86400}`;
export const clearCookie = () => `${COOKIE}=; ${ATTRS}; Max-Age=0`;

export function cookieOf(request) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}

/** Whether this request carries a valid session. */
export async function authed(request, env, now = Date.now()) {
  return !!(await readSession(signingKey(env), cookieOf(request), now));
}

/** A short id for the caller, for counting login attempts without keeping the address. */
export async function clientBucket(request, env, now = Date.now()) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const h = await crypto.subtle.digest('SHA-256', enc.encode(`${ip}|${env.SESSION_SECRET || ''}`));
  return `${toB64Url(h).slice(0, 22)}:${Math.floor(now / 900000)}`;
}

/** Compares two secrets in constant time, whatever their lengths. */
export async function sameSecret(a, b) {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(String(s ?? '')))));
  return equal(new Uint8Array(x), new Uint8Array(y));
}
