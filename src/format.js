// How numbers, dates, and changes are written, in one place.

const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDay = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const exact = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const hourFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric' });

export function fmt(v, format) {
  if (v == null || Number.isNaN(v)) return '—';
  switch (format) {
    case 'usd': return Math.abs(v) >= 10000 ? usd0.format(v) : usd2.format(v);
    case 'int': return whole.format(Math.round(v));
    case 'num': return Math.abs(v) < 100 ? one.format(v) : whole.format(v);
    case 'pct': { const p = v * 100; return `${p === 0 || Math.abs(p) >= 10 ? one.format(p) : p.toFixed(2)}%`; }
    case 'rating': return `${v.toFixed(2)} / 5`;
    case 'secs': return `${v < 10 ? v.toFixed(1) : whole.format(v)} s`;
    case 'rank': return `#${whole.format(v)}`;
    default: return String(v);
  }
}

/** A short form for axis ticks. */
export function tick(v, format) {
  if (format === 'usd') return Math.abs(v) >= 1000 ? `$${compact.format(v)}` : `$${Number.isInteger(v) ? v : v.toFixed(2)}`;
  if (format === 'pct') return `${one.format(v * 100)}%`;
  return Math.abs(v) >= 1000 ? compact.format(v) : whole.format(v);
}

export const day = (d) => dayFmt.format(new Date(`${d}T00:00:00Z`));
export const fullDay = (d) => longDay.format(new Date(`${d}T00:00:00Z`));
export const moment = (iso) => exact.format(new Date(iso));
export const time = (iso) => clock.format(new Date(iso));
export const hour = (iso) => hourFmt.format(new Date(iso));
/** A clock time in the reporting zone, with the zone's short name: "12:00 AM PST". */
export function clockIn(iso, zone) {
  try { return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone, timeZoneName: 'short' }).format(new Date(iso)); }
  catch { return clock.format(new Date(iso)); }
}
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
export const dateOf = (iso) => dateFmt.format(new Date(iso));

export function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** "12.4%" or "1.2 pts" for a change, without its direction. */
export function deltaText(d) {
  if (!d) return '';
  if (d.unit === 'new') return 'New';
  if (d.dir === 0) return 'No change';
  const v = Math.abs(d.value);
  return d.unit === 'pp' ? `${v < 10 ? v.toFixed(2) : one.format(v)} pts` : `${v >= 1000 ? compact.format(v) : one.format(v)}%`;
}
