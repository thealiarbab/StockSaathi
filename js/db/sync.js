// =============================================================================
// SYNC — mirrors local state to Supabase in real time (when enabled).
// If Supabase is enabled at boot, this hooks into state changes + runs an
// initial load from DB so the portfolio, holdings, transactions, friends,
// transfers, watchlist all come from the server.
// =============================================================================

import { sb, isSupabaseEnabled } from "./supabase.js";
import { getState, setState, subscribe as subscribeState } from "../state.js";
import { refreshCurrentUser, currentUser } from "../auth/accounts.js";

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
  client.auth.onAuthStateChange(async (event, session) => {
    await refreshCurrentUser();
    if (session?.user) {
      await loadAllFromDb();
    } else if (event === "SIGNED_OUT") {
      try {
        const { switchUser } = await import("../state.js");
        switchUser();
      } catch {}
    }
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
 * Pull portfolio / holdings / transactions / watchlist / friends / transfers
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

    // Friends and transfers go through SECURITY DEFINER RPCs so the
    // counterparty's username + display name come back even though the new
    // profiles RLS blocks anon cross-user reads. The Postgrest join approach
    // used previously silently returned empty profile objects under RLS.
    const [pf, holdings, txns, wl, friendsRpc, transfersRpc, msgs, hist] = await Promise.all([
      client.from("portfolios").select("*").eq("user_id", uid).maybeSingle(),
      client.from("holdings").select("*").eq("user_id", uid),
      client.from("transactions").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(200),
      client.from("watchlist").select("symbol").eq("user_id", uid),
      client.rpc("list_my_friends"),
      client.rpc("list_my_transfers", { p_limit: 100 }),
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
    ]);
    const friends = { data: friendsRpc.data || [], error: friendsRpc.error };
    const transfers = { data: transfersRpc.data || [], error: transfersRpc.error };

    const state = getState();
    const nextPortfolio = pf.data
      ? { cashPaise: Number(pf.data.cash_paise), startingCashPaise: Number(pf.data.starting_cash_paise) }
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

    const nextFriends = (friends.data || []).map(f => ({
      id: f.friend_id,
      username: f.username,
      displayName: f.display_name,
      avatarColor: f.avatar_color,
      school: f.school,
      addedAt: f.added_at ? new Date(f.added_at).getTime() : Date.now(),
    }));

    const nextTransfers = (transfers.data || []).map(tr => ({
      id: tr.id,
      direction: tr.direction,
      counterpartyId: tr.counterparty_id,
      counterpartyHandle: tr.counterparty_username,
      counterpartyName: tr.counterparty_display_name || tr.counterparty_username || null,
      counterpartyAvatarColor: tr.counterparty_avatar_color,
      amountPaise: Number(tr.amount_paise),
      note: tr.note,
      status: tr.status,
      code: tr.code,
      ts: new Date(tr.created_at).getTime(),
    }));

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
      friends: nextFriends,
      transfers: nextTransfers,
      coachMessages: nextCoachMessages,
      portfolioHistory: nextPortfolioHistory,
    }));

    // Rebuild the /chat multi-session envelope + side-panel running log
    // from the coach_messages rows we just fetched. v142: coach_messages
    // is the single source of truth; localStorage is a cache. Every chat
    // turn was already being written per-row via logChatTurn → this
    // just reads them back and regroups. Idempotent — running it on
    // every boot is fine.
    try { rebuildChatSessionsFromDb(msgs.data || []); }
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

export async function dbAddFriend(friendUsername) {
  const client = await sb();
  if (!client) throw new Error("Backend not configured.");
  await ensureAuthedOrRedirect(client);
  const { data, error } = await client.rpc("add_friend_by_username",
    { p_username: friendUsername.trim() });
  if (error) {
    const msg = String(error.message || "");
    if (/recipient not found/i.test(msg)) throw new Error(`No StockSaathi user "@${friendUsername}".`);
    if (/cannot add yourself/i.test(msg)) throw new Error("You can't add yourself.");
    if (/not logged in/i.test(msg)) {
      await handleSessionLost();
      throw new Error("Your session expired. Please log in again.");
    }
    throw new Error(prettifyErr(msg));
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error(`No StockSaathi user "@${friendUsername}".`);
  return {
    id: row.friend_id,
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
  };
}

export async function dbRemoveFriend(friendId) {
  const client = await sb();
  if (!client) return;
  const { data: u } = await client.auth.getUser();
  if (!u?.user) return;
  await client.from("friends").delete().eq("user_id", u.user.id).eq("friend_id", friendId);
}

/** Send money via the apply_transfer RPC (atomic) */
export async function dbSendTransfer({ recipientHandle, amountPaise, note }) {
  const client = await sb();
  if (!client) throw new Error("Backend not configured.");
  await ensureAuthedOrRedirect(client);
  const { data, error } = await client.rpc("apply_transfer", {
    p_recipient_username: recipientHandle,
    p_amount_paise: amountPaise,
    p_note: note || "",
  });
  if (error) {
    if (/not logged in/i.test(error.message)) await handleSessionLost();
    throw new Error(prettifyErr(error.message));
  }
  return data;
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
const SESSION_GAP_MS = 30 * 60_000;

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
export function rebuildChatSessionsFromDb(coachMessagesRows) {
  if (!Array.isArray(coachMessagesRows)) return;
  const chatRows = coachMessagesRows
    .filter(r => r && typeof r.event_type === "string" &&
      (r.event_type === "chat_user" || r.event_type === "chat_assistant"))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (!chatRows.length) return;

  // Split by surface. Legacy rows (surface=NULL, pre-v142) belong to the
  // chat-page history — the side panel has always written through via
  // the same logChatTurn path so the merge is correct.
  const chatPageRows = chatRows.filter(r => !r.surface || r.surface === "chat_page");
  const sidePanelRows = chatRows.filter(r => r.surface === "side_panel");

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

  let touched = false;
  if (sessions.length) {
    const activeId = sessions[sessions.length - 1].id;
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
  if (/recipient not found/i.test(msg)) return "We couldn't find that StockSaathi user.";
  if (/cannot send to self/i.test(msg)) return "You can't send money to yourself.";
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
  try { window.location.hash = "#/login"; } catch {}
}
