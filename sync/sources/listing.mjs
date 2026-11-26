// The store listing, as a shopper sees it and as App Store Connect reports it:
//   - the rating and how many ratings, a storefront at a time (iTunes lookup, no key)
//   - where the app comes up for each search term in config/games.json (iTunes search, no key)
//   - each version's state (on sale, waiting for review, ...) and the written
//     reviews (App Store Connect; the App Manager role is enough)
// A number a day goes to metrics (rating, rating_count, reviews_total,
// rank_<term>); the rest is kept as facts (listing.ios, listing.search).
// Google Play's rating comes with the google source.
import fs from 'node:fs';
import { Rows, getJson, signJwt, pem, keyPart, sleep } from '../lib/util.mjs';
import { sharedEnv } from '../lib/env.mjs';

export const source = 'listing';
const ASC = 'https://api.appstoreconnect.apple.com', ITUNES = 'https://itunes.apple.com';
const RANK_DEPTH = 200;
const RANK_HISTORY = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../../config/rank-history.json', import.meta.url), 'utf8')); }
  catch { return {}; }
})();

const STATE = {
  READY_FOR_SALE: 'On sale', READY_FOR_DISTRIBUTION: 'On sale', WAITING_FOR_REVIEW: 'Waiting for review', IN_REVIEW: 'In review',
  PENDING_DEVELOPER_RELEASE: 'Approved, waiting for release', PENDING_APPLE_RELEASE: 'Approved, waiting for Apple', ACCEPTED: 'Accepted',
  PREPARE_FOR_SUBMISSION: 'Being prepared', READY_FOR_REVIEW: 'Ready for review', PROCESSING_FOR_APP_STORE: 'Processing', PROCESSING_FOR_DISTRIBUTION: 'Processing',
  REJECTED: 'Rejected', METADATA_REJECTED: 'Rejected (metadata)', INVALID_BINARY: 'Invalid build', DEVELOPER_REJECTED: 'Pulled from review',
  REPLACED_WITH_NEW_VERSION: 'Replaced', REMOVED_FROM_SALE: 'Removed from sale', DEVELOPER_REMOVED_FROM_SALE: 'Removed from sale', WAITING_FOR_EXPORT_COMPLIANCE: 'Waiting for export compliance',
};
const ON_SALE = /^(READY_FOR_SALE|READY_FOR_DISTRIBUTION)$/, DONE = /^(REPLACED_WITH_NEW_VERSION|REMOVED_FROM_SALE|DEVELOPER_REMOVED_FROM_SALE)$/;

/** "1.3.7" as [1, 3, 7], or null for anything that is not a plain release number (a debug build's "1.0-x"). */
export const versionParts = (v) => (/^\d+(\.\d+)*$/.test(String(v || '')) ? String(v).split('.').map(Number) : null);
export function versionNewer(a, b) {
  const x = versionParts(a), y = versionParts(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
  return false;
}

const lookup = async (ctx, appId, cc) => (await getJson(ctx.fetchImpl, `${ITUNES}/lookup?id=${encodeURIComponent(appId)}&country=${cc}`, { retries: 1 })).results?.[0] || null;

/**
 * The version on sale for a platform, for RevenueCat's tester rule: from this
 * run's listing pull, else one lookup. null when it cannot be told.
 */
export async function onSale(ctx, game, platform) {
  if (platform !== 'ios') return null;
  const id = `listing:${game.slug}:ios`;
  if (ctx.cache.has(id)) return ctx.cache.get(id).on_sale;
  const appId = game.platforms?.ios?.app_store_id;
  let v = null;
  try { v = appId ? (await lookup(ctx, appId, (game.storefronts || ['us'])[0]))?.version || null : null; } catch { /* the rule goes without it */ }
  ctx.cache.set(id, { on_sale: v });
  return v;
}

export async function run(ctx) {
  const { game, env, fetchImpl, platforms, today } = ctx;
  if (!platforms.includes('ios')) return { status: 'skipped', message: `iOS is not live (${game.platforms?.ios?.status || 'pre-launch'})` };
  const appId = game.platforms.ios.app_store_id;
  if (!appId) return { status: 'skipped', message: 'config/games.json has no platforms.ios.app_store_id' };
  const pause = () => sleep(ctx.pause ?? 400);
  const rows = new Rows(game.slug, source), notes = [];
  const put = (key, value, date = today) => { rows.add('ios', date, key, value); rows.add('all', date, key, value); };

  // ---- Rating, a storefront at a time ----
  const fronts = (game.storefronts?.length ? game.storefronts : ['us']).filter((c) => /^[a-z]{2}$/.test(c));
  const by = []; let app = null, failed = 0;
  for (const cc of fronts) {
    try {
      const a = await lookup(ctx, appId, cc);
      if (a) { app ||= a; if (a.userRatingCount > 0) by.push({ cc, rating: a.averageUserRating, count: a.userRatingCount }); }
    } catch { failed++; }
    await pause();
  }
  if (!app) return { status: 'error', message: `The App Store has no listing for app ${appId} in ${fronts.join(', ')}${failed ? ' (lookups failed)' : ''}` };
  if (failed) notes.push(`${failed} storefront lookups failed`);
  const count = by.reduce((a, s) => a + s.count, 0), rating = count ? by.reduce((a, s) => a + s.rating * s.count, 0) / count : null;
  if (rating != null) put('rating', rating);
  put('rating_count', count);

  // ---- Search ranks, in the first storefront ----
  const terms = [];
  for (const term of game.search_terms || []) {
    const key = `rank_${keyPart(term.toLowerCase())}`;
    try {
      const j = await getJson(fetchImpl, `${ITUNES}/search?term=${encodeURIComponent(term)}&country=${fronts[0]}&entity=software&limit=${RANK_DEPTH}`, { retries: 1 });
      const at = (j.results || []).findIndex((r) => String(r.trackId) === String(appId));
      terms.push({ term, key, rank: at < 0 ? null : at + 1 });
      if (at >= 0) put(key, at + 1);
    } catch (e) { notes.push(`search "${term}": ${e.message}`); }
    await pause();
  }
  const tracked = new Set((game.search_terms || []).map((t) => t.toLowerCase()));
  for (const [date, byTerm] of Object.entries(RANK_HISTORY[game.slug] || {})) {
    if (date >= today) continue;
    for (const [term, rank] of Object.entries(byTerm || {})) {
      if (typeof rank === 'number' && tracked.has(term.toLowerCase())) put(`rank_${keyPart(term.toLowerCase())}`, rank, date);
    }
  }

  // ---- Versions and written reviews, from App Store Connect ----
  let versions = null, reviews = null, reviewsTotal = null;
  const keyId = sharedEnv(env, game, 'ASC_KEY_ID'), issuer = sharedEnv(env, game, 'ASC_ISSUER_ID'), key = pem(sharedEnv(env, game, 'ASC_PRIVATE_KEY'));
  if (keyId && issuer && key) {
    const iat = Math.floor(ctx.now / 1000);
    const headers = { authorization: `Bearer ${signJwt({ alg: 'ES256', header: { kid: keyId }, payload: { iss: issuer, iat, exp: iat + 600, aud: 'appstoreconnect-v1' }, privateKey: key })}` };
    try {
      const j = await getJson(fetchImpl, `${ASC}/v1/apps/${appId}/appStoreVersions?limit=6&fields[appStoreVersions]=versionString,appStoreState,appVersionState,releaseType,createdDate,platform`, { headers });
      versions = (j.data || []).map((d) => d.attributes).filter((v) => !v.platform || v.platform === 'IOS')
        .map((v) => ({ version: v.versionString, state: v.appStoreState || v.appVersionState, label: STATE[v.appStoreState] || STATE[v.appVersionState] || String(v.appStoreState || '').toLowerCase().replace(/_/g, ' '), release: v.releaseType === 'MANUAL' ? 'manual' : v.releaseType === 'SCHEDULED' ? 'scheduled' : 'automatic', created: v.createdDate }));
    } catch (e) { notes.push(`versions: ${e.message}`); }
    try {
      const j = await getJson(fetchImpl, `${ASC}/v1/apps/${appId}/customerReviews?sort=-createdDate&limit=20`, { headers });
      reviewsTotal = j.meta?.paging?.total ?? (j.data || []).length;
      reviews = (j.data || []).map((d) => ({ rating: d.attributes.rating, title: d.attributes.title || '', body: String(d.attributes.body || '').slice(0, 1200), territory: d.attributes.territory || '', at: d.attributes.createdDate }));
      put('reviews_total', reviewsTotal);
    } catch (e) { notes.push(`reviews: ${e.message}`); }
  }

  const live = versions?.find((v) => ON_SALE.test(v.state));
  const onSaleVersion = live && !versionNewer(app.version, live.version) ? live.version : app.version;
  const pending = (versions || []).filter((v) => !ON_SALE.test(v.state) && !DONE.test(v.state) && versionNewer(v.version, onSaleVersion));
  ctx.cache.set(`listing:${game.slug}:ios`, { on_sale: onSaleVersion });

  const facts = [
    { key: 'listing.ios', value: {
      store: 'App Store', checked_at: new Date(ctx.now).toISOString(), rating, rating_count: count, by_storefront: by, storefronts: fronts,
      version: onSaleVersion, version_released: app.currentVersionReleaseDate || null, released: app.releaseDate || null,
      pending: pending.map(({ version, label, release, created }) => ({ version, label, release, created })),
      reviews_total: reviewsTotal, reviews: reviews || null, connected: versions !== null || reviews !== null,
    } },
    { key: 'listing.search', value: { store: 'App Store', storefront: fronts[0], depth: RANK_DEPTH, checked_at: new Date(ctx.now).toISOString(), terms } },
  ];
  const daily = rows.daily;
  return {
    status: 'ok', daily, hourly: [], facts,
    message: `${daily.length} rows: ${rating == null ? 'no ratings yet' : `${rating.toFixed(2)} from ${count} ratings`}, ${onSaleVersion} on sale${pending.length ? `, ${pending[0].version} ${pending[0].label.toLowerCase()}` : ''}, ${terms.filter((t) => t.rank).length} of ${terms.length} search terms ranked${notes.length ? '. ' + notes.join('; ') : ''}`,
  };
}
