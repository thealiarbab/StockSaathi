-- D2/D7: the browser draws a short real chart from the exchange's own daily
-- closes when Yahoo has no history for a stock (SME listings), instead of
-- the old synthetic random walk. nse_eod_prices is NSE's public bhavcopy, so
-- read-only access for everyone is safe. Writes stay service-role only.
grant select on public.nse_eod_prices to anon, authenticated;
drop policy if exists nse_eod_prices_read on public.nse_eod_prices;
create policy nse_eod_prices_read on public.nse_eod_prices for select using (true);
