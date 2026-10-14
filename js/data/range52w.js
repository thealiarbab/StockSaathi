// =============================================================================
// REAL 52-WEEK RANGES for the Markets tiles (D1).
//
// The tile bar used get52wRange() from prices.js, which is the high/low of
// the SEEDED synthetic walk, compared against a real price in different
// units: tooltips read "52W range ₹1.9L – ₹2.2L · now ₹205" and 40 of 40
// markers sat pinned at 0%. fundamentals_cache (refreshed nightly, publicly
// readable, values in RUPEES) has the real range. Tiles ask for their rows
// in batches; until a row arrives, or if there is none, they show "—".
// =============================================================================

import { sb } from "../db/supabase.js";

const _ranges = new Map();      // symbol -> { hi, lo } in rupees, or null (known missing)
const _queue = new Set();
let _timer = null;
const _listeners = new Set();

/** { hi, lo } in rupees, null if known to be missing, undefined if not loaded yet. */
export function get52wReal(symbol) {
  return _ranges.has(symbol) ? _ranges.get(symbol) : undefined;
}

/** Called with the list of symbols whose range just arrived. */
export function on52wLoaded(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }

/** Queue symbols; one batched read per 150 ms window, 100 symbols a request. */
export function request52w(symbols) {
  for (const s of symbols) if (s && !_ranges.has(s) && !String(s).startsWith("MF_")) _queue.add(s);
  if (!_queue.size || _timer) return;
  _timer = setTimeout(flush, 150);
}

async function flush() {
  _timer = null;
  const batch = [..._queue].slice(0, 100);
  batch.forEach((s) => _queue.delete(s));
  if (_queue.size) _timer = setTimeout(flush, 150);
  try {
    const client = await sb();
    if (!client) return;
    const { data, error } = await client
      .from("fundamentals_cache")
      .select("symbol,fifty_two_week_high,fifty_two_week_low")
      .in("symbol", batch);
    if (error) return;
    const got = new Map((data || []).map((r) => [r.symbol, r]));
    for (const s of batch) {
      const r = got.get(s);
      const hi = Number(r?.fifty_two_week_high), lo = Number(r?.fifty_two_week_low);
      _ranges.set(s, Number.isFinite(hi) && Number.isFinite(lo) && hi > lo && lo > 0 ? { hi, lo } : null);
    }
    for (const fn of _listeners) { try { fn(batch); } catch {} }
  } catch { /* leave them unloaded; the next render asks again */ }
}
