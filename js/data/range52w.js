// =============================================================================
// REAL 52-WEEK RANGES for the Markets tiles (D1).
//
// The tile bar used get52wRange() from prices.js, which is the high/low of
// the SEEDED synthetic walk, compared against a real price in different
// units: tooltips read "52W range ₹1.9L – ₹2.2L · now ₹205" and 40 of 40
// markers sat pinned at 0%. fundamentals_cache (refreshed nightly, values in
// RUPEES) has the real range; until it arrives, or if there is none, tiles
// show "—".
//
// The whole map comes from /api/range52w in ONE same-origin, CDN-cached
// request and is kept in localStorage for 12 hours. Reading fundamentals_cache
// straight from Supabase in batches of visible tiles cost 7,110 reads + 6,678
// CORS preflights a day (16 Oct 2026) while the org was over its egress quota.
// That path is kept only as a fallback if the endpoint fails.
// =============================================================================

import { sb } from "../db/supabase.js";

const STORE_KEY = "ss.range52w.v1";
const STORE_TTL_MS = 12 * 3600 * 1000;

const _ranges = new Map();      // symbol -> { hi, lo } in rupees, or null (known missing)
let _allLoaded = false;         // full map in hand: anything absent has no real range
let _allPromise = null;
const _queue = new Set();
let _timer = null;
const _listeners = new Set();

/** { hi, lo } in rupees, null if known to be missing, undefined if not loaded yet. */
export function get52wReal(symbol) {
  if (_ranges.has(symbol)) return _ranges.get(symbol);
  return _allLoaded ? null : undefined;
}

/** Called with the list of symbols whose range just arrived. */
export function on52wLoaded(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }

function _notify(symbols) {
  for (const fn of _listeners) { try { fn(symbols); } catch {} }
}

function _fill(map) {
  for (const [s, v] of Object.entries(map || {})) {
    const hi = Number(v?.[0]), lo = Number(v?.[1]);
    if (Number.isFinite(hi) && Number.isFinite(lo) && hi > lo && lo > 0) _ranges.set(s, { hi, lo });
  }
  _allLoaded = true;
}

function _readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && o.t && Date.now() - o.t < STORE_TTL_MS && o.r ? o.r : null;
  } catch { return null; }
}

function _writeStore(r) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ t: Date.now(), r })); } catch {}
}

// Fill from storage at import time so tiles drawn on first paint already have
// their bars when the map is fresh.
{
  const stored = _readStore();
  if (stored) _fill(stored);
}

function _loadAll() {
  if (_allLoaded) return Promise.resolve(true);
  if (_allPromise) return _allPromise;
  _allPromise = (async () => {
    try {
      const r = await fetch("/api/range52w");
      // Always read the body, error replies included: an unread response
      // stays open in Chromium (the smoke test's networkidle never came).
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok || !j.r) throw new Error("bad_reply_" + r.status);
      _fill(j.r);
      _writeStore(j.r);
      return true;
    } catch {
      _allPromise = null;   // let a later render try again
      return false;
    }
  })();
  return _allPromise;
}

/** Queue symbols; the first call loads the whole map, then answers are instant. */
export function request52w(symbols) {
  for (const s of symbols) if (s && !_ranges.has(s) && !String(s).startsWith("MF_")) _queue.add(s);
  if (!_queue.size || _timer || _allLoaded) { if (_allLoaded) _queue.clear(); return; }
  _timer = setTimeout(flush, 150);
}

async function flush() {
  _timer = null;
  if (await _loadAll()) {
    const done = [..._queue];
    _queue.clear();
    _notify(done);
    return;
  }
  // Fallback: the old direct read, one batch of up to 100 visible symbols.
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
    _notify(batch);
  } catch { /* leave them unloaded; the next render asks again */ }
}
