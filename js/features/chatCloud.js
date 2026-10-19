// =============================================================================
// CHAT CLOUD — conversations as documents in public.chat_threads (migration
// 2026-10-19c), plus share links and reply feedback.
//
// Why a document: coach_messages stores one flat line of turns, and the chat
// page is rebuilt from it on every visit, which would throw away every edited
// question and regenerated answer (see chatBranches.js). A thread row holds the
// whole tree, so versions survive reloads and other devices. coach_messages is
// still written per turn for the admin views.
//
// Every call is best-effort: the chat keeps working from localStorage if the
// network or the table is unavailable.
// =============================================================================

import { sb } from "../db/supabase.js";
import { stripVers } from "./chatBranches.js";

const _timers = new Map();

function threadRow(s) {
  return {
    id: s.id,
    title: String(s.title || "New chat").slice(0, 120),
    pinned: !!s.pinned,
    archived: !!s.archived,
    trashed: !!s.trashed,
    doc: { v: 1, messages: s.messages || [], pruned: (s.pruned || []).slice(-500) },
    created_at: new Date(s.createdAt || Date.now()).toISOString(),
    updated_at: new Date(s.updatedAt || Date.now()).toISOString(),
  };
}

/** Save a conversation (debounced per thread). */
export function pushThread(session, { now = false } = {}) {
  if (!session?.id) return;
  if (!(session.messages || []).length && !session.trashed) return;
  clearTimeout(_timers.get(session.id));
  const run = async () => {
    _timers.delete(session.id);
    try {
      const client = await sb();
      if (!client) return;
      const { error } = await client.from("chat_threads").upsert(threadRow(session), { onConflict: "id" });
      if (error) console.warn("[chat-cloud] save failed:", error.message);
    } catch (e) { console.warn("[chat-cloud] save failed:", e?.message || e); }
  };
  if (now) return run();
  _timers.set(session.id, setTimeout(run, 1200));
}

/** All of the user's conversations, newest first ([] on any failure). */
export async function pullThreads() {
  try {
    const client = await sb();
    if (!client) return [];
    const { data, error } = await client.from("chat_threads")
      .select("id,title,pinned,archived,trashed,doc,created_at,updated_at")
      .order("updated_at", { ascending: false }).limit(300);
    if (error) { console.warn("[chat-cloud] load failed:", error.message); return []; }
    return (data || []).map((r) => ({
      id: r.id,
      title: r.title || "New chat",
      pinned: !!r.pinned,
      archived: !!r.archived,
      trashed: !!r.trashed,
      messages: Array.isArray(r.doc?.messages) ? r.doc.messages : [],
      pruned: Array.isArray(r.doc?.pruned) ? r.doc.pruned : [],
      createdAt: Date.parse(r.created_at) || Date.now(),
      updatedAt: Date.parse(r.updated_at) || Date.now(),
    }));
  } catch (e) {
    console.warn("[chat-cloud] load failed:", e?.message || e);
    return [];
  }
}

// ---- Share links -------------------------------------------------------------

const AMOUNT_RE = /₹\s?[\d,]+(?:\.\d+)?(?:\s?(?:L|Cr|lakh|crore|k))?/gi;

/** The on-screen branch as a public snapshot. hideAmounts masks every ₹ figure. */
export function shareSnapshot(messages, { hideAmounts = false } = {}) {
  return (messages || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && !m.streaming && !m.status && String(m.text || "").trim())
    .map((m) => {
      const x = stripVers(m);
      let text = String(x.text || "");
      if (hideAmounts) text = text.replace(AMOUNT_RE, "₹•••");
      const out = { role: x.role, text, ts: x.ts };
      if (x.card && !hideAmounts) out.card = x.card;
      if (x.chart && !hideAmounts) out.chart = x.chart;
      return out;
    });
}

/** Create or refresh the share link for a thread. Returns { id, url } or throws. */
export async function upsertShare({ threadId, title, messages, hideAmounts, existingId }) {
  const client = await sb();
  if (!client) throw new Error("Sign in to share a chat.");
  const row = {
    thread_id: threadId,
    title: String(title || "StockSaathi chat").slice(0, 120),
    messages: shareSnapshot(messages, { hideAmounts }),
    hide_amounts: !!hideAmounts,
    revoked: false,
    updated_at: new Date().toISOString(),
  };
  const q = existingId
    ? client.from("chat_shares").update(row).eq("id", existingId).select("id").single()
    : client.from("chat_shares").insert(row).select("id").single();
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return { id: data.id, url: `${location.origin}/share/${data.id}` };
}

export async function listShares() {
  const client = await sb();
  if (!client) return [];
  const { data, error } = await client.from("chat_shares")
    .select("id,thread_id,title,hide_amounts,revoked,views,created_at,updated_at")
    .eq("revoked", false).order("created_at", { ascending: false }).limit(100);
  return error ? [] : (data || []);
}

export async function revokeShare(id) {
  const client = await sb();
  if (!client) return false;
  const { error } = await client.from("chat_shares").update({ revoked: true, updated_at: new Date().toISOString() }).eq("id", id);
  return !error;
}

/** Public read of a shared chat (works signed out). null if missing or revoked. */
export async function fetchShared(id) {
  const client = await sb();
  if (!client) return null;
  const { data, error } = await client.rpc("get_shared_chat", { p_id: String(id || "") });
  return error ? null : data;
}

// ---- Feedback ---------------------------------------------------------------

export async function sendFeedback({ threadId, ts, rating, reason, reply }) {
  try {
    const client = await sb();
    if (!client) return false;
    const { error } = await client.from("chat_feedback").insert({
      thread_id: threadId || null, msg_ts: ts || null, rating, reason: reason || null,
      reply: String(reply || "").slice(0, 4000),
    });
    return !error;
  } catch { return false; }
}
