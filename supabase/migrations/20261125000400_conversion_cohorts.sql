-- Conversion is counted like retention: of the customers whose day 7 fell inside
-- the range, the share who bought within their 7 days. Those customers installed
-- up to 7 days before the range began, so cohorts_rc now carries each install
-- day's conv_cohort_size and new_paying_customers (RevenueCat), reaching back
-- before the range as the PostHog cohorts already do.
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
      or (source = 'revenuecat' and metric_key in ('new_customers', 'conv_cohort_size', 'new_paying_customers', 'retained_d1', 'retained_d3', 'retained_d7', 'retained_d14', 'retained_d30')))
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
