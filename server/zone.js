// One clock for the dashboard. Every day the live sources report is a day in
// the reporting time zone (config/games.json, "timezone"), so a day's numbers
// from different sources cover the same hours. No dependencies: Intl only.

const parts = new Map();
function wall(ms, zone) {
  let f = parts.get(zone);
  if (!f) parts.set(zone, f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = +p.value;
  return o;
}

/** How far the zone's wall clock is ahead of UTC at that instant, in ms. */
export function offsetMs(ms, zone) {
  const w = wall(ms, zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/** The zone's calendar day at an instant, as YYYY-MM-DD. */
export function dayIn(ms, zone = 'UTC') {
  const w = wall(ms, zone), p = (n) => String(n).padStart(2, '0');
  return `${w.year}-${p(w.month)}-${p(w.day)}`;
}

/** The instant a calendar day starts in the zone, in ms. */
export function dayStart(date, zone = 'UTC') {
  const guess = Date.parse(`${date}T00:00:00Z`);
  let t = guess - offsetMs(guess, zone);
  // Once more, in case the offset differs on the other side of a clock change.
  t = guess - offsetMs(t, zone);
  return t;
}

/** "Pacific time", "Central time", "UTC": what to call the zone on screen. */
export function zoneName(zone, ms = Date.now()) {
  if (zone === 'UTC') return 'UTC';
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value;
    return name ? name.replace(/ Time$/, ' time') : zone;
  } catch { return zone; }
}
