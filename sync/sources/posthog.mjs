// PostHog Query API (HogQL): daily and weekly active users, sessions, new
// users, day 1 to day 30 retention, the first-steps and store funnels, unclean
// exits, errors, load times, where the graphics level settled, the last 48
// hours by the hour, and what the last day's players did, told in a few lines
// each. A day is a day in the reporting time zone (config/games.json,
// "timezone"), as it is for every other source. Fact posthog.gfx: for each of
// the dashboard's ranges, how many different players last settled on each
// graphics level (the daily gfx_level rows count a player again every day).
//
// What the game must send for this to fill in (README.md, PostHog events):
//   - event names as the game's analytics ids: FTUE:01_Loaded, Load:Ready, Store:Tap:<product>,
//     Session:UncleanExit:<Loading|Playing>, Gfx:Level:<1-6>, App:Error
//   - a `platform` property of ios or android (PostHog's own $os is the fallback)
// Needs <PREFIX>_POSTHOG_PROJECT_ID and a personal key (query:read): the shared POSTHOG_PERSONAL_API_KEY, scoped to
// every game's project, or <PREFIX>_POSTHOG_PERSONAL_API_KEY for a game whose project is in another PostHog account.
import { Rows, getJson, addDays, dateRange, keyPart, DAY, RANGES } from '../lib/util.mjs';
import { ownEnv, sharedEnv } from '../lib/env.mjs';
import { dayStart } from '../../server/zone.js';
import { tell } from '../lib/stories.mjs';

export const source = 'posthog';
const RETENTION_DAYS = [1, 3, 7, 14, 30];
const STORY_PLAYERS = 40, HOUR = 3600000;
// One name a step across the games: Chillwater Lake says Store:Open, Store:Buy and Store:Fail where Pearl Tide says
// Shop:Open, Store:Tap and Store:Error.
const STORE_STEP = { Buy: 'Tap', Fail: 'Error' };
const platformOf = (raw) => { const s = String(raw || '').toLowerCase(); return /^(ios|iphone|ipad)/.test(s) ? 'ios' : /^android/.test(s) ? 'android' : 'other'; };
const ms = (v) => Date.parse(String(v).replace(' ', 'T').replace(/(Z|[+-]\d\d:?\d\d)?$/, 'Z'));

export async function run(ctx) {
  const { game, env, fetchImpl, days, platforms, today, now, zone = 'UTC' } = ctx;
  const key = sharedEnv(env, game, 'POSTHOG_PERSONAL_API_KEY'), project = ownEnv(env, game, 'POSTHOG_PROJECT_ID');
  if (!key || !project) return { status: 'skipped', message: `Not connected: set POSTHOG_PERSONAL_API_KEY and ${game.env_prefix}_POSTHOG_PROJECT_ID` };
  const host = (sharedEnv(env, game, 'POSTHOG_HOST') || 'https://us.posthog.com').replace(/\/+$/, '');
  const prop = game.posthog?.platform_property || 'platform', errorEvent = game.posthog?.error_event || 'App:Error';
  if (!/^[A-Za-z0-9_$]+$/.test(prop) || /['\\]/.test(errorEvent)) return { status: 'error', message: 'config/games.json: posthog.platform_property or error_event has characters a query cannot hold' };
  if (!/^[A-Za-z0-9_+\-/]+$/.test(zone)) return { status: 'error', message: 'config/games.json: timezone has characters a query cannot hold' };

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
  const D = `toDate(toTimeZone(timestamp, '${zone}'))`; // the reporting zone's day
  const at = (t) => `toDateTime('${new Date(t).toISOString().slice(0, 19).replace('T', ' ')}', 'UTC')`;
  const span = (a, b) => `timestamp >= ${at(dayStart(a, zone))} and timestamp < ${at(dayStart(b, zone))}`;
  const day = (v) => String(v).slice(0, 10);

  const rows = new Rows(game.slug, source), facts = [];
  const live = new Set(platforms);
  const put = (raw, date, k, v) => { const p = platformOf(raw); if (!live.has(p)) return; rows.add(p, date, k, +v || 0); rows.add('all', date, k, +v || 0); };
  const zero = (keys, ds = dates) => { for (const d of ds) for (const p of [...platforms, 'all']) for (const k of keys) rows.add(p, d, k, 0); };
  const failed = []; let okCount = 0;
  const step = async (name, fn) => { try { await fn(); okCount++; } catch (e) { failed.push(`${name}: ${e.message}`); } };

  // Daily active users and sessions. A session is PostHog's $session_id, or,
  // where the SDK sends none, a launch (Load:Ready, which both games send once
  // a launch; else Session:Open:* or FTUE:01_Loaded). With them: how long the
  // launches took, and how many lost the graphics context or fell back to lite graphics.
  await step('actives', async () => {
    const r = await hogql(`select ${D} as day, ${P} as platform, uniq(distinct_id) as users, uniq(properties.$session_id) as sessions, countIf(event = 'Load:Ready') as loads, countIf(event like 'Session:Open:%' or event = 'FTUE:01_Loaded') as opens, sumIf(toFloat(properties.value), event = 'Load:Ready') as load_secs, countIf(event = 'Load:ContextLost') as lost, uniqIf(distinct_id, event like 'Gfx:Lite:%') as lite from events where ${span(from, end)} group by day, platform order by day limit 50000`);
    zero(['dau', 'sessions', 'loads', 'load_secs', 'context_lost', 'gfx_lite']);
    for (const x of r) {
      const d = day(x.day);
      put(x.platform, d, 'dau', x.users); put(x.platform, d, 'sessions', Math.max(+x.sessions || 0, +x.loads || 0, +x.opens || 0));
      put(x.platform, d, 'loads', x.loads); put(x.platform, d, 'load_secs', x.load_secs); put(x.platform, d, 'context_lost', x.lost); put(x.platform, d, 'gfx_lite', x.lite);
    }
  });

  // Weekly active users: everyone seen in the seven days ending on each day.
  await step('wau', async () => {
    const r = await hogql(`select addDays(day, arrayJoin(range(7))) as wday, platform, uniq(distinct_id) as users from (select ${D} as day, distinct_id, ${P} as platform from events where ${span(addDays(from, -6), end)} group by day, distinct_id, platform) group by wday, platform having wday >= toDate('${from}') and wday <= toDate('${today}') limit 50000`);
    zero(['wau']);
    for (const x of r) put(x.platform, day(x.wday), 'wau', x.users);
  });

  // New users by first day, and how many of each day's came back 1, 3, 7, 14, and 30 days on.
  await step('retention', async () => {
    const cohortFrom = addDays(today, -Math.max(days, 31));
    const back = RETENTION_DAYS.map((n) => `countIf(has(days, addDays(first_day, ${n}))) as d${n}`).join(', ');
    const r = await hogql(`select first_day, platform, count() as cohort, ${back} from (select distinct_id, min(${D}) as first_day, groupUniqArray(${D}) as days, any(${P}) as platform from events group by distinct_id) where first_day >= toDate('${cohortFrom}') and first_day <= toDate('${today}') group by first_day, platform limit 50000`);
    zero(['new_users', ...RETENTION_DAYS.map((n) => `retained_d${n}`)], dateRange(cohortFrom, today));
    for (const x of r) { put(x.platform, day(x.first_day), 'new_users', x.cohort); for (const n of RETENTION_DAYS) put(x.platform, day(x.first_day), `retained_d${n}`, x[`d${n}`]); }
  });

  // The funnels and the trouble counters, from the game's own event ids.
  await step('events', async () => {
    const r = await hogql(`select ${D} as day, ${P} as platform, event, count() as n, uniq(distinct_id) as users from events where ${span(from, end)} and (event like 'FTUE:%' or event like 'Store:%' or event like 'Shop:Open%' or event like 'Session:UncleanExit%' or event = '${errorEvent}' or event like 'Gfx:Level:%') group by day, platform, event limit 50000`);
    zero(['unclean_exits', 'app_errors']);
    for (const x of r) {
      const d = day(x.day), parts = String(x.event).split(':');
      if (parts[0] === 'FTUE') { if (parts[1] && parts[1] !== 'Start') put(x.platform, d, `ftue:${keyPart(parts[1])}`, x.users); }
      else if (parts[0] === 'Store') { if (parts[1]) put(x.platform, d, `store:${keyPart(STORE_STEP[parts[1]] || parts[1])}`, x.n); }
      else if (parts[0] === 'Shop') put(x.platform, d, 'store:Open', x.n);
      else if (parts[0] === 'Session') { put(x.platform, d, 'unclean_exits', x.n); if (parts[2]) put(x.platform, d, `unclean_exit:${keyPart(parts[2])}`, x.n); }
      else if (parts[0] === 'Gfx') { if (parts[2]) put(x.platform, d, `gfx_level:${keyPart(parts[2])}`, x.users); }
      else if (x.event === errorEvent) put(x.platform, d, 'app_errors', x.n);
    }
  });

  // Graphics level, each player once: where a player last settled in each of the dashboard's ranges. A day's
  // gfx_level row counts that day's players, so adding 30 of them counts someone who plays daily 30 times.
  await step('gfx', async () => {
    const ranges = {};
    for (const [k, n] of Object.entries(RANGES)) {
      const r = await hogql(`select platform, gfx_level, count() as players from (select distinct_id, any(${P}) as platform, argMax(event, timestamp) as gfx_level from events where timestamp >= ${at(dayStart(addDays(today, -(n - 1)), zone))} and event like 'Gfx:Level:%' group by distinct_id) group by platform, gfx_level limit 1000`);
      const out = { all: {}, ...Object.fromEntries(platforms.map((p) => [p, {}])) };
      for (const x of r) {
        const p = platformOf(x.platform), level = String(x.gfx_level).split(':')[2];
        if (!live.has(p) || !level) continue;
        for (const o of [out[p], out.all]) o[keyPart(level)] = (o[keyPart(level)] || 0) + (+x.players || 0);
      }
      ranges[k] = out;
    }
    facts.push({ key: 'posthog.gfx', value: { as_of: new Date(now).toISOString(), zone, ranges } });
  });

  // The last 48 hours, by the hour: who was playing, and who was seen for the first time.
  const hourStart = Math.floor(now / HOUR) * HOUR - 47 * HOUR;
  const hourOf = (v) => new Date(ms(v)).toISOString();
  await step('hourly', async () => {
    const r = await hogql(`select toStartOfHour(timestamp) as hour, ${P} as platform, uniq(distinct_id) as users, count() as n from events where timestamp >= ${at(hourStart)} group by hour, platform limit 50000`);
    for (let t = hourStart; t <= now; t += HOUR) for (const p of [...platforms, 'all']) { const h = new Date(t).toISOString(); rows.addHour(p, h, 'active_users', 0); rows.addHour(p, h, 'new_users', 0); }
    for (const x of r) {
      const p = platformOf(x.platform); if (!live.has(p)) continue;
      for (const q of [p, 'all']) { rows.addHour(q, hourOf(x.hour), 'active_users', +x.users || 0); rows.addHour(q, hourOf(x.hour), 'events', +x.n || 0); }
    }
    const f = await hogql(`select toStartOfHour(first) as hour, platform, count() as n from (select distinct_id, min(timestamp) as first, any(${P}) as platform from events group by distinct_id) where first >= ${at(hourStart)} group by hour, platform limit 50000`);
    for (const x of f) { const p = platformOf(x.platform); if (live.has(p)) for (const q of [p, 'all']) rows.addHour(q, hourOf(x.hour), 'new_users', +x.n || 0); }
  });

  // Right now: today in the reporting zone and the last 24 hours.
  const todayStart = dayStart(today, zone), dayAgo = now - DAY;
  await step('live', async () => {
    const A = at(dayAgo), T = at(todayStart);
    const r = await hogql(`select platform, countIf(last >= ${A}) as active24, countIf(last >= ${A} and first >= ${A}) as new24, countIf(last >= ${A} and first < ${A}) as back24, sumIf(bought, last >= ${A}) as bought24, countIf(last >= ${T}) as active, countIf(first >= ${T}) as fresh, countIf(last >= ${T} and first < ${T}) as back, count() as everyone from (select distinct_id, min(timestamp) as first, max(timestamp) as last, any(${P}) as platform, countIf(event like 'Store:Bought%' and timestamp >= ${A}) as bought from events group by distinct_id) group by platform limit 100`);
    const blank = () => ({ today: { date: today, new: 0, active: 0, returning: 0 }, last24h: { new: 0, active: 0, returning: 0, purchases: 0 }, players: 0 });
    const out = { all: blank(), ...Object.fromEntries(platforms.map((p) => [p, blank()])) };
    for (const x of r) {
      const p = platformOf(x.platform); if (!live.has(p)) continue;
      for (const o of [out[p], out.all]) {
        o.today.new += +x.fresh || 0; o.today.active += +x.active || 0; o.today.returning += +x.back || 0;
        o.last24h.new += +x.new24 || 0; o.last24h.active += +x.active24 || 0; o.last24h.returning += +x.back24 || 0; o.last24h.purchases += +x.bought24 || 0;
        o.players += +x.everyone || 0;
      }
    }
    facts.push({ key: 'posthog.live', value: { as_of: new Date(now).toISOString(), zone, day_started: new Date(todayStart).toISOString(), ...out } });
  });

  // What the last day's players did, the most recent first.
  await step('stories', async () => {
    const A = at(dayAgo), who = `select distinct_id from events where timestamp >= ${A} group by distinct_id order by max(timestamp) desc limit ${STORY_PLAYERS}`;
    const seen = await hogql(`select distinct_id, min(timestamp) as first, max(timestamp) as last, any(${P}) as platform, argMax(toString(properties.app_version), timestamp) as version, argMax(toString(properties.$geoip_country_code), timestamp) as country from events where distinct_id in (${who}) group by distinct_id limit ${STORY_PLAYERS * 2}`);
    const ev = seen.length ? await hogql(`select distinct_id, event, count() as n, sum(toFloat(properties.value)) as total, max(toFloat(properties.value)) as most, groupUniqArray(toString(properties.chapter)) as chapters from events where timestamp >= ${A} and distinct_id in (${who}) group by distinct_id, event limit 20000`) : [];
    const events = new Map();
    for (const e of ev) { if (!events.has(e.distinct_id)) events.set(e.distinct_id, []); events.get(e.distinct_id).push({ event: String(e.event), n: +e.n || 0, sum: +e.total || 0, max: +e.most || 0, chapters: (Array.isArray(e.chapters) ? e.chapters : []).map(String).filter((c) => c && c !== 'null') }); }
    const players = seen.map((s) => ({ id: s.distinct_id, platform: platformOf(s.platform), version: s.version && s.version !== 'null' ? s.version : '', country: s.country && s.country !== 'null' ? s.country : '', first: ms(s.first), last: ms(s.last), events: events.get(s.distinct_id) || [] }))
      .filter((p) => live.has(p.platform) && p.last >= dayAgo).sort((a, b) => b.last - a.last).slice(0, STORY_PLAYERS);
    facts.push({ key: 'posthog.stories', value: { as_of: new Date(now).toISOString(), since: new Date(dayAgo).toISOString(), limit: STORY_PLAYERS, players: players.map((p) => tell(p, dayAgo)) } });
  });

  if (!okCount) return { status: 'error', message: failed.join('; ') };
  const daily = rows.daily, hourly = rows.hourly;
  const dau = daily.filter((r) => r.platform === 'all' && r.metric_key === 'dau');
  const avg = dau.length ? dau.reduce((a, r) => a + r.metric_value, 0) / dau.length : 0;
  return { status: 'ok', daily, hourly, facts, message: `${daily.length + hourly.length} rows, ${days} days: ${avg.toFixed(1)} average DAU${failed.length ? '. Failed: ' + failed.join('; ') : ''}` };
}
