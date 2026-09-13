// =============================================================================
// COACH TEMPLATES — Deterministic response templates keyed by (event_type, bias).
// These are the PRIMARY coach outputs. Used directly when no LLM is configured.
// An optional user-provided LLM API key in Settings can augment with
// streaming text, but the DEMO path is fully self-contained.
//
// Every template produces the same schema:
//   { reflection, historical_context, warning_level, suggested_q, citations[] }
//
// Language is tuned for a 13-18 year-old Indian audience. SEBI-compliant:
// no "should buy/sell", no predictions, only reflection + cited history.
// =============================================================================

import { formatAnalog } from "./historicalAnalog.js";
import { formatRupees, formatPct } from "../money.js";
import { getInstrument } from "../data/universe.js";

/** Pick a random variant using a stable-ish seed. */
function pick(arr, seed = Date.now()) {
  return arr[Math.abs(seed) % arr.length];
}

// ---- SAFE SMALLTALK / FIRST MOVES ----------------------------------------
const FIRST_TRADE = [
  {
    reflection: "Your first trade is in. Everyone remembers theirs — mine was a panic-buy of a stock I'd never heard of, on a WhatsApp forward. You're already ahead.",
    suggested_q: "What drew you to this choice — story, price, name, or numbers?",
  },
  {
    reflection: "First trade, locked in. This is a simulator — the best mistakes you'll ever make will happen here, not with real money.",
    suggested_q: "If this trade goes 10% against you next week, what will you do?",
  },
];

const NORMAL_BUY = [
  (tick) => ({
    reflection: `Noted — ${tick.qty} unit${tick.qty === 1 ? "" : "s"} of ${tick.name} at ${formatRupees(tick.pricePaise)}. Position averaging starts here.`,
    suggested_q: "Is this position meant to be held for weeks, months, or years? Answer now — future-you will drift.",
  }),
  (tick) => ({
    reflection: `Bought ${tick.name}. The research shows beginners who write down WHY they bought outperform those who don't — by a lot.`,
    suggested_q: "In one sentence: what's the thesis?",
  }),
];

const NORMAL_SELL = [
  (tick) => ({
    reflection: `Sold ${tick.qty} ${tick.name} at ${formatRupees(tick.pricePaise)}. ${tick.plPct >= 0 ? "Profit booked." : "Loss realised."}`,
    suggested_q: tick.plPct >= 0
      ? "You'll be tempted to buy this back if it goes up more. Will you? Why?"
      : "Was this sell driven by the thesis changing, or by the price moving?",
  }),
];

// ---- BIAS-SPECIFIC REFLECTIONS ------------------------------------------
// These are structured to CITE real data from detector evidence + analog lookup.

const PANIC_SELL_VARIANTS = [
  (tick) => ({
    reflection: `You just sold ${tick.name} ${tick.dropText}. That's a pattern worth pausing on.`,
    historical_context: tick.analogText,
    warning_level: tick.severity >= 0.7 ? "strong_caution" : "caution",
    suggested_q: "What's different about today's drop that convinced you recovery won't come?",
  }),
  (tick) => ({
    reflection: `Panic-selling doesn't feel like panic in the moment — it feels like "being responsible". But the data on short-term drops tells a consistent story.`,
    historical_context: tick.analogText,
    warning_level: tick.severity >= 0.7 ? "strong_caution" : "caution",
    suggested_q: "If you had to wait 3 months before selling, what would you do differently today?",
  }),
];

const PUMP_CHASE_VARIANTS = [
  (tick) => ({
    reflection: `${tick.name} is up ${tick.intradayGain}% today — and you just bought into that spike. Chasing a fast-moving stock is one of the most expensive habits new investors have.`,
    historical_context: tick.analogText,
    warning_level: "caution",
    suggested_q: "Would you have bought this yesterday at a 5% lower price?",
  }),
];

const FOMO_VARIANTS = [
  (tick) => ({
    reflection: `${tick.name} is up ${tick.runUp}% in the last week. Buying after a fast run-up works about a third of the time — and fails spectacularly the other two-thirds.`,
    historical_context: null,
    warning_level: "caution",
    suggested_q: "Would you still want this stock if it had not rallied recently?",
  }),
];

const CONCENTRATION_VARIANTS = [
  (tick) => ({
    reflection: `Your ${tick.name} position is now ${tick.concentration}% of your entire portfolio. Not wrong — just worth noticing. Single-stock concentration is how both biggest wins and biggest losses happen.`,
    historical_context: null,
    warning_level: "info",
    suggested_q: `If ${(tick.name || "").split(" ")[0] || "this stock"} fell 30% overnight, how would you feel?`,
  }),
];

const SECTOR_CONCENTRATION_VARIANTS = [
  (tick) => ({
    reflection: `Your portfolio is ${tick.sectorPct}% in ${tick.sector}. When a sector rallies, you'll do great. When it corrects — every holding moves together.`,
    historical_context: null,
    warning_level: "info",
    suggested_q: `What's your exit plan if ${tick.sector} has a rough quarter?`,
  }),
];

const ANCHORING_VARIANTS = [
  (tick) => ({
    reflection: `You bought ${tick.name} within 2% of its ${tick.anchor === "52w_high" ? "52-week high" : "52-week low"}. Prices near extreme points carry extreme expectations — in both directions.`,
    historical_context: null,
    warning_level: "info",
    suggested_q: "Are you buying because of this price level, or despite it?",
  }),
];

const DISPOSITION_VARIANTS = [
  (tick) => ({
    reflection: `In the last 30 days you've sold ${tick.winnersSold} winning positions and held ${tick.losersSold || "most"} losing ones. This is the most documented pattern in retail investing — "sell the winners, hold the losers".`,
    historical_context: null,
    warning_level: "caution",
    suggested_q: "If you'd flipped those decisions — sold losers, held winners — how would your portfolio look today?",
  }),
];

const CHURNING_VARIANTS = [
  (tick) => ({
    reflection: `You've flipped ${tick.name} ${tick.rounds} times this month. Every round-trip has a cost — in real markets it's brokerage and taxes; here it's decision fatigue.`,
    historical_context: null,
    warning_level: "caution",
    suggested_q: "What are you actually learning each time you re-enter?",
  }),
];

const OVERTRADING_VARIANTS = [
  (tick) => ({
    reflection: `${tick.count} trades in the last 24 hours. Very few strategies require more than 1-2 decisions a day. More activity ≠ more returns.`,
    historical_context: null,
    warning_level: "caution",
    suggested_q: "What would happen if you didn't trade for the next 7 days?",
  }),
];

// ---- PORTFOLIO / MACRO EVENTS -------------------------------------------
const PORTFOLIO_DIP_5PCT = [
  (tick) => ({
    reflection: `Your portfolio is down ${tick.dipPct}% over the past few sessions. A 5% drop feels big when you're watching it live. For context: the Nifty has had 48 such moves in the last 10 years — and each one recovered.`,
    historical_context: "48 dips ≥5% in 10 years of Nifty data; median recovery: 22 trading days.",
    warning_level: "info",
    suggested_q: "If you stopped checking for 2 weeks, what decision could you make better?",
  }),
];

const CRASH_SIMULATION_START = [
  (tick) => ({
    reflection: `Time travel started. You're going to watch a real market crash play out across ${tick.days} days. The goal isn't to 'win' — it's to feel what it felt like, without paying for it.`,
    suggested_q: "At what drawdown would you start to panic in real life? Write down a number.",
  }),
];

const CRASH_SIMULATION_END = [
  (tick) => ({
    reflection: tick.heldBeat
      ? `Holding outperformed panic-selling by ${tick.delta}% in this scenario. That is NOT universally true — sometimes the panic call is right. But it's true far more often than people think.`
      : `In this specific window, the panic-seller actually outperformed by ${Math.abs(tick.delta)}%. This is the exception worth remembering: not every dip recovers fast. Context matters.`,
    historical_context: `${tick.crashTitle}: index ${tick.indexDrop}%, recovery ${tick.recoveryDays} trading days.`,
    warning_level: "info",
    suggested_q: "What's one rule you'd set for yourself before the next real-world dip?",
  }),
];

// ---- STOCK INTRO (first visit) -------------------------------------------
// A fund is not a company and has no P/E. Feeding an ETF or a mutual fund
// through the equity copy produced lines like "ANGEL ONE GOLD ETF is a
// Commodity company. P/E is —, which means investors are paying ₹— for
// every ₹1 of annual earnings." — 54 of those reached users before this
// branch existed. Likewise, an equity with no P/E on file must simply drop
// the valuation sentence rather than render an em-dash where a number goes.
const STOCK_INTRO = [
  (tick) => {
    const inst = tick.instrument || {};
    const name = inst.name || inst.symbol || "This instrument";
    const isFund = inst.kind === "MF" || inst.kind === "ETF";
    const sector = inst.sector && inst.sector !== "Unknown" && inst.sector !== "Other"
      ? inst.sector : null;

    if (isFund) {
      const label = inst.kind === "ETF" ? "an ETF" : "a mutual fund";
      const theme = sector ? ` tracking the ${sector} theme` : "";
      return {
        reflection: `${name} is ${label}${theme} — a basket, not a single company. You buy units at its NAV, so one purchase spreads your money across everything the fund holds. That smooths out any single stock blowing up, and it equally caps how much one winner can do for you. Funds have no P/E of their own; what matters is what's inside, and the expense ratio you pay each year to hold it.`,
        suggested_q: "What's actually inside this fund — and what does it charge you per year to hold it?",
      };
    }

    // "a IT company" reads badly; pick the article from the leading sound.
    const article = /^[aeiou]/i.test(sector || "") || /^(?:FMCG|IT|NBFC|PSU)\b/.test(sector || "") ? "an" : "a";
    const sectorClause = sector ? ` is ${article} ${sector} company.` : ` is a listed Indian company.`;
    const pe = Number(inst.pe);
    const hasPe = Number.isFinite(pe) && pe > 0;
    const peClause = hasPe
      ? ` P/E is ${pe}, which means investors are paying ₹${pe} for every ₹1 of annual earnings. A P/E of 25 is average for Indian large-caps; >50 usually implies investors expect fast growth.`
      : ` We don't have a P/E on file for it right now — that usually means the company isn't profitable, or the data hasn't landed yet. Either way, valuation is worth checking before the price is.`;
    return {
      reflection: `${name}${sectorClause}${peClause}`,
      suggested_q: "Before buying anything, ask: why would the earnings grow from here?",
    };
  },
];

// ---- EVENT TYPE → SELECTOR TABLE ----------------------------------------
const TEMPLATE_MAP = {
  // With triggered biases
  SELL_panic_sell: (ctx) => pick(PANIC_SELL_VARIANTS, ctx.seed)(ctx.tick),
  BUY_pump_chase: (ctx) => pick(PUMP_CHASE_VARIANTS, ctx.seed)(ctx.tick),
  BUY_fomo: (ctx) => pick(FOMO_VARIANTS, ctx.seed)(ctx.tick),
  BUY_anchoring: (ctx) => pick(ANCHORING_VARIANTS, ctx.seed)(ctx.tick),
  BUY_concentration: (ctx) => pick(CONCENTRATION_VARIANTS, ctx.seed)(ctx.tick),
  BUY_sector_concentration: (ctx) => pick(SECTOR_CONCENTRATION_VARIANTS, ctx.seed)(ctx.tick),
  SELL_disposition: (ctx) => pick(DISPOSITION_VARIANTS, ctx.seed)(ctx.tick),
  BUY_churning: (ctx) => pick(CHURNING_VARIANTS, ctx.seed)(ctx.tick),
  SELL_churning: (ctx) => pick(CHURNING_VARIANTS, ctx.seed)(ctx.tick),
  BUY_overtrading: (ctx) => pick(OVERTRADING_VARIANTS, ctx.seed)(ctx.tick),
  SELL_overtrading: (ctx) => pick(OVERTRADING_VARIANTS, ctx.seed)(ctx.tick),

  // Neutral events (no bias)
  FIRST_TRADE: (ctx) => pick(FIRST_TRADE, ctx.seed),
  BUY: (ctx) => pick(NORMAL_BUY, ctx.seed)(ctx.tick),
  SELL: (ctx) => pick(NORMAL_SELL, ctx.seed)(ctx.tick),

  STOCK_INTRO: (ctx) => pick(STOCK_INTRO, ctx.seed)(ctx.tick),
  PORTFOLIO_DIP_5PCT: (ctx) => pick(PORTFOLIO_DIP_5PCT, ctx.seed)(ctx.tick),

  CRASH_SIMULATION_START: (ctx) => pick(CRASH_SIMULATION_START, ctx.seed)(ctx.tick),
  CRASH_SIMULATION_END: (ctx) => pick(CRASH_SIMULATION_END, ctx.seed)(ctx.tick),
};

export function resolveTemplate(key, ctx) {
  const fn = TEMPLATE_MAP[key];
  if (!fn) return null;
  const base = fn({ ...ctx, seed: Date.now() });
  return {
    reflection: base.reflection,
    historical_context: base.historical_context || null,
    warning_level: base.warning_level || "info",
    suggested_q: base.suggested_q || null,
    citations: base.citations || [],
  };
}

export function makeTick({ trade, instrument, analog, biasEvidence, holding }) {
  const tick = {
    symbol: instrument?.symbol,
    name: instrument?.name,
    qty: trade?.qty,
    pricePaise: trade?.pricePaise,
    instrument,
    analogText: formatAnalog(analog),
  };
  if (biasEvidence?.panic_sell) {
    const ev = biasEvidence.panic_sell.evidence;
    tick.dropText =
      Math.abs(ev.drop_intraday_pct) >= 3
        ? `just minutes after an intraday drop of ${Math.abs(ev.drop_intraday_pct)}%`
        : `while it was down ${Math.abs(ev.drop_3d_pct)}% over the past few sessions`;
    tick.severity = biasEvidence.panic_sell.severity;
  }
  if (biasEvidence?.pump_chase) {
    tick.intradayGain = biasEvidence.pump_chase.evidence.intraday_gain_pct;
  }
  if (biasEvidence?.fomo) {
    tick.runUp = biasEvidence.fomo.evidence.run_up_pct_7d;
  }
  if (biasEvidence?.concentration) {
    tick.concentration = biasEvidence.concentration.evidence.concentration_pct;
  }
  if (biasEvidence?.sector_concentration) {
    tick.sector = biasEvidence.sector_concentration.evidence.top_sector;
    tick.sectorPct = biasEvidence.sector_concentration.evidence.sector_pct;
  }
  if (biasEvidence?.anchoring) {
    tick.anchor = biasEvidence.anchoring.evidence.anchor;
  }
  if (biasEvidence?.disposition) {
    tick.winnersSold = biasEvidence.disposition.evidence.winners_sold;
    tick.losersSold = biasEvidence.disposition.evidence.losers_sold;
  }
  if (biasEvidence?.churning) {
    tick.rounds = biasEvidence.churning.evidence.round_trips_30d;
  }
  if (biasEvidence?.overtrading) {
    tick.count = biasEvidence.overtrading.evidence.trades_24h;
  }
  if (holding) {
    const plPct = (trade.pricePaise - holding.avgCostPaise) / holding.avgCostPaise;
    tick.plPct = plPct * 100;
  }
  return tick;
}
