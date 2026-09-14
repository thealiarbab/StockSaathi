// =============================================================================
// js/features/track.js — behavioural telemetry.
//
// Records what a user actually DOES between trades, so the coach can say
// "you opened IDEA fourteen times in three days and then bought at the top"
// instead of only ever seeing the end state. The product already claims to
// coach on behavioural bias — transactions.bias_flags exists — and until now
// there was no behavioural data to do it with.
//
// SEMANTIC, NOT A FIREHOSE — and that is a capability decision, not thrift.
//
// Raw scroll and mousemove fire at ~60Hz. A ten-minute session with half of it
// spent scrolling is ~18,000 events, ~3.6 MB, for ONE session. Thirty users
// once a day would exhaust the whole 500 MB tier in under five days.
//
// The decisive argument is not storage though: 18,000 rows saying
// `scrollY: 412 -> 419 -> 427` contain nothing a finance coach can reason
// about. The fact that matters is "opened RELIANCE, switched the chart to 1Y,
// stayed four minutes, did not buy" — which is ONE row. Debouncing is what
// turns noise into that sentence; it does not lose anything you would want.
//
// RETENTION IS UNLIMITED. Nothing here prunes, and user_event_rollup is a read
// optimisation for the dossier, not a precursor to deletion.
//
// NEVER let this break the app. Every entry point swallows its own errors:
// telemetry that can throw into a click handler is worse than no telemetry.
// =============================================================================

import { sb } from "../db/supabase.js";
import { currentUser } from "../auth/accounts.js";

const MAX_QUEUE = 200;
const FLUSH_AT = 25;
const FLUSH_EVERY_MS = 15_000;

// Enqueue-time throttles. These are what make "debounced" mean "one row per
// meaningful action" rather than "we dropped some of your data".
const DEDUPE_MS = 2_000;        // identical (kind,subject) in quick succession
const STOCK_VIEW_MS = 60_000;   // re-opening the same stock within a minute
const CHART_MS = 5_000;         // chart interactions, per symbol

const KINDS = new Set([
  "page_view", "stock_view", "news_click", "news_open", "chart_range",
  "chart_interact", "search", "market_browse", "watchlist_add",
  "watchlist_remove", "coach_open", "order_ticket_open", "tab_focus",
]);

let queue = [];
let timer = null;
let lastSeen = new Map();   // `${kind}:${subject}` -> ts
let flushing = false;

function throttleMs(kind) {
  if (kind === "stock_view") return STOCK_VIEW_MS;
  if (kind === "chart_interact" || kind === "chart_range") return CHART_MS;
  return DEDUPE_MS;
}

/**
 * Record an event. Synchronous, never awaits, never throws.
 *
 * @param {string} kind    one of KINDS (anything else is dropped — the DB has
 *                         a CHECK constraint and a rejected batch would lose
 *                         the good events alongside the bad one)
 * @param {string} subject symbol / route / query / article id
 * @param {object} props   small scalars only. NOT article bodies or DOM.
 */
export function track(kind, subject = null, props = {}) {
  try {
    if (!KINDS.has(kind)) return;
    const key = `${kind}:${subject ?? ""}`;
    const now = Date.now();
    const prev = lastSeen.get(key);
    if (prev && now - prev < throttleMs(kind)) return;
    lastSeen.set(key, now);
    if (lastSeen.size > 500) lastSeen = new Map([...lastSeen].slice(-250));

    queue.push({
      kind,
      subject: subject == null ? null : String(subject).slice(0, 120),
      props: props && typeof props === "object" ? props : {},
      occurred_at: new Date(now).toISOString(),
    });

    // Overflow drops the OLDEST. A page view from four minutes ago is
    // worthless; the newest events are the ones the coach reasons about.
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    if (queue.length >= FLUSH_AT) { flushEvents(); return; }
    if (!timer) timer = setTimeout(() => { timer = null; flushEvents(); }, FLUSH_EVERY_MS);
  } catch { /* telemetry must never break a UI action */ }
}

/**
 * Send whatever is queued.
 *
 * Writes straight to PostgREST through the existing supabase-js client: RLS
 * does the authorisation, so there is no new endpoint and no serverless cost.
 *
 * NOT navigator.sendBeacon, which is the instinctive choice for the unload
 * flush and is WRONG here. sendBeacon cannot set an Authorization header, and
 * PostgREST accepts `apikey` as a query param but NOT the user's JWT — so a
 * beacon insert would be evaluated as `anon`, match no RLS policy, and fail
 * SILENTLY FOREVER. supabase-js uses fetch with keepalive, which survives
 * unload and carries the header.
 */
export async function flushEvents() {
  if (flushing || !queue.length) return;
  const batch = queue;
  queue = [];
  flushing = true;
  try {
    // currentUser() is the SYNCHRONOUS cache. Deliberately not
    // client.auth.getUser(), which js/db/sync.js already documents as
    // "the single biggest source of 'my data vanished on deploy'" — a stuck
    // getUser call in v135 left loadAllFromDb hung forever, and it hung this
    // function too on its first real test.
    //
    // It matters more here than there: flushEvents runs on pagehide, so an
    // auth call that does not settle would delay closing the tab. Telemetry
    // is never worth that. No user in the cache means drop the batch.
    const uid = currentUser()?.id || null;
    if (!uid) { return; }
    const client = await sb();
    if (!client) { return; }
    const rows = batch.map((e) => ({ ...e, user_id: uid }));
    const { error } = await client.from("user_events").insert(rows);
    if (error) console.warn("[track] insert failed:", error.message);
  } catch (e) {
    console.warn("[track] flush failed:", e?.message || e);
  } finally {
    flushing = false;
  }
}

let installed = false;

/** Wire the flush triggers. Safe to call more than once. */
export function installTracking() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  // visibilitychange + pagehide are the ones that actually matter: teenagers
  // close the tab, and a timer-only flush loses the last 15 seconds of every
  // session — which is exactly the part that says what they were doing when
  // they left.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushEvents();
    else track("tab_focus");
  });
  window.addEventListener("pagehide", () => { flushEvents(); });
}
