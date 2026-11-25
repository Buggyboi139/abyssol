// PostHog Query API (HogQL): daily and weekly active users, sessions, new
// users, day 1 to day 30 retention, the first-steps and store funnels, unclean
// exits, errors, and where the graphics level settled.
//
// What the game must send for this to fill in (README.md, PostHog events):
//   - event names as the game's analytics ids: FTUE:01_Loaded, Store:Tap:<product>,
//     Session:UncleanExit:<Loading|Playing>, Gfx:Level:<1-6>, App:Error
//   - a `platform` property of ios or android (PostHog's own $os is the fallback)
// Needs POSTHOG_PERSONAL_API_KEY (query:read) and <PREFIX>_POSTHOG_PROJECT_ID.
import { Rows, getJson, addDays, dateRange, keyPart } from '../lib/util.mjs';
import { ownEnv, sharedEnv } from '../lib/env.mjs';

export const source = 'posthog';
const RETENTION_DAYS = [1, 3, 7, 14, 30];
const platformOf = (raw) => { const s = String(raw || '').toLowerCase(); return /^(ios|iphone|ipad)/.test(s) ? 'ios' : /^android/.test(s) ? 'android' : 'other'; };

export async function run(ctx) {
  const { game, env, fetchImpl, days, platforms, today, now } = ctx;
  const key = sharedEnv(env, game, 'POSTHOG_PERSONAL_API_KEY'), project = ownEnv(env, game, 'POSTHOG_PROJECT_ID');
  if (!key || !project) return { status: 'skipped', message: `Not connected: set POSTHOG_PERSONAL_API_KEY and ${game.env_prefix}_POSTHOG_PROJECT_ID` };
  const host = (sharedEnv(env, game, 'POSTHOG_HOST') || 'https://us.posthog.com').replace(/\/+$/, '');
  const prop = game.posthog?.platform_property || 'platform', errorEvent = game.posthog?.error_event || 'App:Error';
  if (!/^[A-Za-z0-9_$]+$/.test(prop) || /['\\]/.test(errorEvent)) return { status: 'error', message: 'config/games.json: posthog.platform_property or error_event has characters a query cannot hold' };

  const hogql = async (query) => {
    const j = await getJson(fetchImpl, `${host}/api/projects/${encodeURIComponent(project)}/query/`, {
      method: 'POST', timeout: 60000,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query }, name: 'abyssol-sync' }),
    });
    const cols = j.columns || [];
    return (j.results || []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
  };

  const from = addDays(today, -days), end = addDays(today, 1), dates = dateRange(from, today);
  const P = `lower(coalesce(toString(properties.${prop}), toString(properties.$os), ''))`;
  const span = (a, b) => `timestamp >= toDateTime('${a} 00:00:00') and timestamp < toDateTime('${b} 00:00:00')`;
  const day = (v) => String(v).slice(0, 10);

  const rows = new Rows(game.slug, source);
  const live = new Set(platforms);
  const put = (raw, date, k, v) => { const p = platformOf(raw); if (!live.has(p)) return; rows.add(p, date, k, +v || 0); rows.add('all', date, k, +v || 0); };
  const zero = (keys, ds = dates) => { for (const d of ds) for (const p of [...platforms, 'all']) for (const k of keys) rows.add(p, d, k, 0); };
  const failed = []; let okCount = 0;
  const step = async (name, fn) => { try { await fn(); okCount++; } catch (e) { failed.push(`${name}: ${e.message}`); } };

  // Daily active users and sessions. A session is PostHog's $session_id, or,
  // where the SDK sends none, a launch (Session:Open:* or FTUE:01_Loaded).
  await step('actives', async () => {
    const r = await hogql(`select toDate(timestamp) as day, ${P} as platform, uniq(distinct_id) as users, uniq(properties.$session_id) as sessions, countIf(event like 'Session:Open:%' or event = 'FTUE:01_Loaded') as launches from events where ${span(from, end)} group by day, platform order by day limit 50000`);
    zero(['dau', 'sessions']);
    for (const x of r) { put(x.platform, day(x.day), 'dau', x.users); put(x.platform, day(x.day), 'sessions', Math.max(+x.sessions || 0, +x.launches || 0)); }
  });

  // Weekly active users: everyone seen in the seven days ending on each day.
  await step('wau', async () => {
    const r = await hogql(`select addDays(day, arrayJoin(range(7))) as wday, platform, uniq(distinct_id) as users from (select toDate(timestamp) as day, distinct_id, ${P} as platform from events where ${span(addDays(from, -6), end)} group by day, distinct_id, platform) group by wday, platform having wday >= toDate('${from}') and wday <= toDate('${today}') limit 50000`);
    zero(['wau']);
    for (const x of r) put(x.platform, day(x.wday), 'wau', x.users);
  });

  // New users by first day, and how many of each day's came back 1, 3, 7, 14, and 30 days on.
  await step('retention', async () => {
    const cohortFrom = addDays(today, -Math.max(days, 31));
    const back = RETENTION_DAYS.map((n) => `countIf(has(days, addDays(first_day, ${n}))) as d${n}`).join(', ');
    const r = await hogql(`select first_day, platform, count() as cohort, ${back} from (select distinct_id, min(toDate(timestamp)) as first_day, groupUniqArray(toDate(timestamp)) as days, any(${P}) as platform from events group by distinct_id) where first_day >= toDate('${cohortFrom}') and first_day <= toDate('${today}') group by first_day, platform limit 50000`);
    zero(['new_users', ...RETENTION_DAYS.map((n) => `retained_d${n}`)], dateRange(cohortFrom, today));
    for (const x of r) { put(x.platform, day(x.first_day), 'new_users', x.cohort); for (const n of RETENTION_DAYS) put(x.platform, day(x.first_day), `retained_d${n}`, x[`d${n}`]); }
  });

  // The funnels and the trouble counters, from the game's own event ids.
  await step('events', async () => {
    const r = await hogql(`select toDate(timestamp) as day, ${P} as platform, event, count() as n, uniq(distinct_id) as users from events where ${span(from, end)} and (event like 'FTUE:%' or event like 'Store:%' or event like 'Session:UncleanExit%' or event = '${errorEvent}' or event like 'Gfx:Level:%') group by day, platform, event limit 50000`);
    zero(['unclean_exits', 'app_errors']);
    for (const x of r) {
      const d = day(x.day), parts = String(x.event).split(':');
      if (parts[0] === 'FTUE') { if (parts[1] && parts[1] !== 'Start') put(x.platform, d, `ftue:${keyPart(parts[1])}`, x.users); }
      else if (parts[0] === 'Store') { if (parts[1]) put(x.platform, d, `store:${keyPart(parts[1])}`, x.n); }
      else if (parts[0] === 'Session') { put(x.platform, d, 'unclean_exits', x.n); if (parts[2]) put(x.platform, d, `unclean_exit:${keyPart(parts[2])}`, x.n); }
      else if (parts[0] === 'Gfx') { if (parts[2]) put(x.platform, d, `gfx_level:${keyPart(parts[2])}`, x.users); }
      else if (x.event === errorEvent) put(x.platform, d, 'app_errors', x.n);
    }
  });

  // The last 48 hours, by the hour.
  await step('hourly', async () => {
    const start = new Date(Math.floor(now / 3600000) * 3600000 - 47 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
    const r = await hogql(`select toStartOfHour(timestamp) as hour, ${P} as platform, uniq(distinct_id) as users, count() as n from events where timestamp >= toDateTime('${start}') group by hour, platform limit 50000`);
    for (const x of r) {
      const p = platformOf(x.platform); if (!live.has(p)) continue;
      const h = new Date(String(x.hour).replace(' ', 'T').replace(/(Z|[+-]\d\d:?\d\d)?$/, 'Z')).toISOString();
      for (const q of [p, 'all']) { rows.addHour(q, h, 'active_users', +x.users || 0); rows.addHour(q, h, 'events', +x.n || 0); }
    }
  });

  if (!okCount) return { status: 'error', message: failed.join('; ') };
  const daily = rows.daily, hourly = rows.hourly;
  const dau = daily.filter((r) => r.platform === 'all' && r.metric_key === 'dau');
  const avg = dau.length ? dau.reduce((a, r) => a + r.metric_value, 0) / dau.length : 0;
  return { status: 'ok', daily, hourly, message: `${daily.length + hourly.length} rows, ${days} days: ${avg.toFixed(1)} average DAU${failed.length ? '. Failed: ' + failed.join('; ') : ''}` };
}
