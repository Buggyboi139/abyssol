// Shared helpers for the sync jobs. Node 20+ or Bun; no dependencies.
import crypto from 'node:crypto';

export const DAY = 86400000;
/** The dashboard's ranges, in days (the same as RANGES in server/metrics.js). A range ends today and is n days long. */
export const RANGES = { '7d': 7, '30d': 30, '90d': 90 };
export const ymd = (d) => new Date(d).toISOString().slice(0, 10);
export const addDays = (d, n) => ymd(new Date(d).getTime() + n * DAY);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

/** Every date from `from` to `to`, both included, as YYYY-MM-DD. */
export function dateRange(from, to) {
  const out = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) out.push(ymd(t));
  return out;
}

export class HttpError extends Error {
  constructor(status, url, body) {
    // The URL's query string can hold a signed link: keep the origin and path only.
    let where = url; try { const u = new URL(url); where = u.origin + u.pathname; } catch { /* as given */ }
    super(`HTTP ${status} from ${where}${body ? ': ' + String(body).slice(0, 240) : ''}`);
    this.status = status; this.body = body;
  }
}

/**
 * fetch with a timeout and retries on 429 and 5xx. Returns the Response.
 * `fetchImpl` lets tests and --mock serve fixtures.
 */
export async function request(fetchImpl, url, { method = 'GET', headers = {}, body, timeout = 30000, retries = 3, ok = [] } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeout) });
      if (r.ok || ok.includes(r.status)) return r;
      const text = await r.text().catch(() => '');
      last = new HttpError(r.status, url, text);
      if (r.status !== 429 && r.status < 500) throw last;
      const wait = Math.min(30, parseFloat(r.headers.get('retry-after')) || 2 ** i) * 1000;
      if (i < retries) await sleep(wait);
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      last = e;
      if (i < retries) await sleep(2 ** i * 500);
    }
  }
  throw last;
}

export async function getJson(fetchImpl, url, opts) {
  const r = await request(fetchImpl, url, opts);
  return r.json();
}

const b64url = (b) => Buffer.from(b).toString('base64url');

/** A signed JWT. alg ES256 (App Store Connect) or RS256 (Google service accounts). */
export function signJwt({ alg, header = {}, payload, privateKey }) {
  const head = b64url(JSON.stringify({ alg, typ: 'JWT', ...header }));
  const body = b64url(JSON.stringify(payload));
  const data = Buffer.from(head + '.' + body);
  const sig = alg === 'ES256'
    ? crypto.sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' })
    : crypto.sign('RSA-SHA256', data, privateKey);
  return head + '.' + body + '.' + b64url(sig);
}

/** A PEM from an environment variable: real newlines, or "\n" written out. */
export const pem = (s) => String(s || '').replace(/\\n/g, '\n').trim();

/** Rows of a tab- or comma-separated file as objects keyed by its header row. */
export function parseTable(text, sep = '\t') {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return [];
  const split = sep === ',' ? splitCsv : (l) => l.split('\t');
  const head = split(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((l) => { const c = split(l); const o = {}; head.forEach((h, i) => { o[h] = (c[i] ?? '').trim(); }); return o; });
}

function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** The first column of a row whose name matches, by a case-insensitive pattern. */
export function col(row, pattern) {
  const k = Object.keys(row).find((h) => pattern.test(h));
  return k === undefined ? undefined : row[k];
}

/** Collects metric rows, one per game, platform, source, key, and day or hour. Later values for the same cell add up. */
export class Rows {
  constructor(game, source) { this.game = game; this.source = source; this.d = new Map(); this.h = new Map(); }
  add(platform, date, key, value, mode) {
    if (!Number.isFinite(value)) return;
    const id = platform + '|' + date + '|' + key, was = this.d.get(id);
    this.d.set(id, { game_slug: this.game, platform, source: this.source, date, metric_key: key, metric_value: (was?.metric_value || 0) + value, ...(mode ? { mode } : {}) });
  }
  set(platform, date, key, value, mode) { this.d.delete(platform + '|' + date + '|' + key); this.add(platform, date, key, value, mode); }
  addHour(platform, hour, key, value) {
    if (!Number.isFinite(value)) return;
    const id = platform + '|' + hour + '|' + key, was = this.h.get(id);
    this.h.set(id, { game_slug: this.game, platform, source: this.source, bucket_hour: hour, metric_key: key, metric_value: (was?.metric_value || 0) + value });
  }
  get daily() { return [...this.d.values()]; }
  get hourly() { return [...this.h.values()]; }
}

/** A metric key segment safe to store: no colons beyond the one that separates the breakdown. */
export const keyPart = (s) => String(s ?? '').trim().replace(/[:\s]+/g, '_').slice(0, 80) || 'unknown';
