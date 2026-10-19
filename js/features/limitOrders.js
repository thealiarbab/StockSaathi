// =============================================================================
// LIMIT ORDERS — market-order-like execution simulation.
//
// User places a BUY limit at ₹X → fires when market drops to ≤ X.
// User places a SELL limit at ₹X → fires when market rises to ≥ X.
//
// EXECUTION IS SERVER-SIDE, AND ONLY SERVER-SIDE. /api/match-orders runs
// every minute of market hours (Supabase pg_cron, GitHub Actions as backup)
// and fills every user's orders with no browser involved. The browser cannot
// fill an order at all: fill_limit_order is revoked from signed-in users
// (migration 2026-10-17c).
//
// The browser only LISTENS. startOrderEvents() opens a Supabase Realtime
// channel while the user has a pending order and the tab is visible; the
// server's fill or cancel arrives as a push, the same pattern brokers use
// (Zerodha order postbacks, Alpaca trade_updates). Until 17 Oct 2026 the
// browser instead asked "any pending orders?" every 12 s, and the portfolio
// page every 15 s: 11,728 reads on 16 Oct, mostly from users with no orders.
//
// It used to be the ONLY execution path, and that was the bug. An order
// could fill only while the user personally had the app open on a weekday
// between 09:15 and 15:30 IST — the school day, for a product built for
// teenagers. 75 orders sat pending, 42 of them already past their fill
// condition, the oldest for 87 days, cash reserved the whole time. One user
// asked in the coach, mid-chase: "Yaar me 8 se 2 baje busy rahta hu to
// trading kaise karu". Never make execution depend on a client again.
// =============================================================================

import { sb } from "../db/supabase.js";
import { currentUser } from "../auth/accounts.js";
import { toast } from "../components/toast.js";

async function withRpcTimeout(promiseFactory, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promiseFactory(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// AUTH LOCK CONTENTION — why no getSession / getUser here anymore.
//
// v135 wrapped placeLimitOrder's client.auth.getSession() and this file's
// two list functions' client.auth.getUser() in 5-second Promise.race
// timeouts to avoid the GoTrue `_acquireLock` deadlock documented in
// supabase-js 2.45.4 (issues #936, #740). That didn't just mask the
// deadlock — it MADE IT WORSE. Because every one of these calls shares
// a single module-level mutex inside supabase-js, any two overlapping
// auth calls contend for the same lock. The matcher loop below fires
// listPendingOrders every 12 s (globally, any page). The portfolio
// page's poll fires it every 15 s. Both were taking the lock just to
// read the user id. The user's Place Buy Limit click then took the
// lock for a third time. On unlucky overlaps the 5-second race fired
// first with 'session_timeout', leaving the user stuck.
//
// v136 fix: drop every auth preflight from the hot path. PostgREST
// enforces `user_id = auth.uid()` automatically via RLS policy
// `orders_self_all` (schema.sql:985-987). An expired or missing JWT
// returns HTTP 401 from the server; we catch it inside `placeLimitOrder`
// and surface a user-friendly "session expired" toast. The `.from()`
// select operations here rely on RLS to filter to the authenticated
// user's rows, so an unauthenticated or expired-session tab simply
// gets an empty array — no lock, no timeout, no spam.

/**
 * Pending orders for the signed-in user.
 *
 * Returns an ARRAY on success (possibly empty) or NULL when the list could
 * not be loaded. Callers must treat those differently.
 *
 * Why: this used to return [] for both "you have no orders" and "the query
 * failed", and worse, it could hang forever — supabase-js can deadlock on
 * its GoTrue lock (issues #936, #740, documented in the block comment above),
 * in which case the awaited promise simply never settles. The portfolio page
 * then sat at its initial empty list and rendered "QUEUED AMOS: 0".
 *
 * Observed live on 2026-09-13: a real pending RELIANCE AMO existed in the
 * database and PostgREST returned it correctly, while the page showed 0. A
 * user in that state concludes their order vanished — which is exactly the
 * complaint that started all of this ("Order ya pending order wala koi option
 * hi nahi hai"). Silently showing zero is the worst possible failure here.
 */
export async function listPendingOrders() {
  try {
    const client = await withRpcTimeout(() => sb(), 8_000, "supabase client");
    if (!client) return [];
    // RLS filters by auth.uid() = user_id automatically. Unauthenticated
    // tabs legitimately get an empty array (RLS returns zero rows).
    const { data, error } = await withRpcTimeout(
      () => client.from("limit_orders")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
      10_000,
      "listPendingOrders"
    );
    if (error) {
      console.error("[limit] listPendingOrders select error:", error.message, error.code, error.details);
      return null;
    }
    notePendingOrders(data || []);
    return data || [];
  } catch (e) {
    // Timeout or thrown error — we do NOT know the user's orders.
    console.error("[limit] listPendingOrders failed:", e?.message || e);
    return null;
  }
}

export async function listAllOrders(limit = 50) {
  const client = await sb();
  if (!client) return [];
  const { data, error } = await client.from("limit_orders")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[limit] listAllOrders select error:", error.message, error.code, error.details);
    return [];
  }
  return data || [];
}

// orderType: "LIMIT" (fill at this price or better), "AMO_MARKET" (after
// hours: fill at the first live price after the open; limitPricePaise is
// only the reference shown) or "MF" (fund: allot at the next NAV). The
// server forces "MF" for any fund symbol.
export async function placeLimitOrder({ symbol, side, qty, limitPricePaise, orderType = "LIMIT" }) {
  console.info("[limit] placeLimitOrder start", { symbol, side, qty, limitPricePaise, orderType });
  const client = await sb();
  if (!client) throw new Error("Backend not configured — log in first.");
  // Client-side input validation. The RPC validates too, but catching here
  // gives a readable error and avoids a round-trip for obvious mistakes.
  if (!symbol || typeof symbol !== "string") throw new Error("Missing symbol.");
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("Quantity must be greater than 0.");
  if (!Number.isFinite(limitPricePaise) || limitPricePaise <= 0) {
    throw new Error("Limit price must be greater than ₹0.");
  }
  if (side !== "BUY" && side !== "SELL") throw new Error("Side must be BUY or SELL.");
  // Placing an order is ONE database call. There used to be an awaited
  // fetch('/api/live-quote') here, so place_limit_order would find a
  // quote_cache row. On 19 Oct that round trip to our API took 23.7 s on a
  // user's phone (Vercel ran it in under 0.5 s; Supabase saw nothing until
  // the insert) and the order died on the 25 s timeout as "Supabase may be
  // unreachable". The RPC now takes its reference price from quote_cache or
  // the exchange's own close (migration 2026-10-19a), so it needs nothing
  // from the browser but the order. Never put another network hop in front
  // of this RPC.
  // NO pre-flight getSession in v136 — see the block comment above.
  // The RPC call itself enforces auth via RLS; missing/expired JWT
  // bubbles back as a PostgREST error we can catch below.
  console.info("[limit] RPC start");
  const t0 = Date.now();
  const { data, error } = await withRpcTimeout(
    () => client.rpc("place_limit_order", {
      p_symbol: symbol,
      p_side: side,
      p_qty: qty,
      p_limit_price_paise: Math.round(limitPricePaise),
      p_order_type: orderType,
    }),
    25_000,
    "place_limit_order"
  ).catch((e) => {
    const err = new Error("The server didn't answer in time, so we couldn't confirm this order. Check pending orders on your Portfolio before placing it again.");
    err.isTimeout = /timed out/.test(String(e?.message));
    if (!err.isTimeout) throw e;
    throw err;
  });
  console.info(`[limit] RPC done in ${Date.now() - t0}ms`, { ok: !error, hasData: !!data });
  if (error) {
    console.error("[limit] RPC error:", error);
    // Map any JWT-related PostgREST error to a single friendly message.
    // PostgREST error codes: PGRST301 = "JWT expired", PGRST302 = "JWT
    // invalid", and the RPC itself can raise "not logged in" when
    // auth.uid() is null. All three route the user to refresh + relog.
    const msg = error.message || String(error);
    if (/jwt|not logged in|401/i.test(msg) || error.code === "PGRST301" || error.code === "PGRST302") {
      throw new Error("Your session expired — please refresh the page and sign in again.");
    }
    throw new Error(prettifyErr(msg));
  }
  listPendingOrders();          // connect the fill listener if this is the first one
  return data;
}

export async function cancelOrder(orderId) {
  const client = await sb();
  if (!client) throw new Error("Backend not configured.");
  const { data, error } = await client.rpc("cancel_limit_order", { p_order_id: orderId });
  if (error) throw new Error(prettifyErr(error.message));
  listPendingOrders();          // may close the fill listener
  return data;
}

// ---- Order events: the server fills, the browser only listens -------------
//
// One Realtime channel per tab, open only while all three hold: someone is
// signed in, they have at least one pending order, and the tab is visible.
// Most users have no pending order, so most tabs never open one. RLS
// (orders_self_read) means a tab only ever receives its own user's rows.
// A fill arrives as an UPDATE; we toast it, reload cash and holdings once,
// and tell any page that shows orders. Coming back to a hidden tab re-reads
// the pending list once, in case something filled while nobody was looking.

let _channel = null;
let _channelUid = null;
let _hasPending = false;
let _pendingIds = new Set();
let _started = false;
let _syncing = Promise.resolve();
const _orderListeners = new Set();

/** fn(row) runs after the user's orders change; row is the changed order, or null after a re-sync. */
export function onOrdersChanged(fn) {
  _orderListeners.add(fn);
  return () => _orderListeners.delete(fn);
}

function _emitOrders(row) {
  for (const fn of _orderListeners) { try { fn(row); } catch (e) { console.warn("[orders] listener failed:", e); } }
}

// Called with every successful pending-list read (listPendingOrders does it),
// so whichever page loaded the list also decides whether to stay connected.
function notePendingOrders(list) {
  if (!Array.isArray(list)) return;            // null = unknown: keep state
  _hasPending = list.length > 0;
  _pendingIds = new Set(list.map((o) => o.id));
  _syncChannel();
}

function _syncChannel() {
  _syncing = _syncing.then(_syncChannelNow, _syncChannelNow);
  return _syncing;
}

async function _syncChannelNow() {
  const uid = currentUser()?.id || null;
  const want = !!uid && _hasPending && document.visibilityState === "visible";
  if (_channel && (!want || _channelUid !== uid)) {
    const ch = _channel;
    _channel = null;
    _channelUid = null;
    try { (await sb())?.removeChannel(ch); } catch {}
  }
  if (!want || _channel) return;
  const client = await sb();
  if (!client) return;
  _channelUid = uid;
  _channel = client
    .channel(`orders-${uid}`)
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "limit_orders", filter: `user_id=eq.${uid}` },
      (payload) => { _onOrderChange(payload?.new); })
    .subscribe();
}

const _rupees = (paise) => "₹" + (Number(paise || 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const _qty = (q) => Number(q || 0).toLocaleString("en-IN", { maximumFractionDigits: 4 });

async function _onOrderChange(row) {
  if (!row?.id) return;
  if (row.status === "filled") {
    const fund = String(row.symbol || "").startsWith("MF_");
    const verb = row.side === "SELL" ? "Sold" : "Bought";
    toast({
      kind: "success",
      message: fund
        ? `Fund order done: ${verb.toLowerCase()} ${_qty(row.qty)} units at ${_rupees(row.filled_price_paise)}`
        : `Order filled: ${verb} ${_qty(row.qty)} ${row.symbol} at ${_rupees(row.filled_price_paise)}`,
      duration: 6000,
    });
  }
  // Cash and holdings changed on the server; pull them once.
  try {
    const { loadAllFromDb } = await import("../db/sync.js");
    await loadAllFromDb();
  } catch (e) { console.warn("[orders] reload after order change failed:", e?.message || e); }
  _emitOrders(row);
  listPendingOrders();          // may close the channel if nothing is left
}

async function _onVisible() {
  if (document.visibilityState !== "visible") { _syncChannel(); return; }
  if (!_hasPending) return;      // nothing pending: nothing can have filled
  const before = _pendingIds;
  const now = await listPendingOrders();
  if (!Array.isArray(now)) return;
  const stillThere = new Set(now.map((o) => o.id));
  if ([...before].some((id) => !stillThere.has(id))) {
    try {
      const { loadAllFromDb } = await import("../db/sync.js");
      await loadAllFromDb();
    } catch {}
    _emitOrders(null);
  }
}

/**
 * Start listening for server-side fills. Idempotent. One pending-list read
 * at boot for a signed-in user, then nothing until something happens.
 */
export function startOrderEvents() {
  if (_started) return;
  _started = true;
  document.addEventListener("visibilitychange", _onVisible);
  if (currentUser()?.id) listPendingOrders();
  sb().then((client) => {
    client?.auth?.onAuthStateChange?.((event) => {
      if (event === "SIGNED_OUT") { _hasPending = false; _pendingIds = new Set(); _syncChannel(); }
      else if (event === "SIGNED_IN") listPendingOrders();
    });
  }).catch(() => {});
}

function prettifyErr(msg) {
  if (!msg) return "Something went wrong.";
  if (/insufficient cash/i.test(msg)) return "Not enough cash to reserve.";
  if (/insufficient holding/i.test(msg)) return "You don't hold enough shares.";
  if (/not logged in/i.test(msg)) return "Please log in.";
  if (/invalid side/i.test(msg)) return "Invalid order side.";
  if (/market has not crossed/i.test(msg)) return "Market hasn't reached the limit yet.";
  return msg;
}
