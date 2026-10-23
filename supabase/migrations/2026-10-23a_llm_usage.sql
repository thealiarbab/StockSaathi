-- LLM usage ledger: one row per model call / AI-cache hit, written by
-- api/_usage.js (service role). Token counts and timings only; no prompt or
-- reply text, no user id. Priced at read time from llm_prices, so a wrong
-- price is one UPDATE and every past row re-prices.

create table if not exists public.llm_usage (
  id bigserial primary key,
  ts timestamptz not null default now(),
  route text not null,              -- chat | ai
  op text,                          -- ai op (news-tldr, ...) or chat profile
  feature text,                     -- X-Saathi-Feature from the browser, else op
  profile text,
  upstream text,                    -- messages | gemini_* | openai | cache
  model text,
  effort text,
  ok boolean not null default true,
  status text,                      -- ok | cache_hit | http_429 | timeout | refusal | empty | ...
  stream boolean,
  tools int,
  input_tokens int,                 -- uncached input
  output_tokens int,                -- includes thinking
  reasoning_tokens int,             -- when the upstream reports it separately
  cache_read_tokens int,
  cache_write_tokens int,
  ttft_ms int,
  total_ms int,
  stop_reason text,
  attempt int,
  region text
);
create index if not exists llm_usage_ts_idx on public.llm_usage (ts desc);
create index if not exists llm_usage_op_ts_idx on public.llm_usage (op, ts desc);
alter table public.llm_usage enable row level security;
revoke all on public.llm_usage from public, anon, authenticated;
revoke all on sequence public.llm_usage_id_seq from public, anon, authenticated;

-- USD per 1M tokens. NULL = unknown: those rows show tokens but no cost.
-- Haiku 5.5: Anthropic list price (prompts <=100K). Google's Vertex rate may
-- differ - check the GCP billing SKU and UPDATE here.
create table if not exists public.llm_prices (
  model text primary key,
  in_usd numeric,
  out_usd numeric,
  cache_read_usd numeric,
  cache_write_usd numeric,
  note text,
  updated_at timestamptz not null default now()
);
alter table public.llm_prices enable row level security;
revoke all on public.llm_prices from public, anon, authenticated;
insert into public.llm_prices (model, in_usd, out_usd, cache_read_usd, cache_write_usd, note) values
  ('claude-haiku-5-5', 0.10, 0.50, 0.01, 0.125, 'Anthropic list price, prompts <=100K tokens; verify against Vertex SKU'),
  ('gemini-3.5-flash', null, null, null, null, 'unknown - fill from Vertex pricing'),
  ('gemini-3.1-flash-lite', null, null, null, null, 'unknown - fill from Vertex pricing'),
  ('gemini-3.1-pro-preview', null, null, null, null, 'unknown - fill from Vertex pricing'),
  ('gemini-3-flash-preview', null, null, null, null, 'unknown - fill from Vertex pricing')
on conflict (model) do nothing;

create table if not exists public.llm_settings (
  key text primary key,
  value numeric not null
);
alter table public.llm_settings enable row level security;
revoke all on public.llm_settings from public, anon, authenticated;
insert into public.llm_settings (key, value) values ('usd_inr', 88) on conflict (key) do nothing;

-- Everything the /a "AI cost" panel shows, in one call.
create or replace function public.admin_llm_usage(p_since timestamptz default now() - interval '7 days',
                                                  p_until timestamptz default now())
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with rate as (select coalesce((select value from public.llm_settings where key = 'usd_inr'), 88) as inr),
  u as (
    select l.*,
      (coalesce(l.input_tokens, 0) * p.in_usd
       + coalesce(l.output_tokens, 0) * p.out_usd
       + coalesce(l.cache_read_tokens, 0) * coalesce(p.cache_read_usd, p.in_usd)
       + coalesce(l.cache_write_tokens, 0) * coalesce(p.cache_write_usd, p.in_usd)) / 1e6 as usd,
      (p.in_usd is not null) as priced,
      (l.upstream <> 'cache') as is_call
    from public.llm_usage l
    left join public.llm_prices p on p.model = l.model
    where l.ts >= p_since and l.ts < p_until
  ),
  agg as (
    select
      count(*) filter (where is_call) as calls,
      count(*) filter (where is_call and ok) as ok_calls,
      count(*) filter (where not is_call) as cache_hits,
      sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
      sum(cache_read_tokens) as cache_read_tokens, sum(cache_write_tokens) as cache_write_tokens,
      sum(usd) as usd,
      count(*) filter (where is_call and not priced and (input_tokens is not null or output_tokens is not null)) as unpriced_calls,
      count(*) filter (where is_call and ok and input_tokens is null and output_tokens is null) as calls_without_tokens
    from u
  )
  select jsonb_build_object(
    'since', p_since, 'until', p_until, 'usd_inr', (select inr from rate),
    'totals', (select to_jsonb(agg) || jsonb_build_object('inr', round((agg.usd * (select inr from rate))::numeric, 2)) from agg),
    'by_day', coalesce((select jsonb_agg(d order by d.day) from (
        select (ts at time zone 'Asia/Kolkata')::date as day,
               count(*) filter (where is_call) as calls,
               count(*) filter (where not is_call) as cache_hits,
               sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
               sum(cache_read_tokens) as cache_read_tokens,
               round((sum(usd) * (select inr from rate))::numeric, 2) as inr
        from u group by 1) d), '[]'::jsonb),
    'by_hour', coalesce((select jsonb_agg(h order by h.hour) from (
        select extract(hour from ts at time zone 'Asia/Kolkata')::int as hour,
               count(*) filter (where is_call) as calls,
               round((sum(usd) * (select inr from rate))::numeric, 2) as inr
        from u group by 1) h), '[]'::jsonb),
    'by_feature', coalesce((select jsonb_agg(f order by f.inr desc nulls last, f.calls desc) from (
        select route, op, feature,
               count(*) filter (where is_call) as calls,
               count(*) filter (where is_call and not ok) as failed,
               count(*) filter (where not is_call) as cache_hits,
               round(avg(input_tokens) filter (where is_call and ok)) as avg_in,
               round(avg(cache_read_tokens) filter (where is_call and ok)) as avg_cache_read,
               round(avg(output_tokens) filter (where is_call and ok)) as avg_out,
               sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
               percentile_disc(0.5) within group (order by total_ms) filter (where is_call and ok) as p50_ms,
               percentile_disc(0.9) within group (order by total_ms) filter (where is_call and ok) as p90_ms,
               percentile_disc(0.5) within group (order by ttft_ms) filter (where is_call and ok and ttft_ms is not null) as p50_ttft_ms,
               round((sum(usd) * (select inr from rate))::numeric, 2) as inr
        from u group by 1, 2, 3) f), '[]'::jsonb),
    'by_model', coalesce((select jsonb_agg(m order by m.calls desc) from (
        select upstream, model,
               count(*) as calls, count(*) filter (where not ok) as failed,
               sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens,
               sum(cache_read_tokens) as cache_read_tokens, sum(cache_write_tokens) as cache_write_tokens,
               bool_and(priced) as priced,
               round((sum(usd) * (select inr from rate))::numeric, 2) as inr
        from u where is_call group by 1, 2) m), '[]'::jsonb),
    'by_effort', coalesce((select jsonb_agg(e order by e.op, e.effort) from (
        select op, effort,
               count(*) as calls,
               round(avg(output_tokens)) as avg_out,
               round(avg(input_tokens + coalesce(cache_read_tokens, 0))) as avg_prompt,
               percentile_disc(0.5) within group (order by total_ms) as p50_ms,
               percentile_disc(0.9) within group (order by total_ms) as p90_ms,
               percentile_disc(0.5) within group (order by ttft_ms) as p50_ttft_ms,
               round((avg(usd) * (select inr from rate) * 1000)::numeric, 3) as inr_per_1k_calls
        from u where is_call and ok and upstream = 'messages' group by 1, 2) e), '[]'::jsonb),
    'failures', coalesce((select jsonb_agg(x order by x.n desc) from (
        select upstream, status, op, count(*) as n
        from u where is_call and not ok group by 1, 2, 3) x), '[]'::jsonb),
    'prices', (select jsonb_agg(to_jsonb(p) order by p.model) from public.llm_prices p)
  );
$$;
revoke all on function public.admin_llm_usage(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_llm_usage(timestamptz, timestamptz) to service_role;
