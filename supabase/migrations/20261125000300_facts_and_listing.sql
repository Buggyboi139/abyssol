-- A sixth source, the store listing (ratings, reviews, versions, search
-- ranks); facts, for what is not a number a day (a version's state, a
-- review's words, a readable note on a player); the reporting time zone for
-- sales the webhook counts; and, for a game, its numbers since launch.

do $$
declare t text;
begin
  foreach t in array array['metrics_daily', 'metrics_hourly', 'sync_runs'] loop
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_source_check');
    execute format('alter table public.%I add constraint %I check (source in (''revenuecat'', ''apple'', ''google'', ''posthog'', ''supabase_game'', ''listing''))', t, t || '_source_check');
  end loop;
end $$;

-- Until now RevenueCat's and PostHog's days were UTC days, RevenueCat's counts
-- included testers, and revenuecat.active_customers held RevenueCat's own
-- chart. From here on their days are the reporting zone's, testers are left
-- out, and that chart is active_customers_chart. Every number from these two
-- can be pulled again, so the old rows go and the next pull (run it with
-- --days 90) refills them under the new meaning.
delete from public.metrics_daily where source in ('revenuecat', 'posthog');
delete from public.metrics_hourly where source in ('revenuecat', 'posthog');

create table if not exists public.game_facts (
  game_slug text not null references public.games (slug) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (game_slug, key)
);
alter table public.game_facts enable row level security;

create or replace function public.dashboard_upsert_facts(p_facts jsonb)
returns int language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  insert into game_facts as t (game_slug, key, value, updated_at)
  select r ->> 'game_slug', r ->> 'key', r -> 'value', now()
  from jsonb_array_elements(coalesce(p_facts, '[]'::jsonb)) r
  where exists (select 1 from games g where g.slug = r ->> 'game_slug') and r ? 'value'
  on conflict (game_slug, key) do update set value = excluded.value, updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- A sale the webhook reports lands on the reporting zone's day (games.config.timezone), as the hourly pull's do.
create or replace function public.dashboard_record_sale(p_event_id text, p_game text, p_platform text, p_at timestamptz, p_metrics jsonb)
returns boolean language plpgsql security invoker set search_path = public as $$
declare fresh int; zone text;
begin
  select coalesce(nullif(config ->> 'timezone', ''), 'UTC') into zone from games where slug = p_game;
  if zone is null then return false; end if;
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
  select p_game, p.platform, 'revenuecat', (p_at at time zone zone)::date, m.key, (m.value)::double precision, now()
  from jsonb_each_text(p_metrics) m, (select unnest(array[p_platform, 'all']) as platform) p
  on conflict (game_slug, platform, source, date, metric_key)
  do update set metric_value = t.metric_value + excluded.metric_value, updated_at = now();
  return true;
end $$;

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
    select source, date, jsonb_object_agg(metric_key, v) as o
    from picked
    where v is not null and (
      (source = 'posthog' and metric_key in ('new_users', 'retained_d1', 'retained_d3', 'retained_d7', 'retained_d14', 'retained_d30'))
      or (source = 'revenuecat' and metric_key in ('new_customers', 'retained_d1', 'retained_d3', 'retained_d7', 'retained_d14', 'retained_d30')))
    group by source, date),
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
  -- Since the first day there is anything: the counts that add up to an all-time total.
  life as (
    select m.source, m.metric_key, m.date,
      case
        when p_platform <> 'all' then sum(m.metric_value) filter (where m.platform = p_platform)
        when bool_or(m.platform = 'all') then sum(m.metric_value) filter (where m.platform = 'all')
        else sum(m.metric_value) filter (where m.platform in ('ios', 'android'))
      end as v
    from metrics_daily m
    where m.game_slug = p_slug and m.date <= p_to
      and (m.source, m.metric_key) in (('apple', 'downloads'), ('apple', 'an_downloads'), ('google', 'installs'),
        ('revenuecat', 'new_customers'), ('posthog', 'new_users'), ('revenuecat', 'revenue'), ('revenuecat', 'transactions'))
    group by m.source, m.metric_key, m.date),
  lser as (
    select source || '.' || metric_key as k, jsonb_agg(jsonb_build_array(date, v) order by date) as pts
    from life where v is not null group by 1),
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
    'life', coalesce((select jsonb_object_agg(k, pts) from lser), '{}'::jsonb),
    'hourly', coalesce((select jsonb_object_agg(k, pts) from hser), '{}'::jsonb),
    'cohorts', coalesce((select jsonb_agg(jsonb_build_array(date, o) order by date) from coh where source = 'posthog'), '[]'::jsonb),
    'cohorts_rc', coalesce((select jsonb_agg(jsonb_build_array(date, o) order by date) from coh where source = 'revenuecat'), '[]'::jsonb),
    'facts', coalesce((select jsonb_object_agg(f.key, jsonb_build_object('value', f.value, 'at', f.updated_at)) from game_facts f where f.game_slug = p_slug), '{}'::jsonb),
    'sync', coalesce((select jsonb_agg(to_jsonb(r) order by r.source) from runs r), '[]'::jsonb),
    'nav', (select jsonb_agg(to_jsonb(x) order by x.sort, x.slug) from games x))
  from games g where g.slug = p_slug
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.game_facts from anon, authenticated;
    revoke all on function public.dashboard_upsert_facts(jsonb) from public, anon, authenticated;
    grant execute on function public.dashboard_upsert_facts(jsonb) to service_role;
    revoke all on function public.dashboard_record_sale(text, text, text, timestamptz, jsonb) from public, anon, authenticated;
    grant execute on function public.dashboard_record_sale(text, text, text, timestamptz, jsonb) to service_role;
    revoke all on function public.dashboard_game(text, text, date, date) from public, anon, authenticated;
    grant execute on function public.dashboard_game(text, text, date, date) to service_role;
  end if;
end $$;
