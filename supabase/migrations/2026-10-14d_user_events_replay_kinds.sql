-- U9: crash replay opened / finished / left. Same list as js/features/track.js
-- KINDS: one row outside this check fails the whole insert batch.
alter table public.user_events drop constraint if exists user_events_kind_check;
alter table public.user_events add constraint user_events_kind_check check (kind = any (array[
  'page_view','stock_view','news_click','news_open','chart_range','chart_interact','search',
  'market_browse','watchlist_add','watchlist_remove','coach_open','order_ticket_open','tab_focus',
  'order_submit','order_result','trade_modal',
  'replay_start','replay_finish','replay_exit'
]::text[]));
