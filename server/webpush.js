// Web Push on Web Crypto alone, so the same code sends from Cloudflare's
// Functions (a sale from the webhook) and from Bun in GitHub Actions (the
// hourly sync): the payload encrypted for the browser (RFC 8291, aes128gcm)
// and the request signed with the dashboard's VAPID key (RFC 8292).
//
// VAPID_PUBLIC_KEY is the key's public point (65 bytes, base64url) and
// VAPID_PRIVATE_KEY its private scalar d (32 bytes, base64url): `bun run
// push-keys` makes both. VAPID_SUBJECT is how a push service can reach whoever
// sends (an https: URL or a mailto:); it goes to the push service with every push.

const enc = new TextEncoder();

export const b64u = (buf) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(s).length % 4)) % 4)), (c) => c.charCodeAt(0));

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** A new VAPID key pair: { publicKey, privateKey }, both base64url. */
export async function makeVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)), privateKey: jwk.d };
}

/** The VAPID settings from the environment, or null when push is not set up. */
export function vapidOf(env) {
  const publicKey = String(env?.VAPID_PUBLIC_KEY || '').trim(), privateKey = String(env?.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(env?.VAPID_SUBJECT || '').trim();
  if (!/^[A-Za-z0-9_-]{86,88}$/.test(publicKey) || !/^[A-Za-z0-9_-]{42,44}$/.test(privateKey) || !/^(https:\/\/|mailto:)\S+$/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

async function signingKey({ publicKey, privateKey }) {
  const pub = fromB64u(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY is not an uncompressed P-256 point');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33)), d: privateKey, ext: true };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** The Authorization header for one push service: a JWT good for 12 hours, signed ES256. */
export async function vapidHeader(vapid, endpoint, now = Date.now()) {
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(vapid), enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/**
 * The payload encrypted for one subscription (RFC 8291): one aes128gcm record
 * with its header. `local` and `salt` are only passed by the tests.
 */
export async function encrypt(payload, { p256dh, auth }, { local, salt } = {}) {
  const uaPublic = fromB64u(p256dh), authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('bad p256dh');
  if (authSecret.length < 16) throw new Error('bad auth');
  local ||= await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  salt ||= crypto.getRandomValues(new Uint8Array(16));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const text = typeof payload === 'string' ? enc.encode(payload) : payload;
  // 0x02 ends the last (and only) record.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(text, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, sealed);
}

/**
 * Sends one push. Returns { ok, gone, status }: gone is true when the push
 * service says the subscription no longer exists (404 or 410), so it can be forgotten.
 */
export async function sendPush(vapid, sub, message, { fetchImpl = fetch, ttl = 86400, urgency = 'normal', topic } = {}) {
  const endpoint = String(sub.endpoint || '');
  if (!/^https:\/\//.test(endpoint)) return { ok: false, gone: true, status: 0 };
  const body = await encrypt(typeof message === 'string' ? message : JSON.stringify(message), sub);
  const headers = {
    authorization: await vapidHeader(vapid, endpoint),
    'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
    ttl: String(ttl), urgency,
  };
  // A newer push with the same topic replaces one still waiting on the push service.
  if (topic && /^[A-Za-z0-9_-]{1,32}$/.test(topic)) headers.topic = topic;
  let res;
  try { res = await fetchImpl(endpoint, { method: 'POST', headers, body }); }
  catch { return { ok: false, gone: false, status: 0 }; }
  return { ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, status: res.status };
}
