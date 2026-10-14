-- O13: order attempts, how they ended, and the market-order confirm box.
-- js/features/track.js KINDS must list the same values: one row outside
-- this check fails the whole insert batch.
alter table public.user_events drop constraint if exists user_events_kind_check;
alter table public.user_events add constraint user_events_kind_check check (kind = any (array[
  'page_view','stock_view','news_click','news_open','chart_range','chart_interact','search',
  'market_browse','watchlist_add','watchlist_remove','coach_open','order_ticket_open','tab_focus',
  'order_submit','order_result','trade_modal'
]::text[]));
