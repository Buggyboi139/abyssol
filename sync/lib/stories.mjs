// Turns one player's events over the last day into a few readable lines:
// who they are (new or returning, device, version), how the launch went, how
// far they got, where the time went, and anything that went wrong. Event names
// are the games' analytics ids, Category:Action:Label, so most of this reads
// any game; the few names it knows by heart are the ones both games send.
// Nothing here names a player: the tag is a hash of the analytics id.

const PLATFORM = { ios: 'iPhone or iPad', android: 'Android' };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const mins = (secs) => (secs >= 3600 ? `${(secs / 3600).toFixed(1)} h` : secs >= 90 ? `${Math.round(secs / 60)} min` : `${Math.max(1, Math.round(secs))} s`);
const words = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
const list = (xs) => (xs.length < 2 ? xs.join('') : xs.length === 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')}, and ${xs.at(-1)}`);

/** A short tag that stays the same for a player from run to run and cannot be turned back into the id. */
export function tagOf(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).toUpperCase().padStart(8, '0').slice(0, 5);
}

/**
 * One story. `p`: { id, platform, version, country, first (ms), last (ms), events: [{ event, n, sum, max }] },
 * `since` the start of the day being told (ms).
 */
export function tell(p, since) {
  const by = new Map(p.events.map((e) => [e.event, e]));
  const starts = (prefix) => p.events.filter((e) => e.event.startsWith(prefix));
  const count = (prefix) => starts(prefix).reduce((a, e) => a + e.n, 0);
  const lines = [], flags = [];
  const isNew = p.first >= since;

  // Session:Open:<2|3|4|5plus>, with the real count as its value from the fifth launch on.
  const launches = Math.max(0, ...starts('Session:Open:').map((e) => Math.max(parseInt(e.event.split(':')[2], 10) || 0, Math.round(e.max) || 0)));
  const orMore = launches === 5 && starts('Session:Open:').some((e) => /plus$/.test(e.event) && !(e.max >= 5));
  const screen = /^Device:Screen:(\d+)x(\d+)(?:_([\d.]+))?/.exec(starts('Device:Screen:')[0]?.event || '');
  const who = [
    isNew ? 'New player' : `Returning player${launches > 1 ? `, launch ${launches}${orMore ? ' or later' : ''}` : ''}`,
    `on ${PLATFORM[p.platform] || p.platform || 'an unknown device'}`,
    p.version ? `version ${p.version}` : null,
    p.country || null,
    screen ? `${screen[1]} × ${screen[2]} screen${screen[3] ? ` at ${screen[3]}×` : ''}` : null,
  ].filter(Boolean);
  const head = `${who[0]} ${who.slice(1).join(', ')}`;

  // How the launch went.
  const ready = by.get('Load:Ready');
  let loadSecs = null;
  // What the page draws as tokens: the same facts as the lines, a number or a short label each.
  const marks = [], mark = (label, tone = 'warn') => marks.push({ label, tone });
  if (ready?.n) {
    const secs = ready.sum / ready.n;
    if (secs > 0) loadSecs = Math.round(secs * 10) / 10;
    if (secs > 0) lines.push(`Loaded in ${secs.toFixed(1)} s${ready.n > 1 ? ` on average over ${ready.n} launches` : ''}.`);
    if (secs >= 15) { flags.push('Slow load'); mark('Slow load'); }
  }
  const lost = by.get('Load:ContextLost')?.n || 0, stopped = by.get('Load:Stopped')?.n || 0;
  if (lost) { flags.push(`Lost the graphics context${lost > 1 ? ` ${lost} times` : ''}`); mark(`Context lost${lost > 1 ? ` ×${lost}` : ''}`, 'bad'); }
  if (stopped) { flags.push(`Load stopped${stopped > 1 ? ` ${stopped} times` : ''}`); mark(`Load stopped${stopped > 1 ? ` ×${stopped}` : ''}`, 'bad'); }
  if (starts('Gfx:Lite:').length) { flags.push('Fell back to lite graphics'); mark('Lite graphics'); }
  const level = starts('Gfx:Level:').map((e) => e.event.split(':')[2]).filter(Boolean).at(-1);

  // How far through the first-time steps.
  const steps = starts('FTUE:').map((e) => e.event.split(':')[1]).filter((s) => /^\d/.test(s || '')).sort();
  let ftue = null;
  if (steps.length) { const last = steps.at(-1); ftue = { step: parseInt(last, 10), name: words(last.replace(/^\d+[a-z]?_/, '')) }; lines.push(`First-time steps: reached ${ftue.step}, ${ftue.name}.`); }

  // Where the time went.
  const areas = starts('Area:').map((e) => ({ name: e.event.split(':')[1], secs: e.sum })).filter((a) => a.name && a.secs > 0).sort((a, b) => b.secs - a.secs);
  const played = areas.reduce((a, x) => a + x.secs, 0);
  if (played > 0) lines.push(`Played ${mins(played)}: ${areas.slice(0, 5).map((a) => `${words(a.name)} ${mins(a.secs)}`).join(', ')}.`);
  else if (p.last - Math.max(p.first, since) > 60000) lines.push(`Active over ${mins((p.last - Math.max(p.first, since)) / 1000)}.`);

  // Quests and chapters.
  const quest = { offered: count('Quest:Offer'), accepted: count('Quest:Accept'), done: count('Quest:Done'), left: count('Quest:Abandon') };
  if (quest.offered || quest.accepted || quest.done) {
    lines.push(`Quests: ${[quest.accepted && `${quest.accepted} accepted`, quest.done && `${quest.done} finished`, quest.left && `${quest.left} given up`, !quest.accepted && !quest.done && quest.offered && `${quest.offered} offered, none taken`].filter(Boolean).join(', ')}.`);
  }
  // The chapter is a property of the event (Chapter:Complete { chapter: 2 }), or its third part (Chapter:Complete:2).
  const chaptersOf = (prefix) => [...new Set(starts(prefix).flatMap((e) => [e.event.split(':')[2], ...(e.chapters || [])]).filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const finished = chaptersOf('Chapter:Complete'), begun = chaptersOf('Chapter:Start').filter((c) => !finished.includes(c));
  if (finished.length) lines.push(`Finished chapter${finished.length > 1 ? 's' : ''} ${list(finished)}${begun.length ? `, started ${list(begun)}` : ''}.`);
  else if (count('Chapter:Complete')) lines.push(`Finished ${plural(count('Chapter:Complete'), 'chapter')}.`);
  else if (begun.length) lines.push(`Started chapter ${list(begun)}.`);
  else if (count('Chapter:Start')) lines.push('Started a chapter.');

  // The Runway, or whatever the game's contest sends under its own name.
  const runway = { opened: count('Runway:Open'), rated: count('Runway:Rate'), sent: count('Runway:Submit'), entered: count('Runway:Entered') };
  if (runway.opened || runway.rated || runway.sent || runway.entered) {
    lines.push(`Runway: ${[runway.opened && 'opened it', runway.rated && `rated ${plural(runway.rated, 'look')}`, runway.sent && 'submitted a look', runway.entered && 'look entered'].filter(Boolean).join(', ')}.`);
  }

  // The shop.
  const product = (prefix) => [...new Set(starts(prefix).map((e) => e.event.split(':').slice(2).join(':')).filter(Boolean))];
  // Pearl Tide: Shop:Open, Store:Tap:<product>, Store:Error. Chillwater Lake: Store:Open, Store:Buy:<product>, Store:Fail.
  const shop = count('Shop:Open') + count('Store:Open'), taps = count('Store:Tap:') + count('Store:Buy:'), tapped = [...new Set([...product('Store:Tap:'), ...product('Store:Buy:')])];
  const bought = product('Store:Bought'), cancels = count('Store:Cancel'), errors = count('Store:Error') + count('Store:Fail');
  if (bought.length) lines.push(`Bought ${list(bought)}.`);
  else if (shop || taps) lines.push(`Shop: ${[shop && `opened ${plural(shop, 'time')}`, taps && `tapped a price${tapped.length ? ` (${list(tapped.slice(0, 3))})` : ''}`, cancels && 'cancelled'].filter(Boolean).join(', ')}.`);
  if (bought.length) mark(`Bought${bought.length > 1 ? ` ×${bought.length}` : ''}`, 'good');
  if (errors) { flags.push(`Store error${errors > 1 ? ` ×${errors}` : ''}`); mark(`Store error${errors > 1 ? ` ×${errors}` : ''}`, 'bad'); }

  // Trouble.
  const unclean = starts('Session:UncleanExit');
  if (unclean.length) { const loading = unclean.some((e) => /Loading/.test(e.event)); flags.push(`Closed without a clean exit${loading ? ' while loading' : ''}`); mark(loading ? 'Unclean exit, loading' : 'Unclean exit', loading ? 'bad' : 'warn'); }
  const appErrors = by.get('App:Error')?.n || 0;
  if (appErrors) { flags.push(plural(appErrors, 'app error')); mark(`App error${appErrors > 1 ? ` ×${appErrors}` : ''}`, 'bad'); }

  // Whatever else the game sends, by category.
  const KNOWN = /^(Session|Device|Load|Gfx|FTUE|Area|Quest|Chapter|Runway|Shop|Store|App)$/;
  const other = new Map();
  for (const e of p.events) { const c = e.event.split(':')[0]; if (!c || c.startsWith('$') || KNOWN.test(c) || !e.event.includes(':')) continue; other.set(c, (other.get(c) || 0) + e.n); }
  const rest = [...other].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (rest.length) lines.push(`Also: ${rest.map(([c, n]) => `${words(c)} ×${n}`).join(', ')}.`);
  if (level && !starts('Gfx:Lite:').length) lines.push(`Graphics settled at level ${level}.`);
  if (!lines.length) lines.push('Opened the game; nothing else recorded yet.');

  return {
    tag: tagOf(p.id), new: isNew, platform: p.platform, version: p.version || null, country: p.country || null, launches: launches || null,
    first_seen: new Date(p.first).toISOString(), last_seen: new Date(p.last).toISOString(), played_secs: Math.round(played) || null,
    head, lines, flags,
    facts: {
      load_secs: loadSecs, ftue, gfx: level || null, screen: screen ? `${screen[1]} × ${screen[2]}` : null,
      areas: areas.slice(0, 4).map((x) => ({ name: words(x.name), secs: Math.round(x.secs) })),
      quests: quest.offered || quest.accepted || quest.done ? quest : null,
      chapters: finished.length || begun.length ? { finished, begun } : null,
      runway: runway.opened || runway.rated || runway.sent || runway.entered ? runway : null,
      shop: shop || taps || bought.length ? { opens: shop, taps, cancels, bought } : null,
      other: rest.map(([c, n]) => ({ name: words(c), n })),
      marks,
    },
  };
}
