// =============================================================================
// SERVER TIME — Trust-the-server clock so the market-status badge can't
// be faked by a user changing their system time.
//
// Flow:
//   1. On boot + periodically, hit /api/ai?op=time to get server epoch ms.
//   2. At the midpoint of the request, snapshot a MONOTONIC local tick
//      via performance.now() and pair it with the server's ms.
//   3. serverNow() = anchorServerMs + (performance.now() - anchorPerf).
//      performance.now() is a monotonic counter from page-load origin;
//      it is unaffected by the user's system-clock changes, DST shifts,
//      NTP adjustments, or Date.now() monkey-patches. So spoofing the
//      wall clock does NOT spoof serverNow().
//
// The anchor is re-taken every 10 minutes, on 'online' events, and on
// window focus (if last sync > 60 s ago) so drift stays bounded.
// =============================================================================

const SYNC_URL = "/api/ai?op=time";
const RESYNC_MS = 10 * 60 * 1000;   // 10 minutes

let anchorPerf = 0;       // performance.now() at sync midpoint
let anchorServerMs = 0;   // server's Date.now() at same midpoint
let synced = false;
let syncing = null;
let lastSyncAt = 0;
let slowRetries = 0;     // re-syncs scheduled after a slow sample       // performance.now() at sync completion

async function doSync() {
  const beforePerf = performance.now();
  try {
    const res = await fetch(SYNC_URL, { cache: "no-store" });
    const afterPerf = performance.now();
    if (!res.ok) throw new Error("http_" + res.status);
    const data = await res.json();
    if (typeof data?.ms !== "number") throw new Error("no_ms");
    // A slow round trip makes the midpoint guess unreliable: during app
    // boot this request queues behind the stock-list download and took
    // 13.8 s on average (18 Oct 2026), i.e. up to ~7 s of clock error.
    // Keep a slow sample only if there is nothing better, and try again
    // shortly once the phone is less busy.
    const rtt = afterPerf - beforePerf;
    if (rtt > 1500) {
      if (slowRetries++ < 3) setTimeout(syncServerTime, 20000);
      if (synced) return;
    }
    // Assume symmetric request/response latency: at the midpoint of
    // our local perf interval, the server's wall-clock was data.ms.
    anchorPerf = (beforePerf + afterPerf) / 2;
    anchorServerMs = data.ms;
    synced = true;
    lastSyncAt = afterPerf;
  } finally {
    syncing = null;
  }
}

// Fire-and-forget sync — never throws. Caller can await or ignore.
export function syncServerTime() {
  if (syncing) return syncing;
  syncing = doSync().catch(() => {});
  return syncing;
}

// Returns a Date for server-authoritative "now". If we haven't synced
// yet, falls back to local-clock time (degraded).
export function serverNow() {
  if (!synced) return new Date();
  return new Date(anchorServerMs + (performance.now() - anchorPerf));
}

// Returns true if we have at least one successful sync.
export function isServerTimeSynced() { return synced; }

// Milliseconds since last successful sync (for staleness checks).
export function msSinceSync() {
  return lastSyncAt ? performance.now() - lastSyncAt : Infinity;
}

// Boot the periodic re-sync. Safe to call more than once — additional
// calls are no-ops thanks to the closure guard.
let started = false;
export function startServerTimeSync() {
  if (started) return;
  started = true;
  syncServerTime();
  // Re-sync on tab-focus so returning users get fresh offset fast.
  window.addEventListener("online", () => syncServerTime());
  window.addEventListener("focus", () => {
    if (msSinceSync() > 60_000) syncServerTime();
  });
  setInterval(() => { syncServerTime(); }, RESYNC_MS);
}
