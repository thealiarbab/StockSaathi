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
const _authLocks = new Map();
async function inTabLock(name, _acquireTimeout, fn) {
  const prev = _authLocks.get(name) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  _authLocks.set(name, prev.then(() => mine));
  await prev.catch(() => {});
  try { return await fn(); } finally { release(); }
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
    global: { headers: { "x-application-name": "stocksaathi" } },
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
