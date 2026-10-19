// =============================================================================
// push-dispatch — sends web push for public.notifications rows.
//
// Called by the database (migration 2026-10-19f) through pg_net:
//   { id }      a notification was just inserted for a user with push on
//   { flush }   07:05 IST: send everything that waited overnight
// Bearer = the Vault secret push_hook_secret.
//
// Web push by hand with WebCrypto, no npm dependency:
//   RFC 8291 (aes128gcm message encryption) and RFC 8292 (VAPID, ES256 JWT).
// Keys come from Vault (push_hook_secret, vapid_private_jwk) through the
// service-role RPC admin_push_config(), so nothing is set in the dashboard.
// Env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (provided by the platform).
// A 404 / 410 from the push service means the browser dropped the
// subscription: it is disabled. Three other failures in a row disable it too.
// =============================================================================

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUBJECT = "mailto:business@stocksaathi.co.in";

let _cfg: { hook: string; vapid: string } | null = null;
async function config() {
  if (_cfg) return _cfg;
  const r = await fetch(`${SB_URL}/rest/v1/rpc/admin_push_config`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!r.ok) throw new Error(`config: ${r.status}`);
  _cfg = await r.json();
  return _cfg!;
}

const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s: string) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// ---- VAPID ---------------------------------------------------------------------
let _vapid: { key: CryptoKey; pub: string } | null = null;
async function vapid() {
  if (_vapid) return _vapid;
  const jwk = JSON.parse((await config()).vapid || "{}");
  const key = await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["sign"], ext: true },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const pub = b64u(concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y)));
  _vapid = { key, pub };
  return _vapid;
}
async function vapidHeader(endpoint: string) {
  const { key, pub } = await vapid();
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${pub}`;
}

// ---- RFC 8291 encryption ---------------------------------------------------------
async function encrypt(payload: Uint8Array, p256dh: string, authSecret: string) {
  const uaPub = unb64u(p256dh);
  const auth = unb64u(authSecret);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(auth, shared);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPub, asPub, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, enc.encode("Content-Encoding: aes128gcm\0\x01"))).slice(0, 16);
  const nonce = (await hmac(prk, enc.encode("Content-Encoding: nonce\0\x01"))).slice(0, 12);
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, k, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);   // record size 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

// ---- Database ----------------------------------------------------------------------
async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

type Note = { id: string; user_id: string; kind: string; category: string; title: string; body: string; url: string | null };
type Sub = { endpoint: string; p256dh: string; auth: string; categories: string[]; fail_count: number };

async function sendOne(n: Note, s: Sub) {
  const payload = enc.encode(JSON.stringify({
    id: n.id, title: n.title, body: n.body, url: n.url || "/", kind: n.kind, tag: n.kind === "order_filled" ? `n-${n.id}` : n.kind,
  }));
  const body = await encrypt(payload, s.p256dh, s.auth);
  const r = await fetch(s.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(s.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "43200",
      Urgency: n.category === "orders" ? "high" : "normal",
    },
    body,
  });
  const ep = encodeURIComponent(s.endpoint);
  if (r.status === 404 || r.status === 410) {
    await db(`push_subscriptions?endpoint=eq.${ep}`, { method: "PATCH", body: JSON.stringify({ disabled: true }) });
    return false;
  }
  if (!r.ok) {
    console.warn("push failed", r.status, await r.text().catch(() => ""));
    await db(`push_subscriptions?endpoint=eq.${ep}`, { method: "PATCH",
      body: JSON.stringify({ fail_count: s.fail_count + 1, disabled: s.fail_count + 1 >= 3 }) });
    return false;
  }
  await db(`push_subscriptions?endpoint=eq.${ep}`, { method: "PATCH", body: JSON.stringify({ last_ok_at: new Date().toISOString(), fail_count: 0 }) });
  return true;
}

async function dispatch(n: Note) {
  const subs: Sub[] = await db(`push_subscriptions?user_id=eq.${n.user_id}&disabled=eq.false&select=endpoint,p256dh,auth,categories,fail_count`);
  let ok = false;
  for (const s of subs) {
    if (!(s.categories || []).includes(n.category)) continue;
    try { if (await sendOne(n, s)) ok = true; } catch (e) { console.warn("push error", String(e)); }
  }
  await db(`notifications?id=eq.${n.id}`, { method: "PATCH", body: JSON.stringify({ push_state: ok ? "sent" : "failed" }) });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const { hook } = await config();
  if (!hook || req.headers.get("authorization") !== `Bearer ${hook}`) return new Response("unauthorized", { status: 401 });
  let body: { id?: string; flush?: boolean } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const sel = "select=id,user_id,kind,category,title,body,url";
  const notes: Note[] = body.id
    ? await db(`notifications?id=eq.${encodeURIComponent(body.id)}&push_state=eq.pending&${sel}`)
    : await db(`notifications?push_state=eq.pending&order=created_at&limit=200&${sel}`);
  for (const n of notes) await dispatch(n);
  return Response.json({ sent: notes.length });
});
