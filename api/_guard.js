// -----------------------------------------------------------------------------
// Abuse guard for the paid AI endpoints (/api/chat, /api/ai LLM ops).
//
// Both endpoints are open to logged-out visitors on purpose (many people use
// the coach before they sign up), so nothing here asks for an account. It
// does two things:
//
//  1. Tags every model call with WHO, without storing who: a 16-hex HMAC of
//     the caller's IP and of their browser id (cookie ss_vid, set by
//     telemetry.js). The HMAC key changes every IST day, so a hash cannot be
//     followed across days or reversed to an IP. Written to llm_usage
//     (ip_hash, dev_hash) and wiped after 48 h by ai_watch_cleanup().
//  2. Refuses callers on the blocklist (public.ai_blocks), which the database
//     watcher ops_ai_watch() fills when one IP or browser spends far beyond
//     anything a real user has. Loaded once per 30 s per edge instance.
//  3. AI lockdown (public.ai_guard_state.lockdown_until): when the watcher
//     calls a spend spike an ATTACK it sets this for 30 min. Answers already
//     saved (market mood, why-is-it-moving, news takes) keep being served;
//     no new paid model call is made for anyone until it lapses.
//
// Everything fails OPEN: if Supabase is slow or down, requests go through.
// A broken guard must never take the coach down for real users.
// -----------------------------------------------------------------------------

const env = () => globalThis.process?.env || {};
const enc = new TextEncoder();

let _key = { day: "", key: null };
function istDay() {
  return new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}
async function dayKey() {
  const day = istDay();
  if (_key.day === day && _key.key) return _key.key;
  const secret = env().SUPABASE_SERVICE_ROLE_KEY || env().CRON_SECRET || "";
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(`ai-guard|${day}|${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  _key = { day, key };
  return key;
}
async function h16(key, s) {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(s)));
  let out = "";
  for (let i = 0; i < 8; i++) out += sig[i].toString(16).padStart(2, "0");
  return out;
}

function clientIp(req) {
  const h = req.headers;
  return (h.get("x-real-ip") || h.get("x-forwarded-for") || "").split(",")[0].trim();
}
function browserId(req) {
  const m = /(?:^|;\s*)ss_vid=([A-Za-z0-9_-]{8,40})/.exec(req.headers.get("cookie") || "");
  return m ? m[1] : "";
}

/** { ip_hash, dev_hash } for this request; either may be null. Never throws. */
export async function callerHashes(req) {
  try {
    const key = await dayKey();
    if (!key) return { ip_hash: null, dev_hash: null };
    const ip = clientIp(req), dev = browserId(req);
    return {
      ip_hash: ip ? await h16(key, `ip:${ip}`) : null,
      dev_hash: dev ? await h16(key, `dev:${dev}`) : null,
    };
  } catch {
    return { ip_hash: null, dev_hash: null };
  }
}

let _blocks = { at: 0, set: new Set(), lockUntil: 0, p: null };
const BLOCKS_TTL_MS = 30_000;
async function loadBlocks() {
  const url = env().SUPABASE_URL, key = env().SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return _blocks.set;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 600);
  try {
    const now = new Date().toISOString();
    const base = url.replace(/\/$/, "");
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    const [r, g] = await Promise.all([
      fetch(`${base}/rest/v1/ai_blocks?select=key_hash&until=gt.${encodeURIComponent(now)}&shadow=is.false`,
        { headers, signal: ctrl.signal }),
      fetch(`${base}/rest/v1/ai_guard_state?select=lockdown_until&id=eq.1`, { headers, signal: ctrl.signal }).catch(() => null),
    ]);
    let lockUntil = _blocks.lockUntil;
    if (g?.ok) {
      const rows = await g.json().catch(() => []);
      lockUntil = rows?.[0]?.lockdown_until ? Date.parse(rows[0].lockdown_until) || 0 : 0;
    }
    if (r.ok) {
      const rows = await r.json();
      _blocks = { at: Date.now(), set: new Set(rows.map((x) => x.key_hash)), lockUntil, p: null };
    } else {
      _blocks = { ..._blocks, at: Date.now(), lockUntil, p: null };
    }
  } catch {
    _blocks = { ..._blocks, at: Date.now(), p: null };
  } finally {
    clearTimeout(t);
  }
  return _blocks.set;
}

// ---- Human pass (Cloudflare Turnstile, lockdown only) ------------------------
// During a lockdown a caller can prove it is a real browser once
// (/api/ai?op=human-check) and gets this cookie for an hour. It is bound to
// the caller's IP hash and the day key, so one solved check cannot be shared
// across a botnet. Outside a lockdown it is never asked for or read.
const HUMAN_TTL_S = 3600;
export async function humanPassCookie(caller) {
  const key = await dayKey();
  if (!key || !caller?.ip_hash) return null;
  const exp = Math.floor(Date.now() / 1000) + HUMAN_TTL_S;
  const sig = await h16(key, `human:${exp}:${caller.ip_hash}`);
  return `ss_human=${exp}.${sig}; Path=/api; Max-Age=${HUMAN_TTL_S}; HttpOnly; Secure; SameSite=Strict`;
}
export async function hasHumanPass(req, caller) {
  try {
    const m = /(?:^|;\s*)ss_human=(\d{9,11})\.([0-9a-f]{16})/.exec(req.headers.get("cookie") || "");
    if (!m || !caller?.ip_hash) return false;
    const exp = Number(m[1]);
    if (!(exp > Date.now() / 1000)) return false;
    const key = await dayKey();
    return !!key && (await h16(key, `human:${exp}:${caller.ip_hash}`)) === m[2];
  } catch { return false; }
}
export function clientIpOf(req) { return clientIp(req); }

async function fresh() {
  if (Date.now() - _blocks.at > BLOCKS_TTL_MS) {
    if (!_blocks.p) _blocks.p = loadBlocks();
    await _blocks.p;
  }
  return _blocks;
}

/** True while the watcher's AI lockdown is on (no new paid model calls). */
export async function inLockdown() {
  const b = await fresh();
  return b.lockUntil > Date.now();
}

/** True when this caller's IP or browser hash is on the active blocklist. */
export async function isBlocked(caller) {
  if (!caller?.ip_hash && !caller?.dev_hash) return false;
  let set = _blocks.set;
  if (Date.now() - _blocks.at > BLOCKS_TTL_MS) {
    if (!_blocks.p) _blocks.p = loadBlocks();
    set = await _blocks.p;
  }
  return (!!caller.ip_hash && set.has(caller.ip_hash)) || (!!caller.dev_hash && set.has(caller.dev_hash));
}
