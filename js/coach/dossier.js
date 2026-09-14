// =============================================================================
// js/coach/dossier.js — the coach's view of who it is talking to.
//
// WHY THIS EXISTS, AND WHY EVERY NUMBER IN IT IS PRE-COMPUTED
//
// docs/COACH_FIXES.md §3 is a CRITICAL defect: asked "what's my total portfolio
// value?", the coach answered
//
//   "Your total portfolio is worth Rs 38,100.00. You started with Rs 42,100.00
//    in cash, so you're currently down Rs 4,000.00."
//
// Every number invented. It had been handed a roster of `quantity @ AVERAGE
// BUY PRICE` and multiplied it as though it were market value. The fix at the
// time was prompt text: label the block as cost basis, and forbid arithmetic
// on it. That is a preference, not a guarantee — and a real user had already
// received Rs 1,04,230 of fabricated portfolio the same way.
//
// This module is the structural version of that fix. Market value sits on the
// same line as cost basis, ALREADY MULTIPLIED, so there is nothing left for
// the model to compute. It cannot get the arithmetic wrong if it never does
// any.
//
// It also closes a plain gap: js/pages/chat.js injected NO portfolio context
// at all, so on the /chat page the coach's only route to the user's own data
// was calling a tool. "It says it can't see my trade history" was literally
// true there.
//
// BUDGET
//
// ~500-900 tokens, every turn. That is affordable: api/chat.js records that
// shrinking the 5,046-token system prompt to 21 tokens bought only ~1s, while
// reasoning_effort moved TTFT from 3.85s to 0.15s. Input tokens are not the
// bottleneck at this scale — and this replaces a 2-4s tool round trip on the
// most common question class, so it is net faster.
//
// What does NOT belong here: anything a tool would fetch on under ~30% of
// turns. Full trade history is ~25 tokens a trade, so 200 trades would be
// 5,000 tokens on EVERY turn to answer a question asked occasionally. That
// stays a tool.
// =============================================================================

import { getState } from "../state.js";
import { getInstrument } from "../data/universe.js";
import { getQuoteBatch } from "../data/marketData.js";

const MAX_POSITIONS_SHOWN = 12;

const inr = (paise) =>
  "₹" + (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const signed = (paise) => (paise >= 0 ? "+" : "−") + inr(Math.abs(paise));

/**
 * Realised P&L per closing SELL, walked oldest-first over a running average
 * cost. Same algorithm as execGetTradeHistory in agent.js — deliberately, so
 * the dossier's "realised to date" can never disagree with what the
 * get_trade_history tool reports for the same trades.
 */
function realisedPaise(transactions) {
  const book = {};
  let total = 0;
  const oldestFirst = transactions.slice().sort((a, b) => a.ts - b.ts);
  for (const t of oldestFirst) {
    const b = book[t.symbol] || { qty: 0, avg: 0 };
    if (t.side === "BUY") {
      const newQty = b.qty + t.qty;
      b.avg = newQty > 0 ? Math.round((b.avg * b.qty + t.pricePaise * t.qty) / newQty) : t.pricePaise;
      b.qty = newQty;
    } else {
      if (b.qty > 0) total += Math.round((t.pricePaise - b.avg) * t.qty);
      b.qty = Math.max(0, b.qty - t.qty);
    }
    book[t.symbol] = b;
  }
  return total;
}

/**
 * True when a holding row is corrupt rather than merely unusual.
 *
 * COACH_FIXES §6: rows with quantity in the billions and zero average cost
 * were narrated to users as free shares. They are audit artifacts. Flag them
 * so the model says "this looks wrong, report it" instead of explaining them.
 */
function isCorrupt(h) {
  return !Number.isFinite(h?.qty) || h.qty > 1e9 || !Number.isFinite(h?.avgCostPaise) || h.avgCostPaise <= 0;
}

/**
 * Build the dossier block. Returns "" when signed out — the coach works
 * signed-out and must not claim to know a user it cannot see.
 */
export async function buildDossier() {
  const s = getState();
  if (!s?.isAuthed) return "";

  const holdings = s.holdings || {};
  const symbols = Object.keys(holdings);
  const txns = Array.isArray(s.transactions) ? s.transactions : [];

  let quotes = {};
  if (symbols.length) {
    // Batched, not a getQuote loop: the single-symbol path goes to /api/quote,
    // the only quote endpoint with no Supabase cache layer.
    try { quotes = (await getQuoteBatch(symbols)) || {}; } catch { quotes = {}; }
  }

  const cash = s.portfolio?.cashPaise ?? 0;
  const started = s.portfolio?.startingCashPaise ?? 0;
  const reserved = s.portfolio?.reservedCashPaise ?? 0;

  const rows = [];
  const corrupt = [];
  let holdingsValue = 0;
  let costBasisTotal = 0;
  let unpriced = 0;

  for (const sym of symbols) {
    const h = holdings[sym];
    if (isCorrupt(h)) { corrupt.push(sym); continue; }
    const q = quotes[sym];
    const last = q && Number.isFinite(q.pricePaise) ? q.pricePaise : null;
    const cost = Math.round(h.avgCostPaise * h.qty);
    costBasisTotal += cost;
    if (last == null) { unpriced++; rows.push({ sym, h, last: null, mkt: null, pl: null, plPct: null }); continue; }
    const mkt = Math.round(last * h.qty);
    holdingsValue += mkt;
    rows.push({ sym, h, last, mkt, pl: mkt - cost, plPct: cost > 0 ? ((mkt - cost) / cost) * 100 : 0 });
  }

  const total = cash + holdingsValue + reserved;
  const priced = rows.filter((r) => r.mkt != null).sort((a, b) => b.mkt - a.mkt);
  const unrealised = priced.reduce((n, r) => n + r.pl, 0);
  const unrealisedPct = costBasisTotal > 0 ? (unrealised / costBasisTotal) * 100 : 0;
  const realised = realisedPaise(txns);
  const vsStart = started > 0 ? total - started : null;
  const vsStartPct = started > 0 ? ((total - started) / started) * 100 : null;

  const best = priced.length ? priced.reduce((a, b) => (b.plPct > a.plPct ? b : a)) : null;
  const worst = priced.length ? priced.reduce((a, b) => (b.plPct < a.plPct ? b : a)) : null;
  const biggest = priced[0] || null;

  const now = new Date().toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
  });

  const L = [];
  L.push(`# USER DOSSIER — authoritative, computed at ${now} IST.`);
  L.push(`# Every figure below is ALREADY CORRECT. Never recompute, multiply, total,`);
  L.push(`# subtract or re-derive anything here. State the numbers as given.`);

  const p = s.profile || {};
  const who = [
    s.username || s.displayName || null,
    Number.isFinite(p.age) ? `${p.age}` : null,
    p.riskProfile ? `risk profile: ${p.riskProfile}` : null,
  ].filter(Boolean).join(", ");
  if (who) L.push(who);

  if (!symbols.length) {
    L.push(`Cash ${inr(cash)}. NO HOLDINGS — this user owns nothing right now.`);
    L.push(`Do not invent positions. If asked what they own, say they have not bought anything yet.`);
  } else {
    L.push(`Cash ${inr(cash)}${reserved > 0 ? ` (${inr(reserved)} reserved by pending orders)` : ""} · Holdings ${inr(holdingsValue)} · TOTAL ${inr(total)}`);
    if (vsStart != null) L.push(`Started ${inr(started)} → ${signed(vsStart)} (${pct(vsStartPct)})`);
    L.push(`Unrealised ${signed(unrealised)} (${pct(unrealisedPct)}) · Realised to date ${signed(realised)}`);

    L.push(`Positions (${priced.length + unpriced}) — qty · avg cost · LAST PRICE · market value · P&L:`);
    for (const r of priced.slice(0, MAX_POSITIONS_SHOWN)) {
      const name = getInstrument(r.sym)?.name || r.sym;
      L.push(`  ${r.sym} ${r.h.qty} · ${inr(r.h.avgCostPaise)} · ${inr(r.last)} · ${inr(r.mkt)} · ${signed(r.pl)} (${pct(r.plPct)})  [${name}]`);
    }
    if (priced.length > MAX_POSITIONS_SHOWN) {
      const restVal = priced.slice(MAX_POSITIONS_SHOWN).reduce((n, r) => n + r.mkt, 0);
      L.push(`  …and ${priced.length - MAX_POSITIONS_SHOWN} smaller positions worth ${inr(restVal)} in total — call get_user_portfolio for the full list.`);
    }
    for (const r of rows.filter((x) => x.mkt == null).slice(0, 4)) {
      L.push(`  ${r.sym} ${r.h.qty} · avg ${inr(r.h.avgCostPaise)} · NO PRICE AVAILABLE — say the price could not be fetched, do not estimate it.`);
    }
    if (biggest && total > 0) {
      L.push(`Biggest position ${biggest.sym} ${((biggest.mkt / total) * 100).toFixed(1)}% of portfolio.` +
        (best ? ` Best ${best.sym} ${pct(best.plPct)}.` : "") +
        (worst && worst !== best ? ` Worst ${worst.sym} ${pct(worst.plPct)}.` : ""));
    }
  }

  if (corrupt.length) {
    L.push(`DATA WARNING: ${corrupt.join(", ")} ${corrupt.length === 1 ? "has an impossible quantity or zero cost. That row is" : "have impossible quantities or zero cost. Those rows are"} CORRUPT, not free shares. Tell the user it looks like a bug on our side and to report it.`);
  }

  // Activity — cheap, and it is what makes "have I traded recently" answerable
  // without a tool call.
  if (txns.length) {
    const now30 = Date.now() - 30 * 86400000;
    const recent = txns.filter((t) => t.ts >= now30).length;
    const last = txns.slice().sort((a, b) => b.ts - a.ts)[0];
    L.push(`Trades ${txns.length} total, ${recent} in the last 30 days. Last: ${last.side} ${last.symbol} on ${new Date(last.ts).toISOString().slice(0, 10)}.`);
  } else {
    L.push(`Trades 0 — this user has NEVER placed a trade. Say exactly that if asked; do not invent one.`);
  }

  const wl = Array.isArray(s.watchlist) ? s.watchlist.length : 0;
  const tf = Array.isArray(s.transfers) ? s.transfers.length : 0;
  const bits = [];
  if (wl) bits.push(`Watchlist ${wl}`);
  if (tf) bits.push(`Transfers ${tf}`);
  if (bits.length) L.push(bits.join(" · ") + ".");

  return L.join("\n");
}
