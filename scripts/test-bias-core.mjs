// scripts/test-bias-core.mjs — the behaviour detectors (js/coach/biasCore.js)
// against the cases that broke the old ones, and the note copy for every
// detector in both languages.
//
// The old detectors were measured against the 7,139 real trades on 24 Oct
// (a temporary replay on the database): of the 62 sells the old panic check
// would have paused, the ones checked were sales at a PROFIT (GUJSTATFIN,
// AAATECH: it compared the last close, not the sale price, with the cost),
// 1-share trims of 12-share positions (3BBLACKBIO), and TRENT, where Yahoo's
// split-adjusted history made a 4,239 sale look like a fall from 2,834.
// Every case below is one of those, written as data.
//
// Run:  node scripts/test-bias-core.mjs
import * as core from "../js/coach/biasCore.js";
import { biasCopy, BIAS_COPY } from "../js/coach/biasCopy.js";

const DAY = 86_400_000;
const OPEN = Date.UTC(2026, 9, 1, 3, 45);   // 09:15 IST, 1 Oct 2026
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL", name, extra); } };

// Daily bars: n sessions of small noise around `base` (paise), then `tail` closes.
function bars(n, base, tail = [], noise = 0.01, start = OPEN) {
  const out = [];
  let px = base, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let i = 0; i < n; i++) { px = Math.round(base * (1 + noise * rnd())); out.push({ t: start + i * DAY, o: px, h: px, l: px, c: px }); }
  tail.forEach((c, k) => out.push({ t: start + (n + k) * DAY, o: c, h: c, l: c, c }));
  return out;
}
const lastT = (b) => b[b.length - 1].t;
const afterClose = (b) => lastT(b) + DAY - 30 * 60_000;      // next morning, before the open
const sell = (sym, qty, px, at) => ({ symbol: sym, side: "SELL", qty, pricePaise: px, at });
const buy = (sym, qty, px, at) => ({ symbol: sym, side: "BUY", qty, pricePaise: px, at });
const ctx = (o) => ({ kind: "STOCK", sector: "Banking", indexBars: null, history: [], portfolio: { cashPaise: 0, positions: {} }, ...o });

// ---- Panic sell -------------------------------------------------------------------
{
  const b = bars(60, 100000, [100000, 97000, 93000]);          // -7% in 2 sessions, ~1% typical day
  const at = afterClose(b);
  const hb = { qty: 10, avgCostPaise: 100000 };
  const r = core.detectPanicSell(ctx({ trade: sell("X", 10, 93000, at), bars: b, holdingBefore: hb }));
  ok("panic: whole position at a loss after an unusual fall", r && r.severity >= core.NOTE_THRESHOLD, JSON.stringify(r));
  ok("panic: evidence is the real fall", r && r.evidence.drop_pct === -7 && r.evidence.sold_pct === 100);

  ok("panic: sale at a PROFIT after a dip is not panic (GUJSTATFIN)",
    core.detectPanicSell(ctx({ trade: sell("X", 10, 93000, at), bars: b, holdingBefore: { qty: 10, avgCostPaise: 90000 } })) === null);
  ok("panic: a 1-of-12 trim is not panic (3BBLACKBIO)",
    core.detectPanicSell(ctx({ trade: sell("X", 1, 93000, at), bars: b, holdingBefore: { qty: 12, avgCostPaise: 100000 } })) === null);

  const jumpy = bars(60, 100000, [100000, 97000, 93000], 0.06);   // a stock that swings ~6% a day
  ok("panic: the same fall on a jumpy stock is noise",
    core.detectPanicSell(ctx({ trade: sell("X", 10, 93000, afterClose(jumpy)), bars: jumpy, holdingBefore: hb })) === null);

  const split = bars(60, 280000, [283000, 283400]);               // history adjusted after a split
  ok("panic: trade price 50% away from the bars is a data mismatch (TRENT)",
    core.detectPanicSell(ctx({ trade: sell("X", 5, 423900, afterClose(split)), bars: split, holdingBefore: { qty: 5, avgCostPaise: 500000 } })) === null);

  ok("panic: mutual funds are never panic",
    core.detectPanicSell(ctx({ kind: "MF", trade: sell("MF_1", 10, 93000, at), bars: b, holdingBefore: hb })) === null);

  // A sale DURING today's session must not use today's unfinished bar as "the last close".
  const live = bars(60, 100000, [100000, 100000, 93000]);
  const midSession = lastT(live) + 2 * 3_600_000;               // 11:15 IST, the 93000 bar is today's
  const r2 = core.detectPanicSell(ctx({ trade: sell("X", 10, 93000, midSession), bars: live, holdingBefore: hb }));
  ok("panic: intraday sale judged against yesterday's close", r2 && r2.evidence.drop_sessions === 1 && r2.evidence.drop_pct === -7, JSON.stringify(r2?.evidence));

  // Held over a year: not a panic reaction.
  const hist = [{ symbol: "X", side: "BUY", qty: 10, pricePaise: 100000, ts: at - 400 * DAY }];
  ok("panic: held 400 days is not panic",
    core.detectPanicSell(ctx({ trade: sell("X", 10, 93000, at), bars: b, holdingBefore: hb, history: hist })) === null);

  ok("panic: no real history, no verdict",
    core.detectPanicSell(ctx({ trade: sell("X", 10, 93000, at), bars: null, holdingBefore: hb })) === null);
}

// ---- FOMO and pump chase ----------------------------------------------------------
{
  const run = bars(60, 100000, [100000, 104000, 108000, 113000, 118000, 124000]);
  const at = afterClose(run);
  const f = core.detectFOMO(ctx({ trade: buy("X", 5, 125000, at), bars: run }));
  ok("fomo: new position after a 25% run on a calm stock", f && f.evidence.run_up_pct >= 24 && f.evidence.run_up_pct <= 27, JSON.stringify(f?.evidence));
  ok("fomo: adding to a real position is not FOMO",
    core.detectFOMO(ctx({ trade: buy("X", 1, 125000, at), bars: run, holdingBefore: { qty: 20, avgCostPaise: 100000 } })) === null);
  const calm = bars(60, 100000, [100000, 101000, 103000]);
  ok("fomo: a 3% drift is not a run-up", core.detectFOMO(ctx({ trade: buy("X", 5, 103000, afterClose(calm)), bars: calm })) === null);

  const flat = bars(60, 100000, [100000]);
  const p = core.detectPumpChase(ctx({ trade: buy("X", 5, 108000, afterClose(flat)), bars: flat }));
  ok("pump: buying 8% up on the day", p && p.evidence.intraday_gain_pct === 8);
  ok("pump: 3% up is a normal day", core.detectPumpChase(ctx({ trade: buy("X", 5, 103000, afterClose(flat)), bars: flat })) === null);
  ok("pump: a 450% 'gain' is bad data, not a pump (KEL)",
    core.detectPumpChase(ctx({ trade: buy("X", 5, 565000, afterClose(flat)), bars: flat })) === null);

  const both = core.evaluateTrade(ctx({ trade: buy("X", 5, 135000, afterClose(run)), bars: run }));
  ok("pump + fomo on one buy: one story, not two", both.filter((r) => r.bias === "fomo" || r.bias === "pump_chase").length === 1, JSON.stringify(both.map((r) => r.bias)));
}

// ---- Averaging down (anchoring) ---------------------------------------------------
{
  const b = bars(60, 80000, [80000]);
  const at = afterClose(b);
  const a = core.detectAnchoring(ctx({ trade: buy("X", 5, 80000, at), bars: b, holdingBefore: { qty: 5, avgCostPaise: 100000 } }));
  ok("anchoring: adding 20% below cost", a && a.evidence.below_cost_pct === -20);
  ok("anchoring: adding near cost is fine",
    core.detectAnchoring(ctx({ trade: buy("X", 5, 97000, at), bars: b, holdingBefore: { qty: 5, avgCostPaise: 100000 } })) === null);
  ok("anchoring: a first buy near the 52-week high is not a bias any more",
    core.detectAnchoring(ctx({ trade: buy("X", 5, 80000, at), bars: b, holdingBefore: null })) === null);
}

// ---- Concentration and sector -----------------------------------------------------
{
  const t = OPEN;
  const pos = (qty, px, sector = "Banking", kind = "STOCK") => ({ qty, avgCostPaise: px, pricePaise: px, sector, kind });
  const c = core.detectConcentration(ctx({ trade: buy("A", 50, 1000, t), portfolio: { cashPaise: 50000, positions: { A: pos(50, 1000) } } }));
  ok("concentration: the buy that takes one stock to 50%", c && c.evidence.concentration_pct === 50);
  ok("concentration: a small top-up of an already big position stays quiet",
    core.detectConcentration(ctx({ trade: buy("A", 1, 1000, t), portfolio: { cashPaise: 40000, positions: { A: pos(60, 1000) } } })) === null);
  ok("concentration: a SELL never warns about concentration",
    core.detectConcentration(ctx({ trade: sell("A", 1, 1000, t), portfolio: { cashPaise: 0, positions: { A: pos(60, 1000) } } })) === null);
  ok("concentration: an index ETF is a basket",
    core.detectConcentration(ctx({ kind: "ETF", trade: buy("N", 50, 1000, t), portfolio: { cashPaise: 50000, positions: { N: pos(50, 1000, "Index", "ETF") } } })) === null);

  const s = core.detectSectorBias(ctx({ trade: buy("B", 30, 1000, t), sector: "Banking",
    portfolio: { cashPaise: 20000, positions: { A: pos(30, 1000), B: pos(30, 1000), C: pos(10, 1000, "IT") } } }));
  ok("sector: the buy that takes banks past 60% of stocks", s && s.evidence.sector_pct === 85.7 && s.evidence.stocks_in_sector === 2, JSON.stringify(s?.evidence));
  ok("sector: already past 60% before this buy stays quiet",
    core.detectSectorBias(ctx({ trade: buy("B", 1, 1000, t), sector: "Banking",
      portfolio: { cashPaise: 20000, positions: { A: pos(30, 1000), B: pos(31, 1000), C: pos(10, 1000, "IT") } } })) === null);
  ok("sector: 'Other' is not a sector",
    core.detectSectorBias(ctx({ trade: buy("B", 30, 1000, t), sector: "Other",
      portfolio: { cashPaise: 0, positions: { A: pos(30, 1000, "Other"), B: pos(30, 1000, "Other") } } })) === null);
}

// ---- Churning, overtrading, disposition -------------------------------------------
{
  const h = [];
  let ts = OPEN - 20 * DAY;
  for (let i = 0; i < 2; i++) { h.push({ symbol: "X", side: "BUY", qty: 1, pricePaise: 100, ts }); h.push({ symbol: "X", side: "SELL", qty: 1, pricePaise: 100, ts: ts + DAY }); ts += 2 * DAY; }
  h.push({ symbol: "X", side: "BUY", qty: 1, pricePaise: 100, ts });
  const c = core.detectChurning(ctx({ trade: sell("X", 1, 100, ts + DAY), history: h }));
  ok("churning: the sell that completes the 3rd quick round trip", c && c.evidence.round_trips_30d === 3);
  ok("churning: the buy after it is quiet", core.detectChurning(ctx({ trade: buy("X", 1, 100, ts + 2 * DAY), history: [...h, { symbol: "X", side: "SELL", qty: 1, pricePaise: 100, ts: ts + DAY }] })) === null);
  const partial = [{ symbol: "X", side: "BUY", qty: 10, pricePaise: 100, ts: OPEN }, { symbol: "X", side: "SELL", qty: 2, pricePaise: 100, ts: OPEN + 1000 }, { symbol: "X", side: "BUY", qty: 2, pricePaise: 100, ts: OPEN + 2000 }];
  ok("churning: trimming and re-adding is not a round trip", core.detectChurning(ctx({ trade: sell("X", 2, 100, OPEN + 3000), history: partial })) === null);

  const day2 = OPEN + 5 * DAY;
  const earlier = [{ symbol: "Y", side: "BUY", qty: 1, pricePaise: 100, ts: OPEN }];
  const today = (n, auto = false) => Array.from({ length: n }, (_, i) => ({ symbol: "Y", side: "BUY", qty: 1, pricePaise: 100, ts: day2 + i * 60_000, auto }));
  ok("overtrading: the 10th trade of a day", core.detectOvertrading(ctx({ trade: buy("Y", 1, 100, day2 + 3_600_000), history: [...earlier, ...today(9)] }))?.evidence.trades_today === 10);
  ok("overtrading: the 11th is quiet (one note, not one per trade)", core.detectOvertrading(ctx({ trade: buy("Y", 1, 100, day2 + 3_600_000), history: [...earlier, ...today(10)] })) === null);
  ok("overtrading: matcher fills do not count", core.detectOvertrading(ctx({ trade: buy("Y", 1, 100, day2 + 3_600_000), history: [...earlier, ...today(9, true)] })) === null);
  ok("overtrading: never on the first day", core.detectOvertrading(ctx({ trade: buy("Y", 1, 100, OPEN + 3_600_000), history: today(9).map((t) => ({ ...t, ts: t.ts - 5 * DAY })) })) === null);

  const sells = [];
  for (let i = 0; i < 2; i++) { sells.push({ symbol: `W${i}`, side: "BUY", qty: 1, pricePaise: 100, ts: OPEN + i }); sells.push({ symbol: `W${i}`, side: "SELL", qty: 1, pricePaise: 130, ts: OPEN + 10 + i }); }
  const d = core.detectDisposition(ctx({ trade: sell("Z", 1, 130, OPEN + DAY), holdingBefore: { qty: 1, avgCostPaise: 100 }, history: sells,
    portfolio: { cashPaise: 0, positions: { L: { qty: 1, avgCostPaise: 100, pricePaise: 80, kind: "STOCK" } } } }));
  ok("disposition: 3rd winner sold while a loser sits 20% down", d && d.evidence.worst_loser === "L" && d.evidence.winners_sold === 3);
  ok("disposition: no loser held, no pattern", core.detectDisposition(ctx({ trade: sell("Z", 1, 130, OPEN + DAY), holdingBefore: { qty: 1, avgCostPaise: 100 }, history: sells })) === null);
}

// ---- Input guards ---------------------------------------------------------------
ok("guard: a zero price is never judged", core.evaluateTrade(ctx({ trade: buy("X", 1, 0, OPEN) })).length === 0);
ok("guard: an absurd quantity is never judged (BOSCHLTD 999999999999 @ 0)", core.evaluateTrade(ctx({ trade: buy("X", 999999999999, 0, OPEN) })).length === 0);

// ---- Copy: every detector, both languages, no holes -----------------------------
{
  const sample = {
    panic_sell: { symbol: "X", drop_pct: -7.9, drop_sessions: 2, typical_day_pct: 2.4, times_typical: 2.3, pl_pct: -6.3, sold_pct: 100, holding_age_days: 2, nifty_pct: -2.4 },
    fomo: { symbol: "X", run_up_pct: 37.2, sessions: 10, typical_day_pct: 3.3, nifty_pct: null },
    pump_chase: { symbol: "X", intraday_gain_pct: 7.5, typical_day_pct: 1.6 },
    anchoring: { symbol: "X", below_cost_pct: -20, earlier_adds_below_cost: 2 },
    concentration: { symbol: "X", concentration_pct: 62.9 },
    sector_concentration: { top_sector: "Banking", sector_pct: 92.5, stocks_in_sector: 2 },
    disposition: { winners_sold: 7, losers_sold: 0, losers_held: 1, worst_loser: "TATACONSUM", worst_loser_pct: -14.9 },
    churning: { symbol: "X", round_trips_30d: 4 },
    overtrading: { trades_today: 10 },
  };
  ok("copy: one entry per detector", Object.keys(BIAS_COPY).length === core.ALL_DETECTORS.length);
  for (const [bias, evidence] of Object.entries(sample)) {
    for (const hi of [false, true]) {
      const c = biasCopy({ bias, severity: 0.7, evidence }, { name: "ADANIGREEN", hi });
      const text = [c.term, c.note, c.learn, c.body, c.question, ...c.chips].join(" | ");
      ok(`copy ${bias} ${hi ? "hi" : "en"}`, c && !/undefined|NaN|null|\[object/.test(text) && c.chips.length > 0, text);
    }
  }
  ok("copy: panic note quotes the real fall", /7\.9%/.test(biasCopy({ bias: "panic_sell", evidence: sample.panic_sell }, { name: "ADANIGREEN" }).note));
}

console.log(`bias core: ${pass}/${pass + fail} passing`);
if (fail) process.exit(1);
