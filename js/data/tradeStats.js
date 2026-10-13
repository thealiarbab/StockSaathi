// =============================================================================
// TRADE STATS — one walk over the ledger that every win/loss number reads.
//
// The report card, the coach dossier, the trade-history tool and the
// disposition detector each had their own maths, and they disagreed:
//   - the report card counted EVERY SELL as a win or loss, so selling one
//     position in three parts was three wins;
//   - "average hold days" ran from the FIRST EVER buy of a symbol, never reset
//     when a position was closed and reopened;
//   - the disposition check called a sell a "winner" when the price had risen
//     AFTER the sale (current price vs sell price), not when the sale beat the
//     user's cost.
// Now: a running average cost per symbol (the same rounding the dossier and
// get_trade_history always used, so realised P&L is unchanged), and ROUND
// TRIPS: a position opens when its quantity goes from 0 to above 0 and closes
// when it returns to 0. A closed round trip is a win if its realised P&L is
// above zero, a loss if below.
//
// Pure: takes transactions ({ts, symbol, side, qty, pricePaise, id}), returns
// numbers. No imports, so scripts/test-coach-guards.mjs can load it in Node.
// =============================================================================

const DAY_MS = 86_400_000;
const EPS = 1e-9;

export function computeTradeStats(transactions = []) {
  const book = {};          // symbol -> { qty, avg, open: roundTrip|null }
  const sells = [];         // per SELL: { id, ts, symbol, qty, pricePaise, avgCostPaise, plPaise, winner }
  const roundTrips = [];    // closed: { symbol, openTs, closeTs, plPaise, holdDays }
  let realisedPaise = 0;

  const oldestFirst = transactions.slice().sort((a, b) => a.ts - b.ts);
  for (const t of oldestFirst) {
    const qty = Number(t.qty) || 0;
    const px = Number(t.pricePaise) || 0;
    if (!t.symbol || qty <= 0) continue;
    const b = book[t.symbol] || (book[t.symbol] = { qty: 0, avg: 0, open: null });
    if (t.side === "BUY") {
      if (b.qty <= EPS) b.open = { symbol: t.symbol, openTs: t.ts, plPaise: 0 };
      const newQty = b.qty + qty;
      b.avg = newQty > 0 ? Math.round((b.avg * b.qty + px * qty) / newQty) : px;
      b.qty = newQty;
    } else if (t.side === "SELL") {
      if (b.qty <= EPS) continue;          // nothing on the book to close
      const closing = Math.min(qty, b.qty);
      const pl = Math.round((px - b.avg) * closing);
      realisedPaise += pl;
      sells.push({ id: t.id, ts: t.ts, symbol: t.symbol, qty: closing, pricePaise: px, avgCostPaise: b.avg, plPaise: pl, winner: pl > 0 });
      if (b.open) b.open.plPaise += pl;
      b.qty = b.qty - closing;
      if (b.qty <= EPS) {
        b.qty = 0;
        if (b.open) {
          roundTrips.push({ ...b.open, closeTs: t.ts, holdDays: (t.ts - b.open.openTs) / DAY_MS });
          b.open = null;
        }
      }
    }
  }

  const wins = roundTrips.filter((r) => r.plPaise > 0);
  const losses = roundTrips.filter((r) => r.plPaise < 0);
  return {
    realisedPaise,
    sells,
    roundTrips,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length + losses.length ? wins.length / (wins.length + losses.length) : 0,
    biggestWinPaise: wins.reduce((m, r) => Math.max(m, r.plPaise), 0),
    biggestLossPaise: losses.reduce((m, r) => Math.max(m, -r.plPaise), 0),
    avgHoldDays: roundTrips.length ? roundTrips.reduce((s, r) => s + r.holdDays, 0) / roundTrips.length : 0,
    // Open positions as the ledger sees them (avg cost per symbol).
    openPositions: Object.fromEntries(Object.entries(book).filter(([, b]) => b.qty > EPS).map(([s, b]) => [s, { qty: b.qty, avgCostPaise: b.avg }])),
  };
}
