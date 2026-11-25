-- Abyssol dashboard: the central metrics store.
-- Every table has row level security on and no policies, so only the service
-- role (the sync jobs and the Pages Functions) can read or write.

create table if not exists public.games (
  slug text primary key,
  display_name text not null,
  ios_bundle_id text,
  android_package_id text,
  status text not null default 'prelaunch' check (status in ('live', 'in_review', 'prelaunch')),
  sort int not null default 0,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.metrics_daily (
  game_slug text not null references public.games (slug) on delete cascade,
  platform text not null check (platform in ('ios', 'android', 'all')),
  source text not null check (source in ('revenuecat', 'apple', 'google', 'posthog', 'supabase_game')),
  date date not null,
  metric_key text not null,
  metric_value double precision not null,
  updated_at timestamptz not null default now(),
  primary key (game_slug, platform, source, date, metric_key)
);
create index if not exists metrics_daily_game_date on public.metrics_daily (game_slug, date);

create table if not exists public.metrics_hourly (
  game_slug text not null references public.games (slug) on delete cascade,
  platform text not null check (platform in ('ios', 'android', 'all')),
  source text not null check (source in ('revenuecat', 'apple', 'google', 'posthog', 'supabase_game')),
  bucket_hour timestamptz not null,
  metric_key text not null,
  metric_value double precision not null,
  updated_at timestamptz not null default now(),
  primary key (game_slug, platform, source, bucket_hour, metric_key)
);
create index if not exists metrics_hourly_game_hour on public.metrics_hourly (game_slug, bucket_hour);

create table if not exists public.sync_runs (
  id bigint generated always as identity primary key,
  source text not null check (source in ('revenuecat', 'apple', 'google', 'posthog', 'supabase_game')),
  game_slug text not null references public.games (slug) on delete cascade,
  ran_at timestamptz not null default now(),
  status text not null check (status in ('ok', 'skipped', 'error')),
  message text
);
create index if not exists sync_runs_lookup on public.sync_runs (game_slug, source, ran_at desc);

-- RevenueCat webhook events already counted, so a retried delivery adds nothing.
create table if not exists public.webhook_events (
  event_id text primary key,
  source text not null,
  game_slug text,
  received_at timestamptz not null default now()
);

-- Login attempts per client per 15 minutes.
create table if not exists public.login_attempts (
  bucket text primary key,
  attempts int not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.games enable row level security;
alter table public.metrics_daily enable row level security;
alter table public.metrics_hourly enable row level security;
alter table public.sync_runs enable row level security;
alter table public.webhook_events enable row level security;
alter table public.login_attempts enable row level security;

-- ---------------------------------------------------------------------------
-- Writes (the sync jobs and the webhook)
-- ---------------------------------------------------------------------------

-- The games in config/games.json, upserted by every sync run.
create or replace function public.dashboard_sync_games(p_games jsonb)
returns int language sql security invoker set search_path = public as $$
  with up as (
    insert into games (slug, display_name, ios_bundle_id, android_package_id, status, sort, config, updated_at)
    select g ->> 'slug', g ->> 'display_name', g ->> 'ios_bundle_id', g ->> 'android_package_id',
           coalesce(g ->> 'status', 'prelaunch'), (ord - 1)::int, coalesce(g -> 'config', '{}'::jsonb), now()
    from jsonb_array_elements(p_games) with ordinality as t (g, ord)
    on conflict (slug) do update set
      display_name = excluded.display_name, ios_bundle_id = excluded.ios_bundle_id,
      android_package_id = excluded.android_package_id, status = excluded.status,
      sort = excluded.sort, config = excluded.config, updated_at = now()
    returning 1)
  select count(*)::int from up
$$;

-- Rows are {game_slug, platform, source, date | bucket_hour, metric_key, metric_value, mode?}.
-- mode "max" keeps the larger of the stored and the new value: the hourly RevenueCat
-- pull uses it for the day in progress, so it never lowers a sale the webhook
-- already counted.
create or replace function public.dashboard_upsert_metrics(p_daily jsonb default '[]'::jsonb, p_hourly jsonb default '[]'::jsonb)
returns int language plpgsql security invoker set search_path = public as $$
declare n int := 0; m int;
begin
  insert into metrics_daily as t (game_slug, platform, source, date, metric_key, metric_value, updated_at)
  select r ->> 'game_slug', r ->> 'platform', r ->> 'source', (r ->> 'date')::date, r ->> 'metric_key',
         (r ->> 'metric_value')::double precision, now()
  from jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) r
  where coalesce(r ->> 'mode', 'set') <> 'max'
  on conflict (game_slug, platform, source, date, metric_key)
  do update set metric_value = excluded.metric_value, updated_at = now();
  get diagnostics m = row_count; n := n + m;

  insert into metrics_daily as t (game_slug, platform, source, date, metric_key, metric_value, updated_at)
  select r ->> 'game_slug', r ->> 'platform', r ->> 'source', (r ->> 'date')::date, r ->> 'metric_key',
         (r ->> 'metric_value')::double precision, now()
  from jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) r
  where r ->> 'mode' = 'max'
  on conflict (game_slug, platform, source, date, metric_key)
  do update set metric_value = greatest(t.metric_value, excluded.metric_value), updated_at = now();
  get diagnostics m = row_count; n := n + m;

  insert into metrics_hourly as t (game_slug, platform, source, bucket_hour, metric_key, metric_value, updated_at)
  select r ->> 'game_slug', r ->> 'platform', r ->> 'source', (r ->> 'bucket_hour')::timestamptz, r ->> 'metric_key',
         (r ->> 'metric_value')::double precision, now()
  from jsonb_array_elements(coalesce(p_hourly, '[]'::jsonb)) r
  on conflict (game_slug, platform, source, bucket_hour, metric_key)
  do update set metric_value = excluded.metric_value, updated_at = now();
  get diagnostics m = row_count; n := n + m;
  return n;
end $$;

-- One sync run per source and game. Also drops runs older than 90 days and
-- hourly buckets older than 35 days.
create or replace function public.dashboard_log_runs(p_runs jsonb)
returns int language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  insert into sync_runs (source, game_slug, status, message)
  select r ->> 'source', r ->> 'game_slug', r ->> 'status', left(r ->> 'message', 500)
  from jsonb_array_elements(p_runs) r
  where exists (select 1 from games g where g.slug = r ->> 'game_slug');
  get diagnostics n = row_count;
  delete from sync_runs where ran_at < now() - interval '90 days';
  delete from metrics_hourly where bucket_hour < now() - interval '35 days';
  delete from webhook_events where received_at < now() - interval '90 days';
  return n;
end $$;

-- A sale from the RevenueCat webhook: p_metrics is {metric_key: amount to add}.
-- Returns false when the event was already counted.
create or replace function public.dashboard_record_sale(p_event_id text, p_game text, p_platform text, p_at timestamptz, p_metrics jsonb)
returns boolean language plpgsql security invoker set search_path = public as $$
declare fresh int;
begin
  if not exists (select 1 from games where slug = p_game) then return false; end if;
  insert into webhook_events (event_id, source, game_slug) values (p_event_id, 'revenuecat', p_game)
  on conflict (event_id) do nothing;
  get diagnostics fresh = row_count;
  if fresh = 0 then return false; end if;

  insert into metrics_hourly as t (game_slug, platform, source, bucket_hour, metric_key, metric_value, updated_at)
  select p_game, p.platform, 'revenuecat', date_trunc('hour', p_at), m.key, (m.value)::double precision, now()
  from jsonb_each_text(p_metrics) m, (select unnest(array[p_platform, 'all']) as platform) p
  on conflict (game_slug, platform, source, bucket_hour, metric_key)
  do update set metric_value = t.metric_value + excluded.metric_value, updated_at = now();

  insert into metrics_daily as t (game_slug, platform, source, date, metric_key, metric_value, updated_at)
  select p_game, p.platform, 'revenuecat', (p_at at time zone 'utc')::date, m.key, (m.value)::double precision, now()
  from jsonb_each_text(p_metrics) m, (select unnest(array[p_platform, 'all']) as platform) p
  on conflict (game_slug, platform, source, date, metric_key)
  do update set metric_value = t.metric_value + excluded.metric_value, updated_at = now();
  return true;
end $$;

-- True while this client is under the limit for the current 15 minutes.
create or replace function public.dashboard_login_attempt(p_bucket text, p_limit int default 10)
returns boolean language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  delete from login_attempts where updated_at < now() - interval '1 day';
  insert into login_attempts as t (bucket, attempts) values (p_bucket, 1)
  on conflict (bucket) do update set attempts = t.attempts + 1, updated_at = now()
  returning attempts into n;
  return n <= p_limit;
end $$;

-- ---------------------------------------------------------------------------
-- Reads (the Pages Functions)
-- ---------------------------------------------------------------------------

-- Everything one game's page needs, as one JSON value (a scalar result is not
-- cut off by PostgREST's row limit).
--   totals / prev: "<source>.<metric_key>" -> {sum, avg, last, n} over the range
--                  and over the same number of days before it
--   series:        "<source>.<metric_key>" -> [[date, value], ...] for keys
--                  without a ":" (breakdown keys such as revenue_by_product:<id>
--                  come back in totals only)
--   hourly:        the last 48 hours, the same shape
--   cohorts:       [[date, {new_users, retained_d1, ...}], ...] from PostHog, from
--                  30 days before the earlier period, so retention can be worked
--                  out for the cohorts whose day 1, 7, ... fell inside the range
--   sync:          per source, the last run and the last run that succeeded
--   nav:           every game, in tab order
-- Platform "all" takes a source's own "all" rows when it writes them, and
-- otherwise adds its ios and android rows (Apple writes ios only, Google
-- android only).
create or replace function public.dashboard_game(p_slug text, p_platform text, p_from date, p_to date)
returns jsonb language sql stable security invoker set search_path = public as $$
  with span as (select (p_to - p_from + 1) as n),
  picked as (
    select m.source, m.metric_key, m.date,
      case
        when p_platform <> 'all' then sum(m.metric_value) filter (where m.platform = p_platform)
        when bool_or(m.platform = 'all') then sum(m.metric_value) filter (where m.platform = 'all')
        else sum(m.metric_value) filter (where m.platform in ('ios', 'android'))
      end as v
    from metrics_daily m, span
    where m.game_slug = p_slug and m.date between p_from - span.n - 30 and p_to
    group by m.source, m.metric_key, m.date
  ),
  cur as (select * from picked where date >= p_from and v is not null),
  prev as (select picked.* from picked, span where date < p_from and date >= p_from - span.n and v is not null and position(':' in metric_key) = 0),
  coh as (
    select date, jsonb_object_agg(metric_key, v) as o
    from picked
    where source = 'posthog' and v is not null
      and metric_key in ('new_users', 'retained_d1', 'retained_d3', 'retained_d7', 'retained_d14', 'retained_d30')
    group by date),
  tot as (
    select source || '.' || metric_key as k,
           jsonb_build_object('sum', sum(v), 'avg', avg(v), 'last', (array_agg(v order by date desc))[1], 'n', count(*)) as o
    from cur group by 1),
  ptot as (
    select source || '.' || metric_key as k,
           jsonb_build_object('sum', sum(v), 'avg', avg(v), 'last', (array_agg(v order by date desc))[1], 'n', count(*)) as o
    from prev group by 1),
  ser as (
    select source || '.' || metric_key as k, jsonb_agg(jsonb_build_array(date, v) order by date) as pts
    from cur where position(':' in metric_key) = 0 group by 1),
  hpicked as (
    select h.source, h.metric_key, h.bucket_hour,
      case
        when p_platform <> 'all' then sum(h.metric_value) filter (where h.platform = p_platform)
        when bool_or(h.platform = 'all') then sum(h.metric_value) filter (where h.platform = 'all')
        else sum(h.metric_value) filter (where h.platform in ('ios', 'android'))
      end as v
    from metrics_hourly h
    where h.game_slug = p_slug and h.bucket_hour >= date_trunc('hour', now()) - interval '47 hours'
      and position(':' in h.metric_key) = 0
    group by h.source, h.metric_key, h.bucket_hour
  ),
  hser as (
    select source || '.' || metric_key as k, jsonb_agg(jsonb_build_array(bucket_hour, v) order by bucket_hour) as pts
    from hpicked where v is not null group by 1),
  runs as (
    select s.source,
           max(s.ran_at) as last_run,
           max(s.ran_at) filter (where s.status = 'ok') as last_ok,
           (array_agg(s.status order by s.ran_at desc))[1] as last_status,
           (array_agg(s.message order by s.ran_at desc))[1] as last_message
    from sync_runs s where s.game_slug = p_slug group by s.source)
  select jsonb_build_object(
    'game', to_jsonb(g),
    'platform', p_platform, 'from', p_from, 'to', p_to,
    'totals', coalesce((select jsonb_object_agg(k, o) from tot), '{}'::jsonb),
    'prev', coalesce((select jsonb_object_agg(k, o) from ptot), '{}'::jsonb),
    'series', coalesce((select jsonb_object_agg(k, pts) from ser), '{}'::jsonb),
    'hourly', coalesce((select jsonb_object_agg(k, pts) from hser), '{}'::jsonb),
    'cohorts', coalesce((select jsonb_agg(jsonb_build_array(date, o) order by date) from coh), '[]'::jsonb),
    'sync', coalesce((select jsonb_agg(to_jsonb(r) order by r.source) from runs r), '[]'::jsonb),
    'nav', (select jsonb_agg(to_jsonb(x) order by x.sort, x.slug) from games x))
  from games g where g.slug = p_slug
$$;

-- Every game, in config order, each with its own dashboard_game result for
-- platform "all".
create or replace function public.dashboard_overview(p_from date, p_to date)
returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object('from', p_from, 'to', p_to, 'games',
    coalesce((select jsonb_agg(public.dashboard_game(g.slug, 'all', p_from, p_to) order by g.sort, g.slug) from games g), '[]'::jsonb))
$$;

-- Only the service role calls these. (The roles exist on Supabase; a plain
-- Postgres used for local tests has none of them.)
do $$
declare f text;
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.games, public.metrics_daily, public.metrics_hourly, public.sync_runs,
      public.webhook_events, public.login_attempts from anon, authenticated;
    foreach f in array array[
      'public.dashboard_sync_games(jsonb)', 'public.dashboard_upsert_metrics(jsonb, jsonb)',
      'public.dashboard_log_runs(jsonb)', 'public.dashboard_record_sale(text, text, text, timestamptz, jsonb)',
      'public.dashboard_login_attempt(text, int)', 'public.dashboard_game(text, text, date, date)',
      'public.dashboard_overview(date, date)']
    loop
      execute format('revoke all on function %s from public, anon, authenticated', f);
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;
end $$;
