// =============================================================================
// SYNC — mirrors local state to Supabase in real time (when enabled).
// If Supabase is enabled at boot, this hooks into state changes + runs an
// initial load from DB so the portfolio, holdings, transactions and
// watchlist all come from the server.
// =============================================================================

import { sb, isSupabaseEnabled } from "./supabase.js";
import { getState, setState, subscribe as subscribeState } from "../state.js";
import { refreshCurrentUser, currentUser } from "../auth/accounts.js";
import { go } from "../navigation.js";

let _booted = false;
let _syncing = false;

// 5-second race around any supabase-js auth call. The internal GoTrue
// `_acquireLock` mutex can deadlock in supabase-js 2.45.4 when
// autoRefreshToken collides with a stale refresh token. Pre-v137, a
// stuck auth call here would hang `loadAllFromDb` forever — portfolio
// state never got populated, UI stuck at DEFAULT_STATE (₹1L cash, no
// coach messages, no holdings) until a hard refresh let supabase-js
// re-initialize. That manifested as "my data disappeared after a
// deploy" — it wasn't actually wiped server-side, just the local
// hydrate was hung. Bounded race lets us fail fast and bail gracefully.
async function authWithTimeout(fn, name, ms = 5000) {
  const p = fn();
  const t = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`auth_timeout:${name}`)), ms));
  return Promise.race([p, t]);
}

export async function bootSync() {
  if (_booted) return;
  _booted = true;
  const client = await sb();
  if (!client) return;   // local mode, nothing to do

  // Refresh user profile cache on auth changes.
  //
  // 2026-05-05 fix: SIGNED_OUT used to do nothing here (comment said
  // "state will be cleared by the UI"). But cross-tab logouts left
  // sibling tabs visually stuck on the logged-in nav because no UI
  // re-render was triggered. Same problem if a session expires: GoTrue
  // fires SIGNED_OUT but the nav doesn't update.
  //
  // Now: on SIGNED_OUT, explicitly call switchUser() — which fires
  // emit() on all subscribers, so the nav (and every other subscribed
  // component) re-renders with isAuthed=false.
  //
  // THE CALLBACK MUST NOT AWAIT ANY SUPABASE CALL. supabase-js runs it while
  // holding its auth lock and waits for it before releasing (TOKEN_REFRESHED
  // from the refresh tick, SIGNED_IN from _recoverAndRefresh every time the
  // tab becomes visible again). This used to `await refreshCurrentUser()`
  // (getUser, which needs that same lock) and then `await loadAllFromDb()`:
  // the call queued behind the operation that was waiting for it, and every
  // later request in the tab queued behind both. On 19 Oct an admin came back
  // to the tab and NOTHING reached Supabase again (no order, not even
  // telemetry): "The server didn't answer in time". Supabase's docs say the
  // same: defer the work with setTimeout. So the callback only schedules.
  client.auth.onAuthStateChange((event, session) => {
    setTimeout(async () => {
      try {
        await refreshCurrentUser();
        if (session?.user) {
          await loadAllFromDb();
        } else if (event === "SIGNED_OUT") {
          const { switchUser } = await import("../state.js");
          switchUser();
        }
      } catch (e) { console.warn("[sync] auth change handling failed:", e?.message || e); }
    }, 0);
  });

  // Initial boot — if already logged in, load everything. Bounded
  // 5-s timeout on getSession so a stuck GoTrue lock doesn't block
  // the entire app boot. If it times out, the onAuthStateChange
  // handler above will pick up any real session on the next refresh.
  try {
    const { data: sessData } = await authWithTimeout(() => client.auth.getSession(), "boot_getSession");
    if (sessData?.session?.user) {
      await refreshCurrentUser();
      await loadAllFromDb();
    }
  } catch (e) {
    console.warn("[sync] bootSync getSession failed:", e?.message || e);
  }
}

/**
 * Pull portfolio / holdings / transactions / watchlist
 * from the DB into local state. Called on auth + periodically.
 */
export async function loadAllFromDb() {
  if (_syncing) return;
  _syncing = true;
  try {
    const client = await sb();
    if (!client) return;
    // Prefer the synchronous currentUser() cache — no auth call, no
    // lock acquisition. Only fall back to client.auth.getUser() (with
    // a 5-s timeout) if the cache is genuinely empty. This is the
    // single biggest source of "my data vanished on deploy" bug: a
    // stuck getUser call in v135 left loadAllFromDb hung forever,
    // so setState at line 121 never ran and the UI sat on
    // DEFAULT_STATE (₹1L cash, no coach messages). The cache is
    // populated by refreshCurrentUser(), which bootSync + the
    // onAuthStateChange handler both call.
    let uid = currentUser()?.id || null;
    if (!uid) {
      try {
        const { data: userData } = await authWithTimeout(
          () => client.auth.getUser(), "loadAllFromDb_getUser"
        );
        uid = userData?.user?.id || null;
      } catch (e) {
        console.warn("[sync] loadAllFromDb getUser failed:", e?.message || e);
        // CRITICAL: return WITHOUT calling setState. Bail gracefully
        // so the existing populated state (from a previous successful
        // load, persisted in localStorage) stays intact. Users don't
        // see ₹1L defaults just because auth is temporarily stuck.
        return;
      }
    }
    if (!uid) return;

    const [pf, holdings, txns, wl, msgs, hist, held] = await Promise.all([
      client.from("portfolios").select("*").eq("user_id", uid).maybeSingle(),
      client.from("holdings").select("*").eq("user_id", uid),
      fetchAllTransactions(client, uid),
      client.from("watchlist").select("symbol").eq("user_id", uid),
      client.from("coach_messages").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(500),
      // Hotfix66a: portfolio_history fetch — was missing entirely. Fixes
      // the "Chart will start drawing soon" placeholder that showed
      // forever even after dozens of trades. The DB table is populated
      // by trg_transaction_portfolio_snapshot (every trade) + the hourly
      // admin_portfolio_backfill cron, and RLS policy
      // portfolio_history_self_read lets each user fetch their own
      // rows. We just never asked. Capped at 2000 rows (~5 years of
      // hourly snapshots) so the JSON payload stays under 200KB.
      client.from("portfolio_history")
        .select("ts,total_value_paise")
        .eq("user_id", uid)
        .order("ts", { ascending: true })
        .limit(2000),
      // Cash held for pending BUY orders. Without it every page except
      // /portfolio (the only caller of setReservedCashPaise) showed the
      // portfolio short by that amount until /portfolio was opened.
      client.from("limit_orders")
        .select("reserved_cash")
        .eq("user_id", uid).eq("status", "pending").eq("side", "BUY"),
    ]);

    const state = getState();
    const reservedCashPaise = held?.error
      ? (state.portfolio?.reservedCashPaise || 0)
      : (held?.data || []).reduce((sum, o) => sum + (Number(o.reserved_cash) || 0), 0);
    const nextPortfolio = pf.data
      ? { cashPaise: Number(pf.data.cash_paise), startingCashPaise: Number(pf.data.starting_cash_paise), reservedCashPaise }
      : state.portfolio;

    const nextHoldings = {};
    for (const h of (holdings.data || [])) {
      nextHoldings[h.symbol] = {
        qty: Number(h.qty),
        avgCostPaise: Number(h.avg_cost_paise),
        firstBoughtAt: new Date(h.first_bought_at).getTime(),
      };
    }

    const nextTxns = (txns.data || []).reverse().map(t => ({
      id: t.id, idempotencyKey: t.idempotency_key, ts: new Date(t.created_at).getTime(),
      symbol: t.symbol, side: t.side, qty: Number(t.qty),
      pricePaise: Number(t.price_paise), valuePaise: Number(t.value_paise),
      biasFlags: t.bias_flags || [],
    }));

    const nextWatchlist = (wl.data || []).map(w => w.symbol);

    const nextCoachMessages = (msgs.data || []).reverse().map(m => ({
      id: m.id, ts: new Date(m.created_at).getTime(),
      eventType: m.event_type, triggerSymbol: m.trigger_symbol,
      payload: m.payload, model: m.model,
    }));

    // Hotfix66a: project portfolio_history rows to {ts, valuePaise}
    // tuples. portfolio.js maps these to a flat numeric series for
    // areaChart and gates "hasRealHistory" on length > 1.
    const nextPortfolioHistory = (hist?.data || []).map(r => ({
      ts: new Date(r.ts).getTime(),
      valuePaise: Number(r.total_value_paise),
    }));

    setState(s => ({
      ...s,
      portfolio: nextPortfolio,
      holdings: nextHoldings,
      transactions: nextTxns,
      watchlist: nextWatchlist,
      coachMessages: nextCoachMessages,
      portfolioHistory: nextPortfolioHistory,
    }));

    // Rebuild the /chat multi-session envelope + side-panel running log
    // from the coach_messages rows we just fetched. v142: coach_messages
    // is the single source of truth; localStorage is a cache. Every chat
    // turn was already being written per-row via logChatTurn → this
    // just reads them back and regroups. Idempotent — running it on
    // every boot is fine.
    try { rebuildChatSessionsFromDb(msgs.data || [], uid || null); }
    catch (e) { console.warn("[sync] rebuild chat sessions failed:", e?.message || e); }
  } finally {
    _syncing = false;
  }
}

// ---------------------------------------------------------------------------
// Write-side helpers — called by state.js / features when user mutates data.
// ---------------------------------------------------------------------------

/** Add a stock to watchlist */
export async function dbAddWatchlist(symbol) {
  const client = await sb();
  if (!client) return;
  const { data: u } = await client.auth.getUser();
  if (!u?.user) return;
  await client.from("watchlist").upsert({ user_id: u.user.id, symbol }).select();
}

export async function dbRemoveWatchlist(symbol) {
  const client = await sb();
  if (!client) return;
  const { data: u } = await client.auth.getUser();
  if (!u?.user) return;
  await client.from("watchlist").delete().eq("user_id", u.user.id).eq("symbol", symbol);
}

export async function dbAddCoachMessage(msg) {
  const client = await sb();
  if (!client) return;
  const { data: u } = await client.auth.getUser();
  if (!u?.user) return;
  const row = {
    user_id: u.user.id,
    event_type: msg.eventType,
    trigger_symbol: msg.triggerSymbol || null,
    payload: msg.payload || {},
    model: msg.model || null,
  };
  // v142: session_id + surface columns added so the client can rebuild
  // its multi-session chat UI from coach_messages directly (retiring
  // the redundant coach_chats blob table + all its sync race fixes).
  // Both columns are nullable — legacy rows without them still render
  // in admin via the existing 30-min-gap session heuristic, and new
  // chat turns now carry explicit grouping info.
  if (msg.sessionId) row.session_id = msg.sessionId;
  if (msg.surface)   row.surface    = msg.surface;
  const { error } = await client.from("coach_messages").insert(row);
  if (error) console.warn("[coach-msg] insert failed:", error.message);
}

// Every trade, newest first, 1,000 a page. The boot load used to stop at the
// newest 200, so win/loss, realised P&L and hold times would quietly drop
// older trades once a user passed 200 (O12). Same { data, error } shape as a
// single query.
async function fetchAllTransactions(client, uid) {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; from < 20_000; from += PAGE) {
    const { data, error } = await client.from("transactions").select("*")
      .eq("user_id", uid).order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) return rows.length ? { data: rows, error: null } : { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { data: rows, error: null };
}

/** Apply a trade via the apply_trade RPC (atomic) */
export async function dbApplyTrade({ symbol, side, qty, pricePaise, idempotencyKey, biasFlags }) {
  const client = await sb();
  if (!client) throw new Error("Backend not configured.");
  await ensureAuthedOrRedirect(client);
  // Race the RPC against a 10 s timeout. apply_trade has occasionally hung
  // on SELL when earlier failed calls left row-locks queued in the pool —
  // without this, the confirm modal would sit forever and the UI looks
  // dead. 10 s is generous (usually completes in <200ms); anything longer
  // is either a real problem or a transient lock that'll clear in a minute.
  const { data, error } = await Promise.race([
    client.rpc("apply_trade", {
      p_symbol: symbol,
      p_side: side,
      p_qty: qty,
      p_price_paise: pricePaise,
      p_idempotency_key: idempotencyKey,
      p_bias_flags: biasFlags || [],
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("trade_timeout")), 10_000)),
  ]);
  if (error) {
    if (/not logged in/i.test(error.message)) await handleSessionLost();
    throw new Error(prettifyErr(error.message));
  }
  return data;
}

// ---------------------------------------------------------------------------
// COACH CHAT RECONSTRUCTION — v142 architecture.
//
// Chat history has ALWAYS been written to the `coach_messages` table in real
// time via logChatTurn → dbAddCoachMessage (event_type "chat_user" /
// "chat_assistant"). The per-user `coach_chats` blob table I added in v138
// was redundant — the admin panel already rendered everyone's chats from
// coach_messages regardless of any localStorage sync.
//
// v142 retires the coach_chats table. coach_messages is the single source
// of truth. The client reconstructs its multi-session `/chat` envelope +
// side-panel running log from coach_messages rows on every boot. New
// session_id + surface columns (migration 2026-04-25a) carry the
// grouping info; legacy rows with NULL columns fall back to a 30-minute
// time-gap heuristic — same logic renderCoachSection already uses in
// admin.js.
//
// localStorage remains a cache for instant paint + offline, but is no
// longer authoritative. Writes go straight to coach_messages via
// dbAddCoachMessage; there's no debounced upsert, no gate, no race.
// ---------------------------------------------------------------------------
const SESSIONS_LS_KEY = "ss.chat.sessions.v1";
const COACHLOG_LS_KEY = "ss.coachchat.v1";
const CHAT_OWNER_KEY  = "ss.chat.owner.v1";
const SESSION_GAP_MS = 30 * 60_000;

function readLocalJson(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}

const chatMsgKey = (m) => `${m.role}|${String(m.text || "").trim()}`;
const usableMsg = (m) => m && !m.streaming && (m.role === "user" || m.role === "assistant") &&
  typeof m.text === "string" && m.text.trim();

/**
 * Fold this device's not-yet-persisted chat messages into the rebuilt
 * structures, in place. A local message survives when it is newer than the
 * newest DB row it would sit beside (2 s of slack for client/server clock
 * skew) and is not already there by role + text. Local sessions the DB has
 * never seen are kept when they are newer than everything in the DB — e.g.
 * a chat started a moment ago whose first turn is still in flight.
 * Call only after enforceChatCacheOwner(), so the cache is this user's.
 */
function mergeLocalChatTail(sessions, coachLog) {
  const SKEW_MS = 2_000;

  const local = readLocalJson(SESSIONS_LS_KEY);
  if (local && Array.isArray(local.sessions)) {
    const dbNewest = sessions.reduce((n, s) => Math.max(n, s.updatedAt || 0), 0);
    const byId = new Map(sessions.map(s => [s.id, s]));
    for (const ls of local.sessions) {
      if (!ls?.id || !Array.isArray(ls.messages)) continue;
      const msgs = ls.messages.filter(usableMsg);
      const db = byId.get(ls.id);
      if (db) {
        const seen = new Set(db.messages.map(chatMsgKey));
        const extra = msgs.filter(m => (m.ts || 0) > (db.updatedAt || 0) + SKEW_MS && !seen.has(chatMsgKey(m)));
        if (extra.length) {
          db.messages.push(...extra.map(m => ({ role: m.role, text: m.text, ts: m.ts })));
          db.updatedAt = Math.max(db.updatedAt || 0, ...extra.map(m => m.ts || 0));
        }
      } else {
        const newest = Math.max(ls.createdAt || 0, ...msgs.map(m => m.ts || 0));
        if (newest > dbNewest + SKEW_MS && (msgs.length || ls.id === local.activeId)) {
          sessions.push({
            id: ls.id,
            title: ls.title || "New chat",
            messages: msgs.map(m => ({ role: m.role, text: m.text, ts: m.ts })),
            createdAt: ls.createdAt || newest,
            updatedAt: newest,
          });
        }
      }
    }
  }

  const localLog = readLocalJson(COACHLOG_LS_KEY);
  if (Array.isArray(localLog) && localLog.length) {
    const dbNewest = coachLog.reduce((n, m) => Math.max(n, m.ts || 0), 0);
    const seen = new Set(coachLog.map(chatMsgKey));
    const extra = localLog.filter(m => usableMsg(m) && (m.ts || 0) > dbNewest + SKEW_MS && !seen.has(chatMsgKey(m)));
    coachLog.push(...extra.map(m => ({ role: m.role, text: m.text, ts: m.ts })));
  }
}

/**
 * Which user the cached chat history on this device belongs to.
 *
 * The coach caches are PLAIN localStorage keys with no user scoping, and
 * logout only ever removed the auth session — so a signed-out browser kept a
 * full transcript of the last person's conversations with the coach. `/chat`
 * is a PUBLIC route (router.js), so anyone could then open it and read them:
 * portfolio values, what they were worried about, their questions. On a
 * shared family laptop or a school computer that is a straight privacy leak,
 * and these are 13-18 year olds.
 *
 * There is a second path to the same place: rebuildChatSessionsFromDb()
 * returns early when the incoming user has NO chat rows, leaving the previous
 * user's cache untouched. So signing in as someone new who has never chatted
 * showed them the previous account's history.
 *
 * RLS on coach_messages is correct (auth.uid() = user_id) — nothing leaked
 * server-side. This is purely the local cache outliving its owner.
 */
export function clearChatCaches() {
  try { localStorage.removeItem(SESSIONS_LS_KEY); } catch {}
  try { localStorage.removeItem("ss.chat.meta.v1"); } catch {}
  try { localStorage.removeItem(COACHLOG_LS_KEY); } catch {}
  try { localStorage.removeItem(CHAT_OWNER_KEY); } catch {}
  try { window.dispatchEvent(new CustomEvent("ss:coach-sync")); } catch {}
}

/**
 * Drop the cached chat history unless it belongs to `userId`.
 * Pass null/undefined for "nobody is logged in" — which also wipes.
 * Safe to call on every boot and every user switch.
 */
export function enforceChatCacheOwner(userId) {
  let owner = null;
  try { owner = localStorage.getItem(CHAT_OWNER_KEY); } catch {}
  const hasCache = (() => {
    try {
      return !!(localStorage.getItem(SESSIONS_LS_KEY) || localStorage.getItem(COACHLOG_LS_KEY));
    } catch { return false; }
  })();

  if (!userId) {
    if (hasCache) clearChatCaches();
    return;
  }
  if (owner !== userId) {
    // Either unowned legacy cache or someone else's — never show it to
    // this user. Their own history re-hydrates from coach_messages.
    if (hasCache) clearChatCaches();
    try { localStorage.setItem(CHAT_OWNER_KEY, userId); } catch {}
  }
}

/**
 * Reconstruct the `/chat` multi-session envelope + the coach-panel running
 * log from coach_messages rows. Called from loadAllFromDb after each boot.
 *
 * Expected input: rows coming out of loadAllFromDb's coach_messages query
 * in whatever order Supabase returned (usually newest first — we re-sort).
 *
 * Writes to localStorage (as a cache) and dispatches ss:coach-sync so any
 * live-mounted chat view reloads. No-op if the user has never chatted.
 */
export function rebuildChatSessionsFromDb(coachMessagesRows, userId = null) {
  if (!Array.isArray(coachMessagesRows)) return;
  // Do this FIRST. The early return below (no chat rows for this user) used
  // to leave the previous account's cached transcript sitting on the device,
  // so signing in as someone who had never chatted showed them the last
  // person's conversation.
  enforceChatCacheOwner(userId);
  const chatRows = coachMessagesRows
    .filter(r => r && typeof r.event_type === "string" &&
      (r.event_type === "chat_user" || r.event_type === "chat_assistant"))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (!chatRows.length) return;

  // Split by surface. Legacy rows (surface=NULL, pre-v142) belong to the
  // chat-page history — except the side panel's tool-path turns, which were
  // logged without a surface until 2026-10-13 (model "gemini-chat-tools").
  // Filed under the chat page, those replies vanished from the panel on the
  // next boot and turned up as stray sessions on /chat instead.
  const panelToolRow = new Set();
  for (let i = 0; i < chatRows.length; i++) {
    const r = chatRows[i];
    if (r.surface || r.event_type !== "chat_assistant" || r.model !== "gemini-chat-tools") continue;
    panelToolRow.add(r);
    const u = chatRows[i - 1];
    if (u && !u.surface && u.event_type === "chat_user" &&
        new Date(r.created_at) - new Date(u.created_at) < 5_000) panelToolRow.add(u);
  }
  const chatPageRows = chatRows.filter(r => (!r.surface && !panelToolRow.has(r)) || r.surface === "chat_page");
  const sidePanelRows = chatRows.filter(r => r.surface === "side_panel" || panelToolRow.has(r));

  // /chat multi-session envelope. Prefer explicit session_id; fall back
  // to the 30-min time-gap heuristic for legacy rows.
  const sessions = [];
  let cur = null;
  let lastTs = 0;
  for (const r of chatPageRows) {
    const ts = new Date(r.created_at).getTime();
    const rowSid = r.session_id || null;
    let startNew = false;
    if (!cur) startNew = true;
    else if (rowSid && cur.id !== rowSid) startNew = true;
    else if (!rowSid && ts - lastTs > SESSION_GAP_MS) startNew = true;
    if (startNew) {
      cur = {
        id: rowSid || `legacy_${ts}`,
        title: "New chat",
        messages: [],
        createdAt: ts,
        updatedAt: ts,
      };
      sessions.push(cur);
    }
    cur.messages.push({
      role: r.event_type === "chat_user" ? "user" : "assistant",
      text: r.payload?.text || "",
      ts,
    });
    cur.updatedAt = ts;
    lastTs = ts;
  }

  // Derive titles from the first user message in each session, matching
  // chatSessions.deriveTitle()'s behaviour so the list looks the same
  // whether rebuilt from DB or built fresh in chatSessions.js.
  for (const s of sessions) {
    const firstUser = s.messages.find(m => m.role === "user" && m.text);
    if (firstUser) {
      s.title = String(firstUser.text).replace(/\s+/g, " ").trim().slice(0, 42) || "New chat";
    }
  }

  // Side-panel running log — flat, chronological.
  const coachLog = sidePanelRows.map(r => ({
    role: r.event_type === "chat_user" ? "user" : "assistant",
    text: r.payload?.text || "",
    ts: new Date(r.created_at).getTime(),
  }));

  // Keep the turns this device has that the DB does not yet. This rebuild
  // used to REPLACE the local cache with the DB snapshot fetched at boot, so
  // a message sent while that fetch was in flight — or a turn whose insert
  // had not landed — was wiped from localStorage, and the chat page reloaded
  // without it: the "message vanished" reports. Only messages newer than the
  // newest DB row are carried over, so cleaned-up local copies of turns the
  // DB already holds are not duplicated.
  mergeLocalChatTail(sessions, coachLog);

  let touched = false;
  if (sessions.length) {
    let activeId = sessions[sessions.length - 1].id;
    const localActive = readLocalJson(SESSIONS_LS_KEY)?.activeId;
    if (localActive && sessions.some(s => s.id === localActive)) activeId = localActive;
    try {
      localStorage.setItem(SESSIONS_LS_KEY, JSON.stringify({ activeId, sessions }));
      touched = true;
    } catch (e) { console.warn("[coach-sync] rebuild sessions write failed:", e); }
  }
  if (coachLog.length) {
    try {
      localStorage.setItem(COACHLOG_LS_KEY, JSON.stringify(coachLog));
      touched = true;
    } catch (e) { console.warn("[coach-sync] rebuild coachLog write failed:", e); }
  }
  if (touched) {
    if (userId) { try { localStorage.setItem(CHAT_OWNER_KEY, userId); } catch {} }
    try { window.dispatchEvent(new CustomEvent("ss:coach-sync")); } catch {}
    console.log(`[coach-sync] rebuilt ${sessions.length} session(s), ${coachLog.length} panel msg(s) from coach_messages`);
  }
}

// Backward-compat shim: chatSessions.saveSessions + coachPanel.saveChat
// in the old code tried to dynamic-import this function and call it on
// every save. That v138-era path is deprecated — writes now go through
// logChatTurn → dbAddCoachMessage — but keeping the export as a no-op
// means any stale cached JS (service worker) doesn't throw on import.
export function dbSaveCoachChatsSoon() { /* retired in v142 */ }

function prettifyErr(msg) {
  if (!msg) return "Something went wrong.";
  if (/insufficient cash/i.test(msg)) return "Not enough cash.";
  if (/insufficient holding/i.test(msg)) return "You don't have enough of that stock to sell.";
  if (/not logged in/i.test(msg)) return "Your session expired. Please log in again.";
  return msg;
}

// Guard against the silent ghost-session bug: a stale ss.session.v1 used to
// let users past needsAuth with no Supabase session at all. If that happens
// now we clear the phantom cache, nudge them to /login, and surface a clean
// error instead of the raw postgres "not logged in".
async function ensureAuthedOrRedirect(client) {
  try {
    const { data } = await client.auth.getSession();
    if (data?.session?.access_token) return;
  } catch {}
  await handleSessionLost();
  throw new Error("Your session expired. Please log in again.");
}

// Exported so state.js can route a failed trade through the same
// session-lost path instead of silently writing a local-only txn.
export async function handleSessionLost() {
  try {
    const { logoutAccount } = await import("../auth/accounts.js");
    await logoutAccount();
  } catch {}
  try { go("/login"); } catch {}
}
