// =============================================================================
// SUPABASE — client initialization + helpers.
// Loads config from /api/config (safe: URL + anon key are PUBLIC by design —
// Row Level Security on the server is what enforces access).
// Falls back to local-only mode if Supabase isn't configured yet, so the app
// never breaks mid-pitch.
// =============================================================================

// Lazy SDK import from CDN — only loaded when actually needed.
let _sbPromise = null;
let _client = null;
let _config = null;
let _configPromise = null;

async function loadSdk() {
  if (_sbPromise) return _sbPromise;
  _sbPromise = import("https://esm.sh/@supabase/supabase-js@2.45.4?bundle");
  return _sbPromise;
}

async function loadConfig() {
  if (_config) return _config;
  if (_configPromise) return _configPromise;
  _configPromise = fetch("/api/config", { cache: "no-store" })
    .then(r => r.ok ? r.json() : {})
    .catch(() => ({}));
  _config = await _configPromise;
  return _config;
}

/**
 * Returns the Supabase client if configured + SDK loaded, else null.
 * On first call: fetches /api/config, loads SDK, creates client.
 */
let _clientPromise = null;
export function sb() {
  if (_client) return Promise.resolve(_client);
  // Share one in-flight setup. Concurrent first calls used to each await the
  // config and then each call createClient, leaving two GoTrueClient
  // instances on the same storage key ("Multiple GoTrueClient instances");
  // they fought over its session lock, which Firefox reports as an uncaught
  // "Navigator LockManager lock ... immediately failed" on every page.
  if (!_clientPromise) {
    _clientPromise = createSb().then((c) => {
      if (!c) _clientPromise = null;          // not configured yet: allow a retry
      return c;
    });
  }
  return _clientPromise;
}

// In-tab lock for the auth client, replacing the browser's cross-tab
// Navigator LockManager. With it, supabase-js 2.45's token-refresh tick asks
// for the lock with "fail immediately if busy", and Firefox surfaces that
// failure as an uncaught error on every page load. This keeps calls in one
// tab strictly one-at-a-time, which is what the auth client needs.
//
// acquireTimeout is honoured for the one value auth-js actually uses besides
// -1: the background refresh tick asks with 0 ("skip this tick if busy") and
// catches an error carrying isAcquireTimeout. Queueing that tick instead used
// to stack refreshes behind whatever held the lock, and every DB query waits
// on this lock (each one reads the session first) — console showed
// refreshCurrentUser_timeout and listPendingOrders timing out at 10 s.
const _authLocks = new Map();
const _authLockDepth = new Map();
async function inTabLock(name, acquireTimeout, fn) {
  if (acquireTimeout === 0 && (_authLockDepth.get(name) || 0) > 0) {
    const err = new Error(`Lock "${name}" is busy`);
    err.isAcquireTimeout = true;
    throw err;
  }
  _authLockDepth.set(name, (_authLockDepth.get(name) || 0) + 1);
  const prev = _authLocks.get(name) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  _authLocks.set(name, prev.then(() => mine));
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    _authLockDepth.set(name, (_authLockDepth.get(name) || 1) - 1);
    release();
  }
}

// Auth and REST requests get a ceiling. supabase-js sets none, so a single
// request that never answers (flaky mobile data) held the auth lock above
// forever and every later query queued behind it until reload. A timed-out
// token refresh is a retryable fetch error to auth-js: it backs off and
// retries, it does not sign the user out. Storage uploads and realtime are
// left alone.
const SB_FETCH_TIMEOUT_MS = 20_000;
function sbFetch(input, init = {}) {
  const url = typeof input === "string" ? input : (input?.url || "");
  if (!/\/(auth|rest)\/v1\//.test(url)) return fetch(input, init);
  const ctrl = new AbortController();
  const outer = init.signal;
  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener("abort", () => ctrl.abort(outer.reason), { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), SB_FETCH_TIMEOUT_MS);
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function createSb() {
  const cfg = await loadConfig();
  if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) return null;
  const mod = await loadSdk().catch(() => null);
  if (!mod?.createClient) return null;
  _client = mod.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: window.localStorage,
      storageKey: "ss.sb.session.v1",
      lock: inTabLock,
    },
    global: { headers: { "x-application-name": "stocksaathi" }, fetch: sbFetch },
  });
  return _client;
}

/**
 * Quick check — is Supabase configured for this app?
 */
export async function isSupabaseEnabled() {
  const client = await sb();
  return !!client;
}

/**
 * Get the current Supabase user (if logged in), or null.
 */
export async function sbUser() {
  const client = await sb();
  if (!client) return null;
  const { data } = await client.auth.getUser();
  return data?.user || null;
}

/**
 * Fetch the current user's profile row (or null).
 */
export async function sbProfile() {
  const client = await sb();
  const user = await sbUser();
  if (!client || !user) return null;
  const { data } = await client.from("profiles").select("*").eq("id", user.id).single();
  return data || null;
}

/**
 * Utility: money conversion. Keep paise as the transport unit.
 */
export function rupeesToPaise(r) { return Math.round(Number(r) * 100); }
