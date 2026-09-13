// =============================================================================
// Front-door Worker for stocksaathi.co.in
//
// Intercepts every request. Tries Vercel first; on 5xx / timeout / network
// error, falls back to:
//   - Cloudflare Pages for static                  (stocksaathi.pages.dev)
//   - Fly.io for Python /api/*                     (stocksaathi-backup.fly.dev)
//   - Inline in this Worker for /api/chat + /api/ai (imports the Vercel source)
//
// Circuit breaker: one failure writes `vercel_state=down` to HEALTH_KV with a
// 30 s TTL. Subsequent requests skip Vercel until it expires, then re-probe.
// This keeps latency down during an outage (no 9 s retry per request).
//
// Kill switch: requests with `X-Force-Backup: 1` are forced to the backup
// path, gated by TEST_IPS so random internet traffic can't trigger it.
// Useful for manual verification without actually breaking Vercel.
// =============================================================================

import vercelChatHandler from "../../../api/chat.js";
import vercelAiHandler from "../../../api/ai.js";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------
const PRIMARY_ORIGIN = "https://stock-saathi-jtmn.vercel.app";
const BACKUP_STATIC_ORIGIN = "https://stocksaathi.pages.dev";
const BACKUP_API_ORIGIN = "https://stocksaathi-backup.fly.dev";

const HEALTH_KEY = "vercel_state";
const HEALTH_TTL_S = 30;

const TIMEOUT_API_MS = 9000;      // live-quote Yahoo fan-out can take 8 s
const TIMEOUT_STATIC_MS = 4000;

// Paths handled inline by this Worker when primary fails (both are Edge JS on
// Vercel, so the same code runs here with a globalThis.process shim below).
const INLINE_EDGE_PATHS = new Set(["/api/chat", "/api/ai"]);

// -----------------------------------------------------------------------------
// globalThis.process shim
//
// chat.js and ai.js read config via `globalThis.process.env.X` (Vercel Edge
// convention). Workers pass env as an argument instead. Install the shim
// once per isolate before dispatching — safe because every request within a
// Worker sees the same env.
// -----------------------------------------------------------------------------
let _envInstalled = false;
function ensureProcessEnv(env) {
  if (_envInstalled) return;
  const stringEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") stringEnv[k] = v;
  }
  globalThis.process = { env: stringEnv };
  _envInstalled = true;
}

// -----------------------------------------------------------------------------
// Health-state circuit breaker
// -----------------------------------------------------------------------------
async function primaryMarkedDown(env) {
  try {
    const state = await env.HEALTH_KV.get(HEALTH_KEY);
    return state === "down";
  } catch {
    return false;
  }
}

async function markPrimaryDown(env) {
  try {
    await env.HEALTH_KV.put(HEALTH_KEY, "down", { expirationTtl: HEALTH_TTL_S });
  } catch {
    // KV write failure is not fatal; next request just retries Vercel.
  }
}

// -----------------------------------------------------------------------------
// Test kill switch
// -----------------------------------------------------------------------------
function isForceBackup(req, env) {
  if (req.headers.get("x-force-backup") !== "1") return false;
  const allowedIps = (env.TEST_IP_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ip = req.headers.get("cf-connecting-ip") || "";
  return allowedIps.includes(ip);
}

// -----------------------------------------------------------------------------
// Transparent origin proxy with timeout
// -----------------------------------------------------------------------------
async function proxyTo(req, originUrl, timeoutMs) {
  const url = new URL(req.url);
  const target = originUrl + url.pathname + url.search;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Clone headers; strip CF-added hop-by-hop that origins don't want.
  const outHeaders = new Headers(req.headers);
  outHeaders.delete("cf-connecting-ip");
  outHeaders.delete("cf-ipcountry");
  outHeaders.delete("cf-ray");
  outHeaders.delete("cf-visitor");
  outHeaders.delete("x-forwarded-proto");
  outHeaders.set("x-forwarded-host", url.hostname);
  outHeaders.set("host", new URL(originUrl).hostname);

  try {
    return await fetch(target, {
      method: req.method,
      headers: outHeaders,
      body: (req.method === "GET" || req.method === "HEAD") ? undefined : req.body,
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Backup dispatch
// -----------------------------------------------------------------------------
async function serveBackup(req, env, ctx) {
  const url = new URL(req.url);

  if (INLINE_EDGE_PATHS.has(url.pathname)) {
    ensureProcessEnv(env);
    try {
      if (url.pathname === "/api/chat") return await vercelChatHandler(req);
      if (url.pathname === "/api/ai") return await vercelAiHandler(req);
    } catch (e) {
      return jsonError(502, "inline_handler_failed", e);
    }
  }

  const isApi = url.pathname.startsWith("/api/");
  const backupOrigin = isApi ? BACKUP_API_ORIGIN : BACKUP_STATIC_ORIGIN;
  const timeout = isApi ? TIMEOUT_API_MS : TIMEOUT_STATIC_MS;

  try {
    const res = await proxyTo(req, backupOrigin, timeout);
    // Tag so we can see in DevTools which origin served us.
    const headers = new Headers(res.headers);
    headers.set("x-served-by", isApi ? "backup-fly" : "backup-pages");
    return new Response(res.body, { status: res.status, headers });
  } catch (e) {
    return jsonError(503, "all_origins_unavailable", e);
  }
}

function jsonError(status, code, err) {
  return new Response(JSON.stringify({ error: code, detail: String(err?.message || err || "").slice(0, 200) }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// -----------------------------------------------------------------------------
// Main router
// -----------------------------------------------------------------------------
async function dispatch(req, env, ctx) {
  const url = new URL(req.url);
  const isApi = url.pathname.startsWith("/api/");
  const timeout = isApi ? TIMEOUT_API_MS : TIMEOUT_STATIC_MS;

  // Test kill switch short-circuits everything.
  if (isForceBackup(req, env)) {
    return serveBackup(req, env, ctx);
  }

  // Circuit-breaker: primary recently failed → skip straight to backup.
  if (await primaryMarkedDown(env)) {
    return serveBackup(req, env, ctx);
  }

  // Normal path: try primary.
  try {
    const res = await proxyTo(req, PRIMARY_ORIGIN, timeout);
    if (res.status >= 500 && res.status <= 599) {
      ctx.waitUntil(markPrimaryDown(env));
      return serveBackup(req, env, ctx);
    }
    const headers = new Headers(res.headers);
    headers.set("x-served-by", "primary-vercel");
    return new Response(res.body, { status: res.status, headers });
  } catch (e) {
    ctx.waitUntil(markPrimaryDown(env));
    return serveBackup(req, env, ctx);
  }
}

// -----------------------------------------------------------------------------
// SCHEDULED — server-side order matcher tick.
//
// Order execution used to happen ONLY inside the user's own browser tab
// (js/features/limitOrders.js), which meant an order filled only while the
// user personally had the app open during NSE hours. For a product aimed at
// teenagers that window is the school day, so orders simply rotted: 75
// pending, 42 of them already past their fill condition, oldest 87 days.
//
// This Worker already fronts every request to the domain and already holds
// the credentials, so it is the cheapest place to get minute-level
// scheduling that does not depend on anyone's browser. The cron fires every
// minute; /api/match-orders itself decides whether the market is open, so a
// tick outside hours is a sub-millisecond no-op.
//
// .github/workflows/order-matcher.yml runs the same endpoint every 5 minutes
// as an INDEPENDENT backup, on the assumption that any single scheduler will
// eventually fail silently. Both paths are idempotent — the fill flips
// status inside a row-locked transaction, so a double tick cannot double
// fill.
//
// Requires the CRON_SECRET var/secret to be bound on the Worker.
// -----------------------------------------------------------------------------
async function tickOrderMatcher(env) {
  const secret = env.CRON_SECRET;
  if (!secret) {
    console.error("[cron] CRON_SECRET not bound — order matcher cannot run");
    return;
  }
  const origin = env.PUBLIC_ORIGIN || PRIMARY_ORIGIN;
  try {
    const res = await fetch(`${origin}/api/match-orders`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${secret}` },
    });
    const body = await res.text();
    if (!res.ok) {
      console.error("[cron] match-orders HTTP", res.status, body.slice(0, 300));
      return;
    }
    // Only log ticks that did something, so the tail stays readable.
    try {
      const j = JSON.parse(body);
      if (j.filled || (j.errors && j.errors.length)) {
        console.log("[cron] match-orders", JSON.stringify({
          filled: j.filled, checked: j.checked, errors: j.errors?.length || 0,
        }));
      }
    } catch { /* non-JSON body — ignore */ }
  } catch (e) {
    console.error("[cron] match-orders failed:", e?.message || String(e));
  }
}

export default {
  async fetch(req, env, ctx) {
    return dispatch(req, env, ctx);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tickOrderMatcher(env));
  },
};
