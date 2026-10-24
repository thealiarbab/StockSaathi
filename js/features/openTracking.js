// =============================================================================
// OPEN TRACKING — which push and which email brought someone back.
//
// A push tap opens its url with ?ss_n=<notification id>&ss_via=push (sw.js);
// every link in a fill email or weekly report carries ?ss_e=<email id>
// (handlers/fill-email.py, weekly-report.py). Read once at boot, reported to
// log_notif_open / log_email_click (migration 2026-10-24e, signed in or not),
// then removed from the address bar so a refresh or a shared link doesn't
// count again. A bell tap reports through logNotifOpen(id, "bell").
//
// Never allowed to break the page: every failure is swallowed.
// =============================================================================

import { sb } from "../db/supabase.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rpc(name, args) {
  try {
    const client = await sb();
    if (client) await client.rpc(name, args);
  } catch { /* tracking must never break the page */ }
}

export function logNotifOpen(id, via = "bell") {
  if (UUID.test(String(id || ""))) rpc("log_notif_open", { p_id: id, p_via: via });
}

/** Call before the router reads the URL. Synchronous strip, async report. */
export function captureOpen() {
  try {
    const url = new URL(location.href);
    const n = url.searchParams.get("ss_n");
    const via = url.searchParams.get("ss_via");
    const e = url.searchParams.get("ss_e");
    if (!n && !e) return;
    ["ss_n", "ss_via", "ss_e"].forEach((k) => url.searchParams.delete(k));
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    if (n) logNotifOpen(n, via === "push" ? "push" : "bell");
    if (e && UUID.test(e)) rpc("log_email_click", { p_id: e });
  } catch { /* never break boot */ }
}
