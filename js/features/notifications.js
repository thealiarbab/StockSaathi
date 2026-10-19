// =============================================================================
// NOTIFICATIONS — the inbox behind the bell, and web push on this device.
//
// Rows are written by the database (migration 2026-10-19f): an order filling,
// and every personal notice (order cancelled / expiring / allotted, refunds).
// The bell shows them; the push-dispatch Edge Function sends the same rows to
// the phone when this device has allowed push. Nothing here creates a
// notification: a client could only ever notify itself.
//
// Live updates: Supabase Realtime on public.notifications (own rows only, by
// RLS), with a refetch on focus as the fallback.
// =============================================================================

import { sb } from "../db/supabase.js";

// Public half of the VAPID key pair; the private half is in Vault.
export const VAPID_PUBLIC_KEY = "BC6r3vJ9ogpV33jH0WUO0B_e5eZnZr4AOKG9J9OTKsu2tJn2O_2SWjaH54Q5w8IWA6WoAm0qdgVprHsdOnc5L_s";
export const CATEGORIES = [
  { key: "orders", label: "Orders", hint: "An order fills, is cancelled or is about to expire" },
  { key: "account", label: "Account", hint: "Refunds and notes from StockSaathi" },
  { key: "achievements", label: "Achievements", hint: "Badges and streaks you earn" },
  { key: "coach", label: "Coach", hint: "Saathi's notes on your trades" },
];

let _items = [];
let _loadedFor = null;
let _channel = null;
const _subs = new Set();

const emit = () => { for (const f of _subs) { try { f(_items); } catch {} } };

/** Subscribe to inbox changes. Returns an unsubscribe function. */
export function onInbox(fn) {
  _subs.add(fn);
  fn(_items);
  return () => _subs.delete(fn);
}
export const unreadCount = () => _items.filter((n) => !n.read_at).length;
export const inboxItems = () => _items;

async function uid(client) {
  try { return (await client.auth.getSession())?.data?.session?.user?.id || null; } catch { return null; }
}

/** Load the newest 50 and start listening. Safe to call repeatedly. */
export async function loadInbox({ force = false } = {}) {
  const client = await sb();
  if (!client) return;
  const me = await uid(client);
  if (!me) { _items = []; _loadedFor = null; emit(); return; }
  if (!force && _loadedFor === me) return;
  const { data, error } = await client.from("notifications")
    .select("id,kind,category,title,body,url,created_at,read_at")
    .order("created_at", { ascending: false }).limit(50);
  if (error) { console.warn("[inbox] load failed:", error.message); return; }
  _items = data || [];
  _loadedFor = me;
  emit();
  listen(client, me);
}

function listen(client, me) {
  if (_channel) return;
  try {
    _channel = client.channel(`inbox-${me}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${me}` }, (p) => {
        const n = p.new;
        if (!n?.id || _items.some((x) => x.id === n.id)) return;
        _items = [n, ..._items].slice(0, 50);
        emit();
        document.dispatchEvent(new CustomEvent("ss:notification", { detail: n }));
      })
      .subscribe();
  } catch (e) { console.warn("[inbox] realtime failed:", e?.message || e); }
  window.addEventListener("focus", () => loadInbox({ force: true }));
}

/** Mark some (or, with no ids, all) as read. */
export async function markRead(ids = null) {
  const now = new Date().toISOString();
  _items = _items.map((n) => (!n.read_at && (!ids || ids.includes(n.id)) ? { ...n, read_at: now } : n));
  emit();
  try {
    const client = await sb();
    await client?.rpc("mark_notifications_read", { p_ids: ids });
  } catch (e) { console.warn("[inbox] mark read failed:", e?.message || e); }
}

/** Forget the signed-out user's inbox. */
export function resetInbox() {
  _items = []; _loadedFor = null; emit();
  if (_channel) { sb().then((c) => c?.removeChannel(_channel)).catch(() => {}); _channel = null; }
}

// ---- Web push ------------------------------------------------------------------

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
/** iPhone and iPad only deliver web push to the app added to the Home Screen. */
export function needsHomeScreen() {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone;
  return ios && !standalone;
}

const toKey = (b64) => {
  const s = b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};

/** "on" | "off" | "blocked" | "unsupported" for this device. */
export async function pushState() {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub && Notification.permission === "granted" ? "on" : "off";
  } catch { return "off"; }
}

async function save(sub, { categories = null, disabled = false } = {}) {
  const j = sub.toJSON();
  const client = await sb();
  if (!client) throw new Error("Sign in first.");
  const { error } = await client.rpc("save_push_subscription", {
    p_endpoint: j.endpoint, p_p256dh: j.keys?.p256dh, p_auth: j.keys?.auth,
    p_categories: categories, p_user_agent: navigator.userAgent, p_disabled: disabled,
  });
  if (error) throw new Error(error.message);
}

/** Ask permission (must run from a tap), subscribe, store. Returns the new state. */
export async function enablePush(categories = null) {
  if (!pushSupported()) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "blocked" : "off";
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(VAPID_PUBLIC_KEY) });
  await save(sub, { categories });
  return "on";
}

export async function disablePush() {
  if (!pushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    try { await save(sub, { disabled: true }); } catch {}
    try { await sub.unsubscribe(); } catch {}
  }
  return "off";
}

/** Categories this device receives (all when not subscribed yet). */
export async function pushCategories() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return CATEGORIES.map((c) => c.key);
    const client = await sb();
    const { data } = await client.from("push_subscriptions").select("categories").eq("endpoint", sub.endpoint).maybeSingle();
    return data?.categories || CATEGORIES.map((c) => c.key);
  } catch { return CATEGORIES.map((c) => c.key); }
}
export async function setPushCategories(categories) {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) await save(sub, { categories });
}
