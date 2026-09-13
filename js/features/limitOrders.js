// =============================================================================
// LIMIT ORDERS — market-order-like execution simulation.
//
// User places a BUY limit at ₹X → fires when market drops to ≤ X.
// User places a SELL limit at ₹X → fires when market rises to ≥ X.
//
// EXECUTION IS SERVER-SIDE. /api/match-orders runs on a schedule (Cloudflare
// Worker cron every minute, GitHub Actions every 5 min as backup) and fills
// every user's orders with no browser involved.
//
// The loop below is now only a LATENCY OPTIMISATION: when the user happens to
// be watching, it fills within ~12 s instead of waiting up to a minute for
// the next server tick. It is not load-bearing. If it never ran again,
// every order would still execute.
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
import { getQuoteBatch } from "../data/marketData.js";
import { marketStatus } from "../data/prices.js";

let _loopTimer = null;
let _stopFn = null;
let _matching = false;              // guard: never run two passes in parallel
const _inFlight = new Set();        // order-ids currently being filled
const _recentFills = new Map();     // order-id → ts, debounce re-fires

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

export async function listPendingOrders() {
  const client = await sb();
  if (!client) return [];
  // RLS filters by auth.uid() = user_id automatically. No client-side
  // user-id fetch needed — one fewer lock acquisition per 15-s poll
  // tick. Unauthenticated tabs get an empty array (RLS returns zero
  // rows), matching the old behaviour without the 5-s timeout spam.
  const { data, error } = await client.from("limit_orders")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[limit] listPendingOrders select error:", error.message, error.code, error.details);
    return [];
  }
  return data || [];
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

export async function placeLimitOrder({ symbol, side, qty, limitPricePaise }) {
  console.info("[limit] placeLimitOrder start", { symbol, side, qty, limitPricePaise });
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
    }),
    25_000,
    "place_limit_order"
  );
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
  return data;
}

export async function cancelOrder(orderId) {
  const client = await sb();
  if (!client) throw new Error("Backend not configured.");
  const { data, error } = await client.rpc("cancel_limit_order", { p_order_id: orderId });
  if (error) throw new Error(prettifyErr(error.message));
  return data;
}

/**
 * Attempt to fill a single order at the current market price. Called by the
 * matcher loop. Server validates that the limit condition is actually met.
 */
async function fillOrderAt(orderId, marketPaise) {
  // Idempotency at the client tier: never fire a second fill request while
  // one is in-flight for the same order, and cool-down successful fills for
  // 60 s so a slow DB commit can't be re-triggered before the status flip
  // is visible via realtime.
  if (_inFlight.has(orderId)) return null;
  const lastFill = _recentFills.get(orderId);
  if (lastFill && Date.now() - lastFill < 60_000) return null;
  _inFlight.add(orderId);
  try {
    const client = await sb();
    if (!client) return null;
    const { data, error } = await client.rpc("fill_limit_order", {
      p_order_id: orderId,
      p_market_paise: Math.round(marketPaise),
    });
    if (error) {
      if (!/market has not crossed|already /i.test(error.message)) {
        console.warn("fill_limit_order:", error.message);
      }
      return null;
    }
    if (data?.ok) _recentFills.set(orderId, Date.now());
    return data;
  } finally {
    _inFlight.delete(orderId);
    // bounded map — forget old entries after 10 minutes
    if (_recentFills.size > 200) {
      const cutoff = Date.now() - 600_000;
      for (const [k, v] of _recentFills) if (v < cutoff) _recentFills.delete(k);
    }
  }
}

/**
 * Run one matcher pass: fetch pending orders, fetch quotes, fill matching.
 * The _matching guard means overlapping ticks (slow network → next setInterval
 * fires before the previous finished) silently drop rather than double-fill.
 */
async function matchOnce() {
  if (_matching) return { checked: 0, filled: 0, skipped: true };
  // PRIMARY FIX FOR "QUEUED ORDERS VANISH ON /#/portfolio": the matcher
  // must not fill orders while the market is closed. Before this guard,
  // `matchOnce` ran every 12 s via the global interval started at
  // app.js:45 — regardless of page, regardless of market status. After
  // a user placed an AMO at, say, BUY ₹1327.80 on RELIANCE when the
  // last cached Yahoo close was ≤ ₹1327.80, the matcher's next tick
  // trivially matched `cur <= limit` against the STALE after-hours
  // cached close and called `fill_limit_order` — flipping status from
  // 'pending' to 'filled'. listPendingOrders filters status='pending',
  // so the "queued" order vanished from the portfolio within 12 s with
  // zero feedback. The user saw a ghost.
  //
  // Gate: during after-hours, do nothing. AMOs placed after-hours now
  // correctly wait for the next market-open tick to evaluate against
  // the actual opening price.
  if (!marketStatus().open) {
    return { checked: 0, filled: 0, skipped: "market_closed" };
  }
  _matching = true;
  try {
    const pending = await listPendingOrders();
    if (!pending.length) return { checked: 0, filled: 0 };

    const symbols = [...new Set(pending.map(o => o.symbol))];
    const quotes = await getQuoteBatch(symbols);

    let filled = 0;
    for (const order of pending) {
      const q = quotes[order.symbol];
      if (!q) {
        // DO NOT auto-cancel. This used to cancel the order after ~2 minutes
        // of missing quotes and refund the cash with a toast. That silently
        // destroyed every mutual-fund order ever placed — getQuoteBatch has
        // no MF coverage at all, so an MF order was guaranteed to hit the
        // counter — plus any thinly-covered listing whose quote briefly
        // dropped out. A missing price is our infrastructure's problem, not
        // the user's order's problem.
        //
        // The server matcher (/api/match-orders) prices MFs off the daily
        // NAV in mf_master and simply retries anything it cannot price, so
        // the order stays alive until it can genuinely be evaluated.
        continue;
      }
      const cur = q.pricePaise;
      const limit = Number(order.limit_price_paise);
      const matches = order.side === "BUY" ? cur <= limit : cur >= limit;
      if (matches) {
        const result = await fillOrderAt(order.id, cur);
        if (result?.ok) filled++;
      }
    }
    return { checked: pending.length, filled };
  } finally {
    _matching = false;
  }
}

/**
 * Start the matcher loop. Idempotent — subsequent calls are no-ops.
 */
export function startLimitMatcher(intervalMs = 12_000) {
  if (_loopTimer) return _stopFn;
  let cancelled = false;

  const tick = async () => {
    if (cancelled) return;
    try { await matchOnce(); } catch (e) { console.warn("limit matcher:", e); }
  };

  tick();   // run once immediately
  _loopTimer = setInterval(tick, intervalMs);
  _stopFn = () => {
    cancelled = true;
    if (_loopTimer) { clearInterval(_loopTimer); _loopTimer = null; }
  };
  return _stopFn;
}

export function stopLimitMatcher() { _stopFn?.(); }

function prettifyErr(msg) {
  if (!msg) return "Something went wrong.";
  if (/insufficient cash/i.test(msg)) return "Not enough cash to reserve.";
  if (/insufficient holding/i.test(msg)) return "You don't hold enough shares.";
  if (/not logged in/i.test(msg)) return "Please log in.";
  if (/invalid side/i.test(msg)) return "Invalid order side.";
  if (/market has not crossed/i.test(msg)) return "Market hasn't reached the limit yet.";
  return msg;
}
