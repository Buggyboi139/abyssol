-- Notifications on the owner's phone: the devices that asked for them, and
-- what the dashboard last told them about, so each change is told once.
-- Row level security is on with no policies, as on every table here: only
-- the service role (the sync and the Pages Functions) reads or writes.

create table if not exists public.push_subscriptions (
  endpoint text primary key check (endpoint ~ '^https://'),
  p256dh text not null,
  auth text not null,
  kinds text[] not null default array['players', 'downloads', 'sales', 'reviews', 'sync'],
  device text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_sent_at timestamptz,
  failures int not null default 0
);

-- The last value told for each watched number ("<game>|<source>|<platform>|<metric>"),
-- or for each source's sync ("sync|<game>|<source>": 1 failing, 0 fine).
create table if not exists public.push_state (
  key text primary key,
  value double precision not null,
  updated_at timestamptz not null default now()
);

-- What was sent, for the dashboard's list and for looking back. Kept 30 days.
create table if not exists public.push_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  game_slug text,
  kind text not null,
  title text not null,
  body text not null,
  sent int not null default 0,
  failed int not null default 0
);
create index if not exists push_log_at on public.push_log (at desc);

alter table public.push_subscriptions enable row level security;
alter table public.push_state enable row level security;
alter table public.push_log enable row level security;

-- A device's subscription, made or updated. p_kinds null keeps what it had.
create or replace function public.dashboard_push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_kinds text[] default null, p_device text default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare k text[];
begin
  k := (select coalesce(array_agg(x order by x), '{}') from unnest(coalesce(p_kinds, array['players', 'downloads', 'sales', 'reviews', 'sync'])) x
        where x in ('players', 'downloads', 'sales', 'reviews', 'sync'));
  insert into push_subscriptions as s (endpoint, p256dh, auth, kinds, device)
  values (p_endpoint, p_p256dh, p_auth, k, left(p_device, 80))
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
    kinds = case when p_kinds is null then s.kinds else excluded.kinds end,
    device = coalesce(excluded.device, s.device), updated_at = now(), failures = 0;
  return (select jsonb_build_object('kinds', kinds) from push_subscriptions where endpoint = p_endpoint);
end $$;

create or replace function public.dashboard_push_device(p_endpoint text)
returns jsonb language sql security invoker set search_path = public as $$
  select jsonb_build_object('kinds', kinds, 'last_sent_at', last_sent_at) from push_subscriptions where endpoint = p_endpoint;
$$;

create or replace function public.dashboard_push_forget(p_endpoints text[])
returns int language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  delete from push_subscriptions where endpoint = any(p_endpoints);
  get diagnostics n = row_count;
  return n;
end $$;

-- Every subscription, or only those that want p_kind.
create or replace function public.dashboard_push_subscriptions(p_kind text default null)
returns jsonb language sql security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('endpoint', endpoint, 'p256dh', p256dh, 'auth', auth, 'kinds', kinds)), '[]'::jsonb)
  from push_subscriptions where p_kind is null or p_kind = any(kinds);
$$;

-- After a round of sending: which endpoints took it, which failed. A device
-- that fails ten rounds running is dropped (a push service that is gone for
-- good answers 404 or 410, and those are dropped at once by the sender).
create or replace function public.dashboard_push_sent(p_ok text[], p_failed text[], p_log jsonb default '[]'::jsonb)
returns int language plpgsql security invoker set search_path = public as $$
begin
  update push_subscriptions set last_sent_at = now(), failures = 0 where endpoint = any(p_ok);
  update push_subscriptions set failures = failures + 1 where endpoint = any(p_failed);
  delete from push_subscriptions where failures >= 10;
  insert into push_log (game_slug, kind, title, body, sent, failed)
  select r ->> 'game_slug', r ->> 'kind', left(r ->> 'title', 200), left(r ->> 'body', 500), coalesce((r ->> 'sent')::int, 0), coalesce((r ->> 'failed')::int, 0)
  from jsonb_array_elements(p_log) r where r ? 'kind' and r ? 'title';
  delete from push_log where at < now() - interval '30 days';
  return coalesce(array_length(p_ok, 1), 0);
end $$;

create or replace function public.dashboard_push_recent(p_limit int default 20)
returns jsonb language sql security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('at', at, 'game_slug', game_slug, 'kind', kind, 'title', title, 'body', body, 'sent', sent) order by at desc), '[]'::jsonb)
  from (select * from push_log order by at desc limit least(greatest(p_limit, 1), 100)) l;
$$;

-- What changed since the last call, and nothing twice. A number is watched as
-- a total (summed over every day) or as its latest day's value; each rise is
-- returned with how much it rose. A fall is noted without a word (a store
-- correcting itself, a refund). A source seen for the first time for a game
-- is noted without a word too, so turning on a new source or a new game
-- doesn't send its whole history. A source's sync that starts failing is returned once,
-- and once more when it works again.
create or replace function public.dashboard_push_changes()
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  out jsonb := '[]'::jsonb;
  r record;
  prev double precision;
  k text;
begin
  -- The sync and the webhook can both ask at once: one at a time.
  perform pg_advisory_xact_lock(4207731);

  for r in
    with watch (kind, source, platform, metric, how) as (values
      ('players', 'posthog', 'ios', 'new_users', 'sum'), ('players', 'posthog', 'android', 'new_users', 'sum'),
      ('downloads', 'apple', 'ios', 'downloads', 'sum'), ('downloads', 'google', 'android', 'installs', 'sum'),
      ('sales', 'revenuecat', 'ios', 'transactions', 'sum'), ('sales', 'revenuecat', 'android', 'transactions', 'sum'),
      ('sales', 'revenuecat', 'ios', 'revenue', 'sum'), ('sales', 'revenuecat', 'android', 'revenue', 'sum'),
      ('reviews', 'listing', 'ios', 'reviews_total', 'last'), ('reviews', 'listing', 'ios', 'rating_count', 'last'), ('reviews', 'listing', 'ios', 'rating', 'last'))
    select g.slug, g.display_name, w.kind, w.source, w.platform, w.metric,
      case w.how
        when 'sum' then (select sum(m.metric_value) from metrics_daily m where m.game_slug = g.slug and m.source = w.source and m.platform = w.platform and m.metric_key = w.metric)
        else (select m.metric_value from metrics_daily m where m.game_slug = g.slug and m.source = w.source and m.platform = w.platform and m.metric_key = w.metric order by m.date desc limit 1)
      end as value
    from games g cross join watch w
  loop
    continue when r.value is null;
    k := format('%s|%s|%s|%s', r.slug, r.source, r.platform, r.metric);
    select value into prev from push_state where key = k;
    -- First sight of a number whose source is already watched for this game (a first sale on
    -- the other platform) counts from 0; a source never watched before starts silently.
    if prev is null and exists (select 1 from push_state p where p.key like format('%s|%s|%%', r.slug, r.source)) then
      prev := 0;
      insert into push_state (key, value) values (k, 0);
    end if;
    if prev is null then
      insert into push_state (key, value) values (k, r.value);
    elsif round(r.value::numeric, 4) <> round(prev::numeric, 4) then
      update push_state set value = r.value, updated_at = now() where key = k;
      if r.value > prev or r.metric = 'rating' then
        out := out || jsonb_build_object('game_slug', r.slug, 'game', r.display_name, 'kind', r.kind, 'source', r.source,
          'platform', r.platform, 'metric', r.metric, 'was', prev, 'now', r.value, 'delta', r.value - prev,
          'detail', case when r.metric = 'reviews_total' then (select f.value -> 'reviews' -> 0 from game_facts f where f.game_slug = r.slug and f.key = 'listing.ios') end);
      end if;
    end if;
  end loop;

  for r in
    select distinct on (s.game_slug, s.source) s.game_slug, g.display_name, s.source, s.status, s.message
    from sync_runs s join games g on g.slug = s.game_slug
    where s.status <> 'skipped'
    order by s.game_slug, s.source, s.ran_at desc
  loop
    k := format('sync|%s|%s', r.game_slug, r.source);
    select value into prev from push_state where key = k;
    if prev is null then
      insert into push_state (key, value) values (k, (r.status = 'error')::int);
    elsif prev <> (r.status = 'error')::int then
      update push_state set value = (r.status = 'error')::int, updated_at = now() where key = k;
      out := out || jsonb_build_object('game_slug', r.game_slug, 'game', r.display_name, 'kind', 'sync', 'source', r.source,
        'failing', r.status = 'error', 'message', left(coalesce(r.message, ''), 300));
    end if;
  end loop;
  return out;
end $$;
