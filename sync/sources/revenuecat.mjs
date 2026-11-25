// RevenueCat API v2, charts: revenue, proceeds, transactions, new and active
// customers, conversion to paying, and revenue by product, a row a day.
// Needs a v2 secret key with charts_metrics read access: <PREFIX>_REVENUECAT_API_KEY.
import { Rows, getJson, ymd, addDays, dateRange, sleep, keyPart } from '../lib/util.mjs';
import { ownEnv } from '../lib/env.mjs';

export const source = 'revenuecat';
const API = 'https://api.revenuecat.com/v2';
const STORE_ID = { ios: 'app_store', android: 'play_store' };
const byStore = (name) => (/play/i.test(name || '') ? 'android' : /^app store/i.test(name || '') ? 'ios' : null);
const byPlatform = (name) => (/^ios$/i.test(name || '') ? 'ios' : /^android$/i.test(name || '') ? 'android' : null);

export async function run(ctx) {
  const { game, env, fetchImpl, days, platforms, today } = ctx;
  const key = ownEnv(env, game, 'REVENUECAT_API_KEY');
  if (!key) return { status: 'skipped', message: `Not connected: set ${game.env_prefix}_REVENUECAT_API_KEY` };
  const headers = { authorization: `Bearer ${key}` };
  const from = addDays(today, -days), dates = dateRange(from, today);

  let project = ownEnv(env, game, 'REVENUECAT_PROJECT_ID');
  if (!project) {
    const list = await getJson(fetchImpl, `${API}/projects`, { headers });
    project = list.items?.[0]?.id;
    if (!project) return { status: 'error', message: 'The key sees no RevenueCat project' };
  }

  let calls = 0;
  const chart = async (name, params = {}) => {
    if (calls++) await sleep(ctx.pause ?? 250); // the charts endpoints allow about 25 calls a minute
    const qs = new URLSearchParams({ start_date: from, end_date: today, resolution: 'day', ...params });
    const j = await getJson(fetchImpl, `${API}/projects/${project}/charts/${name}?${qs}`, { headers });
    const measures = (j.measures || []).map((m) => m.display_name);
    const segments = j.segments || null;
    return (j.values || []).map((v) => ({
      date: ymd(v.cohort * 1000), value: +v.value || 0, incomplete: !!v.incomplete,
      measure: measures[v.measure ?? 0] || '',
      segment: segments ? segments[v.segment ?? 0]?.display_name ?? '' : null,
      total: segments ? !!segments[v.segment ?? 0]?.is_total : false,
    }));
  };

  const rows = new Rows(game.slug, source);
  const live = new Set(platforms);
  const zero = (keys) => { for (const d of dates) for (const p of [...platforms, 'all']) for (const k of keys) rows.add(p, d, k, 0, d === today ? 'max' : undefined); };
  // A value for one live platform, also added into "all".
  const put = (p, c, key) => { const mode = c.incomplete ? 'max' : undefined; rows.add(p, c.date, key, c.value, mode); rows.add('all', c.date, key, c.value, mode); };
  const notes = [];

  // Revenue and transactions by store (the Test Store's are left out).
  zero(['revenue', 'transactions', 'proceeds']);
  for (const c of await chart('revenue', { segment: 'store' })) {
    const p = byStore(c.segment); if (c.total || !live.has(p)) continue;
    if (/^revenue/i.test(c.measure)) put(p, c, 'revenue'); else if (/transaction/i.test(c.measure)) put(p, c, 'transactions');
  }
  for (const c of await chart('revenue', { segment: 'store', selectors: JSON.stringify({ revenue_type: 'proceeds' }) })) {
    const p = byStore(c.segment); if (c.total || !live.has(p)) continue;
    if (/^proceeds/i.test(c.measure)) put(p, c, 'proceeds');
  }

  // Revenue by product, a store at a time.
  for (const p of platforms) {
    const cells = await chart('revenue', { segment: 'product_id', filters: JSON.stringify([{ name: 'store', values: [STORE_ID[p]] }]) });
    for (const c of cells) {
      if (c.total || !c.segment || !c.value) continue;
      const id = keyPart(c.segment);
      if (/^revenue/i.test(c.measure)) put(p, c, `revenue_by_product:${id}`); else if (/transaction/i.test(c.measure)) put(p, c, `transactions_by_product:${id}`);
    }
  }

  // New and active customers by platform.
  for (const [name, key] of [['customers_new', 'new_customers'], ['customers_active', 'active_customers']]) {
    try {
      const cells = await chart(name, { segment: 'platform' });
      zero([key]);
      for (const c of cells) { const p = byPlatform(c.segment); if (!c.total && live.has(p)) { rows.add(p, c.date, key, c.value); rows.add('all', c.date, key, c.value); } }
    } catch (e) { notes.push(`${name}: ${e.message}`); }
  }

  // Conversion to paying within 7 days, by the day a customer was first seen.
  try {
    let cells = null, seg = null;
    for (const s of ['platform', 'first_platform', null]) {
      try { cells = await chart('conversion_to_paying', s ? { segment: s } : {}); seg = s; break; } catch (e) { if (e.status !== 400) throw e; }
    }
    if (cells) {
      zero(['conv_cohort_size', 'new_paying_customers']);
      for (const c of cells) {
        const key = /^new customers/i.test(c.measure) ? 'conv_cohort_size' : /^paying customers/i.test(c.measure) ? 'new_paying_customers' : null;
        if (!key) continue;
        if (seg) { const p = byPlatform(c.segment); if (!c.total && live.has(p)) { rows.add(p, c.date, key, c.value); rows.add('all', c.date, key, c.value); } }
        else { rows.add('all', c.date, key, c.value); if (platforms.length === 1) rows.add(platforms[0], c.date, key, c.value); }
      }
    }
  } catch (e) { notes.push(`conversion_to_paying: ${e.message}`); }

  const daily = rows.daily;
  const sum = (k) => daily.filter((r) => r.platform === 'all' && r.metric_key === k).reduce((a, r) => a + r.metric_value, 0);
  return {
    status: 'ok', daily, hourly: [],
    message: `${daily.length} rows, ${days} days: $${sum('revenue').toFixed(2)} revenue, ${sum('transactions')} transactions, ${sum('new_customers')} new customers${notes.length ? '. ' + notes.join('; ') : ''}`,
  };
}
