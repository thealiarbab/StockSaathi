// =============================================================================
// STATE — dual-mode reactive store.
//   Supabase mode: Postgres-backed. RLS enforces isolation. Cross-device.
//   Local mode:   per-user localStorage (legacy fallback).
//
// All pages read from getState() synchronously regardless of mode. In Supabase
// mode, js/db/sync.js populates this store from the DB on boot + auth change.
// Writes call DB RPCs first, then update local cache for snappy UI.
// All money is PAISE (integer).
// =============================================================================

import { currentUser } from "./auth/accounts.js";
import { dbApplyTrade, dbAddWatchlist, dbRemoveWatchlist, dbAddCoachMessage, handleSessionLost } from "./db/sync.js";
import { sb } from "./db/supabase.js";

const STARTING_CASH_PAISE = 1_00_00_000;
const VERSION = 3;

const DEFAULT_STATE = () => ({
  version: VERSION,
  portfolio: { cashPaise: STARTING_CASH_PAISE, startingCashPaise: STARTING_CASH_PAISE },
  holdings: {},
  transactions: [],
  transfers: [],
  inbox: [],
  coachMessages: [],
  watchlist: [],
  friends: [],
  badges: [],
  profile: {
    riskProfile: null, school: null, classCode: null, age: null,
    onboarded: false,
  },
  demo: { crashReplayCompleted: [], firstTradeDone: false },
});

const GLOBAL_SETTINGS_KEY = "ss.settings.v1";
const GLOBAL_SETTINGS_DEFAULTS = {
  theme: "light",
  hinglish: false,
  coachPanelOpen: false,  // Closed by default; user opens via FAB. Prevents
                          // mobile overlay from blocking signup/CTAs.
  llmApiKey: "",
  finnhubKey: "",
  emailjs: { serviceId: "", templateId: "", publicKey: "" },
};

function keyFor(userId) { return `ss.userstate.${userId}`; }

function readUserState(userId) {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return migrateUserState(parsed);
  } catch { return null; }
}

// One-time client-side migrations applied to whatever shape the user's
// localStorage held when the page last persisted. Runs on every read but
// must be idempotent — produces the same output if called twice. Wired
// into readUserState in the next commit.
function migrateUserState(st) {
  if (!st || typeof st !== "object") return st;
  // Migration: purge gibberish STOCK_INTRO coach messages persisted from
  // pre-Hotfix15 runs of the page. Pattern: the orchestrator pre-fix
  // discarded the merged event.instrument and looked up the universe row
  // afresh — which had inst.pe=null (Landing F stripped hand-typed PE
  // values), producing the literal text "P/E is —, which means investors
  // are paying ₹— for every ₹1 of annual earnings." for every stock.
  // Plus a sister symptom: "{NAME} is a Other company." from stocks that
  // were classified before sector taxonomy expanded. Both messages stick
  // forever once persisted because the existing-symbol guard at
  // stockDetail.js:269 prevents a fresh STOCK_INTRO from re-firing.
  if (Array.isArray(st.coachMessages) && st.coachMessages.length) {
    const before = st.coachMessages.length;
    st.coachMessages = st.coachMessages.filter(m => {
      if (m?.eventType !== "STOCK_INTRO") return true;
      const body = String(m?.payload?.body || m?.body || m?.text || "");
      if (/P\/E is\s+[—-]/.test(body)) return false;
      if (/is a Other company/.test(body)) return false;
      return true;
    });
    if (st.coachMessages.length < before) {
      console.info(`[state migration] purged ${before - st.coachMessages.length} stale STOCK_INTRO message(s)`);
    }
  }
  return st;
}
function writeUserState(userId, st) {
  const stamped = { ...st, _persistedAt: Date.now() };
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(stamped));
  } catch (e) {
    // Quota handling: large coach histories can blow the 5 MB cap. Trim the
    // heaviest arrays (coachMessages + transactions + transfers) and retry
    // once — losing old chat history is better than losing new trades.
    const isQuota = e && (e.name === "QuotaExceededError"
                          || (e.code && (e.code === 22 || e.code === 1014)));
    if (!isQuota) { console.warn("state persist failed:", e); return; }
    try {
      const trimmed = {
        ...stamped,
        coachMessages: (stamped.coachMessages || []).slice(-50),
        transactions: (stamped.transactions || []).slice(-500),
        transfers: (stamped.transfers || []).slice(-200),
        inbox: (stamped.inbox || []).slice(-100),
      };
      localStorage.setItem(keyFor(userId), JSON.stringify(trimmed));
      console.warn("state trimmed after QuotaExceededError (coach history shrunk).");
    } catch (e2) {
      console.error("state persist failed even after trim:", e2);
    }
  }
}

function readSettings() {
  try {
    const raw = localStorage.getItem(GLOBAL_SETTINGS_KEY);
    if (!raw) return { ...GLOBAL_SETTINGS_DEFAULTS };
    const parsed = JSON.parse(raw);
    // Migrate legacy field name to the current one; write-back happens on the
    // next setSetting() call so old key drops from storage naturally.
    if (parsed && parsed.anthropicKey && !parsed.llmApiKey) {
      parsed.llmApiKey = parsed.anthropicKey;
    }
    delete parsed.anthropicKey;
    return { ...GLOBAL_SETTINGS_DEFAULTS, ...parsed };
  } catch { return { ...GLOBAL_SETTINGS_DEFAULTS }; }
}
function writeSettings(s) { localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(s)); }

// --------------------------------------------------------------------------
const listeners = new Set();

let _userState = null;
let _activeUserId = null;
let _settings = readSettings();

function ensureUserLoaded() {
  const user = currentUser();
  if (!user) { _userState = null; _activeUserId = null; return null; }
  if (_activeUserId !== user.id) {
    _activeUserId = user.id;
    _userState = readUserState(user.id) || DEFAULT_STATE();
  }
  return _userState;
}

ensureUserLoaded();

function merge(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    if (typeof base[k] === "object" && base[k] !== null && !Array.isArray(base[k])
        && typeof over[k] === "object" && over[k] !== null && !Array.isArray(over[k])) {
      out[k] = { ...base[k], ...over[k] };
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

export function getState() {
  ensureUserLoaded();
  const user = currentUser();
  const us = _userState || DEFAULT_STATE();
  return {
    user: {
      id: user?.id || null,
      username: user?.username || null,
      displayName: user?.displayName || null,
      email: user?.email || null,
      avatarColor: user?.avatarColor || "green",
      age: user?.age ?? us.profile.age,
      school: user?.school ?? us.profile.school,
      classCode: user?.classCode ?? us.profile.classCode,
      riskProfile: user?.riskProfile ?? us.profile.riskProfile,
      // Hotfix41: was `user?.onboarded ?? us.profile.onboarded`. The `??`
      // operator only falls through on null/undefined â€” so if the auth
      // layer's cached user has onboarded=false (DB write hadn't yet
      // resolved), that false beat local state's `true` and the router
      // bounced the just-onboarded user back to /onboarding. Onboarding
      // is a one-way flag (no legitimate "un-onboard"), so a true from
      // EITHER source means the user is onboarded.
      onboarded: !!(user?.onboarded) || !!(us.profile.onboarded),
      createdAt: user?.createdAt || null,
    },
    portfolio: us.portfolio,
    holdings: us.holdings,
    transactions: us.transactions,
    transfers: us.transfers,
    inbox: us.inbox,
    coachMessages: us.coachMessages,
    watchlist: us.watchlist,
    friends: us.friends,
    badges: us.badges,
    demo: us.demo,
    settings: _settings,
    isAuthed: !!user,
  };
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(prev) { for (const fn of listeners) fn(getState(), prev); }

// --------------------------------------------------------------------------
export function setState(patch) {
  const prev = getState();
  if (typeof patch === "function") {
    const full = patch(prev);
    applyFullPatch(full, prev);
  } else {
    applyFullPatch(merge(prev, patch), prev);
  }
}

function applyFullPatch(full, prev) {
  if (full.settings) {
    _settings = { ...GLOBAL_SETTINGS_DEFAULTS, ..._settings, ...full.settings };
    writeSettings(_settings);
  }
  if (_activeUserId && _userState) {
    _userState = {
      version: VERSION,
      portfolio: full.portfolio ?? _userState.portfolio,
      holdings: full.holdings ?? _userState.holdings,
      transactions: full.transactions ?? _userState.transactions,
      transfers: full.transfers ?? _userState.transfers,
      inbox: full.inbox ?? _userState.inbox,
      coachMessages: full.coachMessages ?? _userState.coachMessages,
      watchlist: full.watchlist ?? _userState.watchlist,
      friends: full.friends ?? _userState.friends,
      badges: full.badges ?? _userState.badges,
      profile: {
        riskProfile: full.user?.riskProfile ?? _userState.profile.riskProfile,
        school: full.user?.school ?? _userState.profile.school,
        classCode: full.user?.classCode ?? _userState.profile.classCode,
        age: full.user?.age ?? _userState.profile.age,
        onboarded: full.user?.onboarded ?? _userState.profile.onboarded,
      },
      demo: full.demo ?? _userState.demo,
    };
    writeUserState(_activeUserId, _userState);
  }
  emit(prev);
}

export function setSetting(key, value) {
  _settings = { ..._settings, [key]: value };
  writeSettings(_settings);
  emit(getState());
}
export function setSettings(patch) {
  _settings = { ..._settings, ...patch };
  writeSettings(_settings);
  emit(getState());
}

export function switchUser() {
  _activeUserId = null;
  _userState = null;
  ensureUserLoaded();
  emit(getState());
}

// ---- profile mutations (DB-backed via auth/accounts.js:updateProfile) ----
import { updateProfile, patchCachedUser } from "./auth/accounts.js";

export function completeOnboarding({ age, school, classCode, riskProfile }) {
  // Update local state IMMEDIATELY so any route that checks `onboarded`
  // (e.g. the portfolio route guard) sees true right away — otherwise a
  // slow Supabase write can make navigate("/portfolio") bounce back to
  // /onboarding (which resets step → 0 and the user sees "step 1" again).
  setState(s => ({
    ...s,
    user: { ...s.user, age, school, classCode, riskProfile, onboarded: true },
  }));
  // Hotfix41: ALSO patch the auth-layer's _cachedUser. Without this,
  // getState() at line ~180 does `user?.onboarded ?? us.profile.onboarded`
  // — and `??` returns the auth layer's stale `false` over the local
  // truth. Router then bounces to /onboarding even though local state
  // says onboarded=true. The setter mutates _cachedUser in place so the
  // very next currentUser() returns onboarded=true.
  patchCachedUser({ age, school, classCode, riskProfile, onboarded: true });
  // Fire the DB write in the background. Errors get logged but never block
  // the UI. On next login the server row is fetched fresh, so a transient
  // failure here just means the write retries naturally next session.
  updateProfile({ age, school, classCode, riskProfile, onboarded: true })
    .catch(e => console.warn("onboarding profile update failed:", e));
}

export function recordCoachMessage(msg) {
  const enriched = { ...msg, id: msg.id || genId(), ts: msg.ts || Date.now() };
  setState(s => ({ ...s, coachMessages: [...s.coachMessages, enriched] }));
  // Fire-and-forget DB write
  dbAddCoachMessage(enriched).catch(() => {});
}

export function addToWatchlist(symbol) {
  setState(s => ({ ...s, watchlist: s.watchlist.includes(symbol) ? s.watchlist : [...s.watchlist, symbol] }));
  dbAddWatchlist(symbol).catch(() => {});
}
export function removeFromWatchlist(symbol) {
  setState(s => ({ ...s, watchlist: s.watchlist.filter(x => x !== symbol) }));
  dbRemoveWatchlist(symbol).catch(() => {});
}

export function genId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---- Trades — DB-backed if available, else local --------------------------
export async function applyTrade({ symbol, side, qty, pricePaise, biasFlags = [], idempotencyKey }) {
  const valuePaise = Math.round(qty * pricePaise);
  const s = getState();
  if (!s.isAuthed) throw new Error("Please log in to trade.");

  // Idempotency: check local cache
  if (idempotencyKey) {
    const existing = s.transactions.find(t => t.idempotencyKey === idempotencyKey);
    if (existing) return existing;
  }

  const client = await sb();
  if (client) {
    // ---- Supabase mode: the DB is the ledger, full stop. ------------------
    // This block always returns or throws; it never falls through to the
    // local path below. Previously an auth-shaped RPC failure was swallowed
    // and the trade was written to local state only — the user saw a filled
    // trade, the DB had no row, and the next loadAllFromDb() erased it. That
    // is the real origin of the "my data disappeared after a deploy"
    // reports. An offline-trading affordance is not worth a ledger that
    // disagrees with the server.
    let hasSession = false;
    try {
      const { data } = await client.auth.getSession();
      hasSession = !!data?.session?.access_token;
    } catch { hasSession = false; }

    // No real session but isAuthed said otherwise — the ghost-session bug
    // described in db/sync.js. Clear the phantom cache and send them to
    // /login rather than booking a trade nobody will honour.
    if (!hasSession) {
      await handleSessionLost();
      throw new Error("Your session expired. Please log in again.");
    }

    try {
      await dbApplyTrade({ symbol, side, qty, pricePaise, idempotencyKey, biasFlags });
      const txn = makeLocalTxn({ symbol, side, qty, pricePaise, valuePaise, biasFlags, idempotencyKey });
      applyLocalTradeEffect(txn);
      return txn;
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg === "trade_timeout") {
        throw new Error("Trade took too long — a previous request may still be processing. Wait 30 seconds and try again.");
      }
      if (/not logged in|jwt|auth|permission/i.test(msg)) {
        await handleSessionLost();
        throw new Error("Your session expired. Please log in again.");
      }
      // Real business errors (insufficient cash / holding) bubble up as-is.
      throw e;
    }
  }

  // ---- Local mode only (no Supabase configured at all) -------------------
  // Reached only when sb() returned null, i.e. the legacy localStorage mode
  // documented at the top of this file. Never reached in Supabase mode.
  if (side === "BUY") {
    if (valuePaise > s.portfolio.cashPaise) {
      throw new Error(`Insufficient cash. Need ₹${(valuePaise / 100).toLocaleString("en-IN")}, have ₹${(s.portfolio.cashPaise / 100).toLocaleString("en-IN")}.`);
    }
  } else {
    const h = s.holdings[symbol];
    if (!h || h.qty < qty - 1e-9) {
      throw new Error(`Insufficient quantity to sell. You hold ${h?.qty || 0}.`);
    }
  }
  const txn = makeLocalTxn({ symbol, side, qty, pricePaise, valuePaise, biasFlags, idempotencyKey });
  applyLocalTradeEffect(txn);
  return txn;
}

function makeLocalTxn({ symbol, side, qty, pricePaise, valuePaise, biasFlags, idempotencyKey }) {
  return {
    id: genId(),
    idempotencyKey: idempotencyKey || genId(),
    ts: Date.now(),
    symbol, side, qty, pricePaise, valuePaise, biasFlags,
  };
}

function applyLocalTradeEffect(txn) {
  setState(state => {
    const { symbol, side, qty, pricePaise, valuePaise } = txn;
    const cur = state.holdings[symbol];
    let nextHoldings;
    if (side === "BUY") {
      const newQty = (cur?.qty || 0) + qty;
      // Compute avg cost without cumulative rounding: carry avgCostRaw (float)
      // so 20 DCA buys don't drift the average by whole paise. Display still
      // rounds, but the stored basis stays precise.
      const prevAvgRaw = cur?.avgCostRaw ?? cur?.avgCostPaise ?? 0;
      const prevQty = cur?.qty || 0;
      const rawAvg = newQty > 0
        ? (prevAvgRaw * prevQty + qty * pricePaise) / newQty
        : pricePaise;
      nextHoldings = {
        ...state.holdings,
        [symbol]: {
          qty: newQty,
          avgCostPaise: Math.round(rawAvg),
          avgCostRaw: rawAvg,
          firstBoughtAt: cur?.firstBoughtAt || Date.now(),
        },
      };
    } else {
      const remainingQty = cur.qty - qty;
      if (remainingQty <= 1e-9) {
        const { [symbol]: _, ...rest } = state.holdings;
        nextHoldings = rest;
      } else {
        // Keep avgCostPaise + avgCostRaw on partial sells — cost basis per
        // share is unchanged by selling any amount.
        nextHoldings = { ...state.holdings, [symbol]: { ...cur, qty: remainingQty } };
      }
    }
    const cashDelta = side === "BUY" ? -valuePaise : +valuePaise;
    return {
      ...state,
      portfolio: { ...state.portfolio, cashPaise: state.portfolio.cashPaise + cashDelta },
      holdings: nextHoldings,
      transactions: [...state.transactions, txn],
      demo: { ...state.demo, firstTradeDone: true },
    };
  });
}

// --- Derived selectors ----------------------------------------------------
import { getPriceAt } from "./data/prices.js";
// Hotfix57a: pull live /api/live-quote prices from the marketData cache
// FIRST, then fall back to getPriceAt. Without this, every caller of
// getHoldingsValue (report card "your portfolio is worth ₹X" displays,
// admin dashboard, coach payload) was reading the seeded stub-walk
// instead of the real Yahoo price for any Tier-2 equity (Tier-2 rows
// leave inst.price=null because the real price comes from /api/live-
// quote into _quoteCache). State derived stays stub-walk for the
// (rare) case where the quote cache hasn't seen the symbol yet, which
// is still better than 0 — and for MFs getPriceAt now correctly uses
// inst.nav directly per the same hotfix.
import { getCachedQuotes } from "./data/marketData.js";

// Best-known current price in paise. Order of preference:
//   1. _quoteCache via getCachedQuotes — populated by /api/live-quote
//      polling on portfolio / stocks / stock detail pages, lasts up to
//      PERSIST_MAX_AGE_MS in localStorage too.
//   2. getPriceAt(sym, 0) — for MFs returns inst.nav*100 directly; for
//      equities/ETFs falls through to the seeded stub-walk only when
//      no live quote has been observed yet (genuine cold first paint).
function _bestKnownPxPaise(sym) {
  const cached = getCachedQuotes([sym])[sym];
  // Hotfix66b: skip cached entries flagged stale during market hours.
  // localStorage hydration force-flags every persisted quote stale (in
  // marketData.loadPersistedQuotes), so a hard reload during market
  // hours can otherwise feed 48-hour-old prices into portfolio totals
  // until the first /api/live-quote tick lands. User's mum reported
  // ₹5-20 drift vs Groww — this is one of the contributing leaks. MFs
  // are exempt (NAV is daily, "stale" is meaningless for them).
  if (cached && Number.isFinite(cached.pricePaise) && cached.pricePaise > 0
      && !(cached.stale && !sym.startsWith("MF_"))) {
    return cached.pricePaise;
  }
  const px = getPriceAt(sym, 0);
  return Number.isFinite(px) ? px : null;
}

export function getHoldingsValue(state = getState()) {
  let total = 0;
  for (const [sym, h] of Object.entries(state.holdings)) {
    const px = _bestKnownPxPaise(sym);
    // Number.isFinite catches NaN (which `!= null` does not). A Tier-2
    // holding with no price source must contribute 0, not NaN-poison the
    // entire portfolio total — that would break the hero card with "₹NaN".
    if (Number.isFinite(px)) total += Math.round(h.qty * px);
  }
  return total;
}
export function getPortfolioValue(state = getState()) {
  return state.portfolio.cashPaise + getHoldingsValue(state);
}
export function getPortfolioReturnPct(state = getState()) {
  const total = getPortfolioValue(state);
  const start = state.portfolio.startingCashPaise;
  return start ? (total - start) / start : 0;
}
export function getHoldingPLPaise(symbol, state = getState()) {
  const h = state.holdings[symbol];
  if (!h) return 0;
  const curPx = _bestKnownPxPaise(symbol);
  // Guard against NaN/undefined from Tier-2 stubs with no price source —
  // otherwise this would propagate NaN into portfolio totals via callers.
  if (!Number.isFinite(curPx)) return 0;
  return Math.round((curPx - h.avgCostPaise) * h.qty);
}
export function getHoldingPLPct(symbol, state = getState()) {
  const h = state.holdings[symbol];
  if (!h) return 0;
  const curPx = _bestKnownPxPaise(symbol);
  // Guard against (a) missing current price, (b) zero avg cost (free grants).
  // Capping at +999% / -100% keeps UI sort stable; pure Infinity was
  // breaking sorts and rendering "Infinity%".
  if (!curPx) return 0;
  const avg = h.avgCostPaise || 0;
  if (avg <= 0) return curPx > 0 ? 9.99 : 0;
  const pct = (curPx - avg) / avg;
  if (!Number.isFinite(pct)) return 0;
  return Math.max(-1, Math.min(9.99, pct));
}

export function resetCurrentPortfolio() {
  setState(s => ({
    ...s,
    portfolio: { cashPaise: STARTING_CASH_PAISE, startingCashPaise: STARTING_CASH_PAISE },
    holdings: {}, transactions: [], transfers: [], inbox: [],
    coachMessages: [],
    demo: { crashReplayCompleted: [], firstTradeDone: false },
  }));
}

// Multi-tab safety: only adopt another tab's state if it was persisted LATER
// than ours. Prevents Tab A clobbering Tab B's in-flight trade after a rapid
// A→B→A ping-pong. Ties favour the incoming value (slight bias toward the
// most-recently active tab).
window.addEventListener("storage", (e) => {
  if (!e.key) return;
  if (e.key === GLOBAL_SETTINGS_KEY) {
    _settings = readSettings();
    emit(getState());
    return;
  }
  if (_activeUserId && e.key === keyFor(_activeUserId)) {
    const incoming = readUserState(_activeUserId);
    if (!incoming) return;
    const ourTs = _userState?._persistedAt || 0;
    const theirTs = incoming._persistedAt || 0;
    if (theirTs < ourTs - 50) return; // we're newer, ignore
    _userState = incoming;
    emit(getState());
  }
});
