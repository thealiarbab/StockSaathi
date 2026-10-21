// =============================================================================
// scripts/test-coach-guards.mjs — regression suite for the coach's reply guards
//
// WHY THIS EXISTS
//
// docs/COACH_FIXES.md closes with: "Regex probe suites are not enough. Rounds 2
// and 4 were 41/41 and green while the replies underneath contained fabricated
// portfolios." That is true, and it is not an argument against tests — it is an
// argument against tests written from imagination. Every case below is either a
// reply captured VERBATIM from production, or a case documented in COACH_FIXES
// as a real false positive that must keep passing.
//
// The guards these cover are the "code layer behind the prompt layer" that
// COACH_FIXES §22 argues every durable fix needs, because a prompt rule is a
// preference and not a guarantee.
//
// Run:  node scripts/test-coach-guards.mjs
// CI:   .github/workflows/perf-syntax.yml (every push)
//
// Deliberately dependency-free and DOM-free: it extracts the pure functions
// out of js/coach/agent.js by source slice rather than importing the module,
// which would drag in browser globals. That makes it runnable in plain Node
// with no build step, matching the rest of scripts/.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withLookupProvenance } from "../js/coach/lookupProvenance.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "js/coach/agent.js"), "utf8");

/** Slice a top-level `export function name(...) { ... }` out of the source. */
function extractFn(name) {
  const start = SRC.indexOf(`export function ${name}`);
  if (start < 0) throw new Error(`${name} not found in js/coach/agent.js`);
  const open = SRC.indexOf("{", start);
  let depth = 0, i = open;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (!depth) { i++; break; } }
  }
  return SRC.slice(start, i).replace(/^export\s+/, "");
}

/** Pull a top-level `const NAME = /regex/flags;` out of the source. */
function extractRe(name) {
  const m = SRC.match(new RegExp(`const ${name} = (/.*/[a-z]*);`));
  if (!m) throw new Error(`${name} not found`);
  return m[1];
}

const sandbox = new Function(`
  const DISCOVERY_RE = ${extractRe("DISCOVERY_RE")};
  ${extractFn("looksLikePricelessList")}
  return { looksLikePricelessList };
`)();
const { looksLikePricelessList } = sandbox;

// -----------------------------------------------------------------------------
// Case 1 is the verbatim reply production returned on 2026-09-14 to the owner's
// exact phrasing, "fetch a list of 20 top bank stocks". Twenty bank names, no
// prices, closing with an offer — the precise thing js/coach/persona.js forbids:
// "Do not hand over a bare list and ask whether they want the prices."
//
// It escaped looksLikeLookupOffer on BOTH of that function's conditions: the
// reply is ~750 chars (cap is 400) and "Which of these categories interests you
// most?" matches none of OFFER_RE's alternatives. If this case ever goes green
// as `false`, the bug is back.
// -----------------------------------------------------------------------------
const PRODUCTION_BARE_LIST =
  "The search pulled a mix of private and public sector giants. On the private " +
  "side, you have the heavyweights like HDFC Bank (HDFCBANK), ICICI Bank " +
  "(ICICIBANK), Axis Bank (AXISBANK), and Kotak Mahindra Bank (KOTAKBANK). " +
  "Mid-sized and smaller private players include RBL Bank (RBLBANK), AU Small " +
  "Finance Bank (AUBANK), and CSB Bank (CSBBANK).\n\nFor Public Sector " +
  "Undertakings (PSUs), the list includes Bank of Baroda (BANKBARODA), Union " +
  "Bank (UNIONBANK), Bank of India (BANKINDIA), and UCO Bank (UCOBANK). There " +
  "are also regional players like J&K Bank (J&KBANK) and Karnataka Bank " +
  "(KTKBANK). If you want to track the whole sector at once, BANKBEES is an " +
  "ETF that follows the Nifty Bank index. Which of these categories interests " +
  "you most?";

const CASES = [
  // --- must fire -------------------------------------------------------------
  ["production bare list (verbatim, 2026-09-14)", PRODUCTION_BARE_LIST,
   "fetch a list of 20 top bank stocks", true],
  ["three tickers, discovery intent, no figures",
   "Try Tata Motors (TATAMOTORS), Maruti (MARUTI) and Mahindra (M&M).",
   "suggest auto stocks", true],

  // --- must NOT fire: the reply actually delivered numbers --------------------
  ["same list but with rupee prices",
   "HDFC Bank (HDFCBANK) is ₹708.25, ICICI Bank (ICICIBANK) ₹1379.30, Axis Bank (AXISBANK) ₹1246.00.",
   "show me bank stocks", false],
  ["list with percentages only",
   "HDFC Bank (HDFCBANK) is up 1.2%, ICICI (ICICIBANK) up 0.4%, Axis (AXISBANK) down 0.3%.",
   "banking stocks", false],

  // --- must NOT fire: not a discovery question --------------------------------
  ["concept answer that happens to name tickers",
   "P/E compares price to earnings. Large caps like (HDFCBANK), (TCS) and (RELIANCE) are often cited when explaining it.",
   "what is a P/E ratio", false],
  ["portfolio answer naming holdings",
   "You hold Vedanta (VEDL), Infosys (INFY) and ITC (ITC) right now.",
   "what do i own", false],

  // --- must NOT fire: COACH_FIXES §22 documented this as a correct refusal -----
  ["§22 correct refusal (documented false positive)",
   "I can't cancel orders for you directly, but you can do it yourself from the Portfolio page's queued-orders card.",
   "cancel my order", false],

  // --- must NOT fire: below the list threshold / degenerate --------------------
  ["two tickers only (below threshold)",
   "The two biggest are HDFC Bank (HDFCBANK) and ICICI Bank (ICICIBANK).",
   "biggest bank stocks", false],
  ["short prose, no tickers at all",
   "Banks in India are split into private and public sector. Want a list?",
   "tell me about banks", false],
  ["empty reply", "", "bank stocks", false],
  ["null reply", null, "bank stocks", false],
  ["null user text", PRODUCTION_BARE_LIST, null, false],
];

// -----------------------------------------------------------------------------
// Dossier arithmetic — the COACH_FIXES §3 regression.
//
// §3 (CRITICAL): asked "what's my total portfolio value?", the coach answered
// "Rs 38,100.00 ... you're currently down Rs 4,000.00" with every number
// invented, because it had been handed quantity @ AVERAGE BUY PRICE and
// multiplied it as though it were market value.
//
// The dossier's job is to make that arithmetic impossible by doing it first.
// These cases assert it actually does. If the total ever stops equalling
// cash + SUM(qty x last price), the structural fix has quietly degraded back
// into being prompt text, which is what §3 proved is not enough.
// -----------------------------------------------------------------------------
async function dossierChecks() {
  let src = fs.readFileSync(path.join(ROOT, "js/coach/dossier.js"), "utf8");
  src = src.replace(/^import .*$/gm, "").replace(/export (async )?function/g, "$1function");
  const { computeTradeStats, returnSummary } = await import(pathToFileURL(path.join(ROOT, "js/data/tradeStats.js")).href);
  const mk = (getState, getInstrument, getQuoteBatch, getCachedQuotes = () => ({})) =>
    new Function("getState", "getInstrument", "getQuoteBatch", "getCachedQuotes", "computeTradeStats", "returnSummary",
      src + "; return { buildDossier, realisedPaise, isCorrupt };")(getState, getInstrument, getQuoteBatch, getCachedQuotes, computeTradeStats, returnSummary);

  const state = {
    isAuthed: true, username: "aarav", profile: { age: 15, riskProfile: "balanced" },
    portfolio: { cashPaise: 4210000, startingCashPaise: 10000000, reservedCashPaise: 0 },
    holdings: {
      VEDL:  { qty: 40,  avgCostPaise: 41200 },
      IDEA:  { qty: 500, avgCostPaise: 1200 },
      GHOST: { qty: 9999999999, avgCostPaise: 0 },  // corrupt (COACH_FIXES §6)
      NOPX:  { qty: 5,   avgCostPaise: 10000 },     // no quote available
    },
    transactions: [
      { id: "t1", symbol: "VEDL", side: "BUY",  qty: 40,   pricePaise: 41200, valuePaise: 1648000, ts: Date.parse("2026-08-01") },
      { id: "t2", symbol: "IDEA", side: "BUY",  qty: 1000, pricePaise: 1200,  valuePaise: 1200000, ts: Date.parse("2026-08-10") },
      { id: "t3", symbol: "IDEA", side: "SELL", qty: 500,  pricePaise: 1000,  valuePaise: 500000,  ts: Date.parse("2026-09-01") },
    ],
    watchlist: ["TCS", "INFY"], transfers: [],
  };
  const quotes = { VEDL: { pricePaise: 43820 }, IDEA: { pricePaise: 980 } };
  const m = mk(() => state, (x) => ({ name: x + " Ltd" }), async () => quotes);

  // cash + market values + the unpriced NOPX at cost (19 Oct: a holding with
  // no real price counts at what was paid, as on the portfolio page, rather
  // than dropping out of the total). The corrupt GHOST row stays out.
  const expectedTotal = 4210000 + 40 * 43820 + 500 * 980 + 5 * 10000;
  const totalStr = (expectedTotal / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const text = await m.buildDossier();
  const signedOut = mk(() => ({ isAuthed: false }), () => null, async () => ({}));
  const emptyText = await signedOut.buildDossier();

  // A quote batch that never answers must not hold the reply hostage: the
  // dossier gives up on it after its deadline and uses the tab's cached
  // quotes. Messages used to sit 10-18 s before the model was called.
  const hung = mk(() => state, (x) => ({ name: x + " Ltd" }), () => new Promise(() => {}),
    (syms) => Object.fromEntries(syms.filter((x) => quotes[x]).map((x) => [x, quotes[x]])));
  const t0 = Date.now();
  const hungText = await hung.buildDossier();
  const hungMs = Date.now() - t0;

  return [
    ["hung quote batch: dossier returns within 5 s", hungMs < 5000, true],
    ["hung quote batch: falls back to cached quotes", hungText.includes(totalStr), true],
    ["TOTAL equals cash + SUM(qty x last price)", text.includes(totalStr), true],
    ["states market value, not just cost basis", text.includes("438.20") && text.includes("17,528.00"), true],
    ["corrupt row flagged, not narrated as free shares", text.includes("GHOST") && text.includes("CORRUPT"), true],
    ["unpriced row refuses estimation", text.includes("NOPX") && text.includes("NO PRICE AVAILABLE"), true],
    ["realised P&L walk: (1000-1200)*500 paise", m.realisedPaise(state.transactions), -100000],
    // Profit = booked + on paper, not value minus starting cash.
    ["profit since start = booked + on paper", text.includes("Profit since the start"), true],
    ["signed out yields no dossier at all", emptyText, ""],
  ];
}

let pass = 0;
const failures = [];
for (const [name, reply, user, want] of CASES) {
  let got;
  try { got = looksLikePricelessList(reply, user); }
  catch (e) { got = `THREW: ${e.message}`; }
  if (got === want) { pass++; }
  else { failures.push(`  ${name}\n    got ${got}, want ${want}`); }
}

// -----------------------------------------------------------------------------
// Advice guard (scrubAdvice / adviceViolation) and the Hinglish detector.
// Every reply below is VERBATIM from production (coach_messages, 10-13 Oct).
// -----------------------------------------------------------------------------
const adviceBox = new Function(`
  ${SRC.slice(SRC.indexOf("const ADVICE_RULES = ["), SRC.indexOf("/** First advice rule"))}
  ${extractFn("adviceViolation")}
  ${SRC.slice(SRC.indexOf("const HINGLISH_RE = "), SRC.indexOf("export function looksHinglish"))}
  ${extractFn("looksHinglish")}
  ${extractFn("replyLanguageMismatch")}
  ${extractFn("scrubAdvice")}
  return { adviceViolation, looksHinglish, replyLanguageMismatch, scrubAdvice };
`)();

// [name, reply, should the guard fire?]
const ADVICE_CASES = [
  ["jan 10 Oct: Reliance ya SBI se shuru karo, 5-10 shares", "Shuruat ke liye hamesha badi aur bharosemand companies (Large-caps) chuno, kyunki unme utaar-chadaav thoda kam hota hai.\n\nAbhi ke top stocks dekh lo:\n1. **Reliance**: ₹1170.30 par hai.\n2. **TCS**: ₹2156.00 par, aaj 3.85% upar gaya hai.\n3. **SBI**: ₹959.10 par hai.\n\nMera suggestion hai ki Reliance ya SBI se shuru karo kyunki inki price thodi kam hai, toh tum zyada shares le paoge. Markets tab mein jaakar inme se kisi ek ko search karo aur 5-10 shares buy karke dekho. \n\nKaunsi company ka naam tumne sabse zyada suna hai?", true],
  ["zane_pro: buy 100 shares of Tata Steel", "Since you have ₹1,00,000, you could buy 100 shares of Tata Steel for about ₹17,392 and still have plenty of cash left to diversify. Which one of these businesses sounds most interesting to you?", true],
  ["jessie: like Tata Motors or Reliance, 2-3 companies", "Starting on StockSaathi is simple since it's all virtual money. Just head over to the Markets page, search for a company you know—like Tata Motors or Reliance—tap on it, and hit Buy. \n\nSince you have ₹1,00,000 in virtual cash ready, you can practice without any real-world risk. A good way to start is by picking 2-3 companies from different sectors so you aren't putting all your eggs in one basket. Want me to pull up some popular stocks to give you some ideas?", true],
  ["aarush: try buying your first stock, like Zomato or Tata", "Want to try buying your first stock just to see how it works? I can show you how to find something you use every day, like Zomato or Tata.", true],
  ["_hardik_720_: a safe bet for beginners", "A \"safe\" bet for beginners is usually a Nifty 50 blue-chip company because they have massive cash reserves and stable businesses. But remember, even the safest stock can drop 20% in a market crash.", true],
  ["yashraj 15:23: kaafi sahi move tha", "Is sell trade se tumne **₹413.95 ka solid profit** book kiya hai. Abhi tumhare paas sirf **1 share** bacha hai jiski average cost ₹823.70 hi hai. 10% se zyada ka return ek din mein nikaalna kaafi sahi move tha.", true],
  ["yashraj 15:25: profit book karna hamesha achha hota hai", "Sahi hai, profit book karna hamesha achha hota hai. **63MOONS** abhi **₹907.40** par chal raha hai.", true],
  ["yashraj 15:26: sahi time par entry", "Aaj ka din is stock ke liye kaafi bada raha hai, isliye tumne sahi time par entry li thi.", true],
  ["yashraj 10:31: Agla target kaunsa stock hai", "Tumhara total realised profit abhi tak **₹23.15** hai.\n\nAgla target kaunsa stock hai?", true],
  ["yashraj 15:25: naya stock lene ka plan", "Bechne ke liye **Markets** page par jaao, 63MOONS search karo aur **Sell** par tap kar do. Kya is profit se koi naya stock lene ka plan hai?", true],
  ["sharma: smart money goes shopping for discounts", "If the business is still healthy—like TCS generally is—crashes are actually when the \"smart money\" goes shopping for discounts.", true],
  ["shlokmulay: Ready to make your first move", "Since the market is closed, it'll sit in that \"Queued\" section until tomorrow morning. Ready to make your first move?", true],
  // Clean replies from the same days: must NOT fire.
  ["clean: aarush 10:38 framework, sector like IT or Banking", "I can't give you a list of \"buys\" and \"sells\"—that's a job for SEBI-registered advisors, and honestly, picking for you would stop you from learning how to do it yourself.\n\nInstead, here is the framework for spotting a good investment. First, check if the company's **Profit and Revenue** are growing every year—if they aren't making money, you shouldn't either. Second, look at the **P/E Ratio** to see if the stock is overpriced compared to its competitors. Finally, ask yourself: do I actually understand how this company makes money?\n\nIf you want to practice, pick a sector like IT or Banking. I can pull up the top companies there and their current numbers so you can compare them.", false],
  ["clean: pradnyank1212 15:58 low-priced stocks with prices", "I can't tell you what to buy, but I can show you some popular low-priced stocks people often look at. \n\nFor example, Vodafone Idea (IDEA) is at ₹12.80 (-1.54%), Suzlon Energy (SUZLON) is at ₹40.19 (+6.89%), and Indian Railway Finance Corp (IRFC) is at ₹79.62 (+6.59%). \n\nJust remember, a low share price doesn't automatically mean a stock is \"cheap\" or a good deal—it just means the company has split its total value into many small pieces. \n\nWhat kind of business are you looking to invest in?", false],
  ["clean: jessie 15:16 names with prices", "Here are a few well-known companies across different sectors to get you started.\n\nReliance is trading at ₹1167.8 (-0.21% today) in the energy sector. In IT, TCS is at ₹2262 (up 4.92%) and Infosys is at ₹1061.15 (up 3.69%). If you're looking at banking, HDFC Bank is at ₹714.95 (+1.09%).\n\nYou can find any of these by searching their names in the Markets tab. Which one looks interesting to you, or do you want to check a different sector like Auto or Pharma?", false],
  ["clean: yashraj 10:30 holdings", "Your current holdings and the prices you paid for them are:\n\n*   **63MOONS**: 6 shares at **₹823.70**\n*   **AAYUSHBULL**: 2 shares at **₹1,282.00**\n\nYou also have a pending **SELL order** for your 1 share of ANGELONE at ₹310.00. Since the current price is ₹303.85, it hasn't hit your target yet. \n\nWant me to check the live profit or loss on any of these for you?", false],
  ["clean: shlokmulay 16:08 AMO explanation", "If you put in an order now, it gets queued as an **AMO (After Market Order)**. Since the market is closed, it won't fill immediately.\n\nHDFC Bank closed at ₹714.00 today (up 0.95%). Should I show you how to set a Limit order instead if you want a specific price?", false],
  ["clean: crash answer without timing advice", "On selling during a crash: usually, that's the worst time to exit. Panic-selling turns a \"paper loss\" into a real one. The real question is: did the company's fundamentals break, or is the whole market just having a bad day?", false],
];

let aPass = 0;
for (const [name, reply, want] of ADVICE_CASES) {
  let got;
  try { got = !!adviceBox.adviceViolation(reply); } catch (e) { got = `THREW: ${e.message}`; }
  if (got === want) aPass++;
  else failures.push(`  advice: ${name}\n    got ${got}, want ${want}`);
}

// Scrubbing keeps the useful part and leaves nothing that breaks a rule.
const SCRUB_CASES = [
  ["jan: picks removed, prices kept", ADVICE_CASES[0][1], (r) => !adviceBox.adviceViolation(r.text) && r.text.includes("₹959.10") && !/shuru karo/.test(r.text)],
  ["yashraj 15:23: praise removed, facts kept", ADVICE_CASES[5][1], (r) => !adviceBox.adviceViolation(r.text) && r.text.includes("₹413.95") && /\?\s*$/.test(r.text)],
  ["yashraj 10:31: nudge replaced by a reflection, in Hinglish", ADVICE_CASES[8][1], (r) => !adviceBox.adviceViolation(r.text) && r.text.includes("₹23.15") && /plan kya tha/.test(r.text)],
  ["aarush: nothing useful left -> neutral line", ADVICE_CASES[3][1], (r) => !adviceBox.adviceViolation(r.text) && r.text.length > 40],
  ["clean reply is returned unchanged", ADVICE_CASES[12][1], (r) => r.text === ADVICE_CASES[12][1] && r.rules.length === 0],
];
let sPass = 0;
for (const [name, reply, ok] of SCRUB_CASES) {
  let good;
  try { good = ok(adviceBox.scrubAdvice(reply, "")); } catch (e) { good = false; failures.push(`  scrub: ${name} THREW ${e.message}`); continue; }
  if (good) sPass++;
  else failures.push(`  scrub: ${name}\n    got ${JSON.stringify(adviceBox.scrubAdvice(reply, "").text).slice(0, 300)}`);
}

// C28: yashraj 10:30 wrote Hinglish and got English back.
const LANG_CASES = [
  ["yashraj 10:30 question is Hinglish", adviceBox.looksHinglish("Maine jitne bhi stocks buy kiye the uske bought price batao"), true],
  ["...and the English reply is flagged", adviceBox.replyLanguageMismatch("Maine jitne bhi stocks buy kiye the uske bought price batao", ADVICE_CASES[15][1]), true],
  ["Hinglish reply to Hinglish is fine", adviceBox.replyLanguageMismatch("Bhai maine 63 moons kitne me kharida", ADVICE_CASES[5][1]), false],
  ["English question is not Hinglish", adviceBox.looksHinglish("How to start trading"), false],
  ["English question with 'me' is not Hinglish", adviceBox.looksHinglish("Can you tell me the price of TCS"), false],
];
let lPass = 0;
for (const [name, got, want] of LANG_CASES) {
  if (got === want) lPass++;
  else failures.push(`  language: ${name}\n    got ${got}, want ${want}`);
}

// -----------------------------------------------------------------------------
// O12: one trade-stats engine (js/data/tradeStats.js). yashraj's real ledger
// (13 Oct): ABSLAMC +12.10, TATACAP +11.05, ANGELONE +5.70, 63MOONS sold in
// two parts (+406.50, +78.20) = 4 winning round trips, realised +Rs 513.55.
// -----------------------------------------------------------------------------
const { computeTradeStats, returnSummary } = await import(new URL("../js/data/tradeStats.js", import.meta.url));
const YASHRAJ = [{"ts":1791776710862,"symbol":"ABSLAMC","side":"BUY","qty":1,"pricePaise":100100},{"ts":1791776711547,"symbol":"TATACAP","side":"BUY","qty":1,"pricePaise":31800},{"ts":1791776718690,"symbol":"AAYUSHBULL","side":"BUY","qty":2,"pricePaise":128200},{"ts":1791779454835,"symbol":"ABSLAMC","side":"SELL","qty":1,"pricePaise":101310},{"ts":1791781226491,"symbol":"TATACAP","side":"SELL","qty":1,"pricePaise":32905},{"ts":1791784088910,"symbol":"TMPV","side":"BUY","qty":1,"pricePaise":27900},{"ts":1791792814727,"symbol":"ANGELONE","side":"BUY","qty":1,"pricePaise":30440},{"ts":1791863112643,"symbol":"63MOONS","side":"BUY","qty":6,"pricePaise":82370},{"ts":1791868945310,"symbol":"AAYUSHBULL","side":"BUY","qty":5,"pricePaise":129495},{"ts":1791869107310,"symbol":"AAYUSHBULL","side":"BUY","qty":3,"pricePaise":129495},{"ts":1791884401994,"symbol":"ANGELONE","side":"SELL","qty":1,"pricePaise":31010},{"ts":1791884712962,"symbol":"63MOONS","side":"SELL","qty":5,"pricePaise":90500},{"ts":1791885577946,"symbol":"63MOONS","side":"SELL","qty":1,"pricePaise":90190}];
const y = computeTradeStats(YASHRAJ);
const DAY = 86400000;
const threeParts = computeTradeStats([
  { ts: 0, symbol: "X", side: "BUY", qty: 3, pricePaise: 1000 },
  { ts: 1 * DAY, symbol: "X", side: "SELL", qty: 1, pricePaise: 1100 },
  { ts: 2 * DAY, symbol: "X", side: "SELL", qty: 1, pricePaise: 1100 },
  { ts: 3 * DAY, symbol: "X", side: "SELL", qty: 1, pricePaise: 1100 },
  { ts: 10 * DAY, symbol: "X", side: "BUY", qty: 1, pricePaise: 1000 },
  { ts: 12 * DAY, symbol: "X", side: "SELL", qty: 1, pricePaise: 900 },
]);
const STAT_CASES = [
  ["yashraj realised P&L = +513.55", y.realisedPaise, 51355],
  ["yashraj: 4 winning round trips", y.wins, 4],
  ["yashraj: 0 losing round trips", y.losses, 0],
  ["yashraj: AAYUSHBULL and TMPV still open", Object.keys(y.openPositions).sort().join(","), "AAYUSHBULL,TMPV"],
  ["one position sold in 3 parts = 1 win, not 3", threeParts.wins, 1],
  ["reopened position is its own round trip (a loss)", threeParts.losses, 1],
  ["sold at the price paid is even, not a win or a loss",
    computeTradeStats([{ ts: 0, symbol: "E", side: "BUY", qty: 10, pricePaise: 50000 }, { ts: DAY, symbol: "E", side: "SELL", qty: 10, pricePaise: 50050 }]).evens, 1],
  ["cash from outside a trade is capital, not profit",
    returnSummary({ cashPaise: 1000000, startingCashPaise: 10000000, paperPaise: -500000,
      stats: computeTradeStats([{ ts: 0, symbol: "G", side: "BUY", qty: 100, pricePaise: 290000, valuePaise: 29000000 }]) }).capitalPaise, 30000000],
  ["hold days restart on reopen: (3 + 2) / 2", threeParts.avgHoldDays, 2.5],
];
let tPass = 0;
for (const [name, got, want] of STAT_CASES) {
  if (got === want) tPass++;
  else failures.push(`  tradeStats: ${name}\n    got ${got}, want ${want}`);
}

// -----------------------------------------------------------------------------
// C5/C6: figures nobody looked up. Replies are VERBATIM from production
// (mr.ancient 6 Oct 21:29 and 21:32, 10 Oct 17:06). Sources go through
// figureSources as in production, with the real persona text in the system
// prompt: it must be cut out, or its teaching numbers ("2.5% annual
// interest") quietly vouch for invented ones ("up 3% today").
// -----------------------------------------------------------------------------
const PERSONA_SRC = fs.readFileSync(path.join(ROOT, "js/coach/persona.js"), "utf8");
const figBox = new Function("SYSTEM_PROMPT", "NO_TOOLS_NOTE", `
  const NEWS_RE = ${extractRe("NEWS_RE")};
  ${SRC.slice(SRC.indexOf("const FIG_MONEY_RE"), SRC.indexOf("const FIGURE_NUDGE")).replace(/^export\s+/gm, "")}
  return { NEWS_RE, unsourcedFigures, dropFigureSentences, figureSources };
`)(PERSONA_SRC, "");
const OIL_WAR = "The market is currently on edge because of the escalating tensions in the Middle East. While there isn't a full-blown \"US-Iran war\" right now, the conflict between Israel and Iran-backed groups has caused oil prices to spike recently. Brent crude jumped back toward $80 a barrel last week on fears that Iranian oil facilities might be targeted.\n\nFor India, this is a double whammy. We import over 80% of our oil, so high prices lead to a weaker Rupee and higher inflation. In the stock market, you'll see \"OMCs\" (Oil Marketing Companies) like **BPCL**, **HPCL**, and **IOC** taking a hit because they can't always pass the high crude costs to customers at the petrol pump.\n\nOn the flip side, **HAL** (Hindustan Aeronautics) is up 3% today, partly due to increased focus on indigenous defence production. When global tensions rise, defence stocks often get a boost. Are you looking at this as a reason to sell your current holdings or to find a new \"war-proof\" entry?";
const ADANI = "Nobody is \"sure\" in the markets—anyone who says they are is lying. Right now, oil is volatile because of geopolitics. If a ceasefire is reached, oil could crash back down instantly. If a refinery gets hit, it could skyrocket. You can't predict the war, so don't try to time the trade perfectly.\n\nAlso, a quick correction: there is no \"Adani Green Energy ETF.\" You can buy **ADANIGREEN** as a single stock, or you can buy a **Nifty Next 50 ETF** which usually includes it. \n\nADANIGREEN is currently at ₹1,845.20, down 0.45% today. It’s a high-growth stock but very \"expensive\" (high P/E), meaning investors expect massive things from it. If oil prices drop, the \"emergency\" rush to green energy might cool off, and this stock could see a sharp correction.\n\nInstead of going all-in because of a news headline, have you thought about a **SIP** (Systematic Investment Plan) where you buy a little bit every month regardless of the oil price?";
const HDFC_LIMIT = "It's too early to call it a \"good\" or \"bad\" move because none of your orders have filled yet—you still have all your cash and zero holdings.\n\nThe move you *did* make was setting \"Limit\" prices. For example, you've set HDFCBANK to buy at ₹700, but it usually trades much higher (around ₹1,600-₹1,700 lately). Unless there’s a massive crash, that order might never fill. \n\nA \"Market\" order buys at the current price immediately, while a \"Limit\" order is you being picky about the price. Do you want me to check the current price for HDFCBANK so you can see how far off your ₹700 limit is?";
const HDFC_TOOL = '{"ok":true,"orders":[{"symbol":"AAATECH","side":"BUY","qty":10,"limit_price_inr":107.92},{"symbol":"HDFCBANK","side":"BUY","qty":4,"limit_price_inr":700},{"symbol":"3BBLACKBIO","side":"BUY","qty":1,"limit_price_inr":1500}]}';
const src = (...extra) => figBox.figureSources(PERSONA_SRC + "\n\n# MARKET\nNSE is closed.", extra.map((content) => ({ role: "user", content })));
const assistantSrc = (content) => figBox.figureSources(
  PERSONA_SRC + "\n\n# MARKET\nNSE is closed.",
  [{ role: "assistant", content }],
);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const FIG_CASES = [
  // --- must flag ---------------------------------------------------------------
  ["oil/Iran answer: $80 Brent and HAL +3% today, no lookup", figBox.unsourcedFigures(OIL_WAR, src("What is the latest news regarding oil prices and iran us war?")), ["$80", "3%"]],
  ["ADANIGREEN ₹1,845.20 and -0.45% today, no price lookup", figBox.unsourcedFigures(ADANI, src("I was planning to invest in adani green energy etf today")), ["₹1,845.20", "0.45%"]],
  ["HDFC range invented; the ₹700 limit came from the orders tool", figBox.unsourcedFigures(HDFC_LIMIT, src("Did i made good move or bad move", HDFC_TOOL)), ["₹1,600", "₹1,700"]],
  ["no-tools stream about HAL: price, then 'This represents … 1.45% … today'", figBox.unsourcedFigures("Hindustan Aeronautics Limited (HAL) is currently trading at approximately ₹4,064.00 per share on the Indian stock exchanges. This represents a downward movement of about 1.45% during today's trading session.", src("What's HAL trading at today?")), ["₹4,064.00", "1.45%"]],
  ["'It is trading at' after the name", figBox.unsourcedFigures("Adani Green is a renewable power company. It is trading at ₹1,845.20.", src()), ["₹1,845.20"]],
  // --- must NOT flag -----------------------------------------------------------
  ["worked example with today/tomorrow", figBox.unsourcedFigures("If a stock falls 10% today and rises 10% tomorrow, you are still down 1%.", src()), []],
  ["Hinglish worked example", figBox.unsourcedFigures("Agar TCS aaj 5% gire aur kal 5% badhe, tab bhi tum loss me ho.", src()), []],
  ["price + today's move from get_stock_price", figBox.unsourcedFigures("**TCS** is at ₹2,269.30, up 6.79% today.", src('{"symbol":"TCS","price_inr":2269.3,"change_pct":6.79}')), []],
  ["price given in paise by the tool", figBox.unsourcedFigures("RELIANCE closed at ₹1,412.50.", src('{"pricePaise":141250}')), []],
  ["total worked out from a looked-up price", figBox.unsourcedFigures("10 shares of TCS at ₹2,269.30 would cost about ₹22,693.", src('{"symbol":"TCS","price_inr":2269.3}')), []],
  ["concept answer with rupee example, no instrument", figBox.unsourcedFigures("A ₹500 monthly SIP at 12% a year grows to about ₹1.16 lakh in 10 years.", src()), []],
  ["holding value from the dossier, in lakh", figBox.unsourcedFigures("Your NIFTYBEES holding is worth ₹1.02L right now.", src("NIFTYBEES qty 360 value ₹1,02,345.60")), []],
  ["the user's own number", figBox.unsourcedFigures("Your INFY limit at ₹1,350 will wait in Queued orders.", src("place a limit for INFY at 1350")), []],
  ["market cap in crore, as the tool gives it", figBox.unsourcedFigures("RELIANCE has a market cap of about ₹19,10,000 crore (₹19.1 lakh crore).", src('{"symbol":"RELIANCE","market_cap_crore_inr":1910432}')), []],
  ["share of imports, no time word", figBox.unsourcedFigures("We import over 80% of our oil.", src()), []],
  ["old assistant claim is not its own evidence", figBox.unsourcedFigures("TCS was at ₹2,269.30.", assistantSrc("TCS was at ₹2,269.30.")), ["₹2,269.30"]],
  ["app-recorded quote may support a historical reference", figBox.unsourcedFigures(
    "TCS was at ₹2,269.30.",
    assistantSrc(withLookupProvenance("TCS was at ₹2,269.30.", [{
      tool: "get_stock_price", subject: "TCS", status: "returned",
      facts: { symbol: "TCS", price_inr: 2269.3, day_change_pct: 6.79 },
    }])),
  ), []],
];
let fPass = 0;
for (const [name, got, want] of FIG_CASES) {
  if (sameSet(got, want)) fPass++;
  else failures.push(`  figures: ${name}\n    got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
const dropped = figBox.dropFigureSentences(ADANI, ["₹1,845.20", "0.45%"]);
if (!dropped.includes("₹1,845.20") && dropped.includes("Nobody is") && dropped.includes("high-growth stock") && /\n\n/.test(dropped)) fPass++;
else failures.push(`  figures: dropFigureSentences keeps the rest\n    got ${JSON.stringify(dropped).slice(0, 300)}`);
const NEWS_Q = [
  ["What is the latest news regarding oil prices and iran us war?", true],
  ["aaj market kyu gira", true],
  ["why is HDFC bank falling", true],
  ["what is a P/E ratio", false],
  ["how do I start a SIP", false],
];
for (const [q, want] of NEWS_Q) {
  if (figBox.NEWS_RE.test(q.toLowerCase()) === want) fPass++;
  else failures.push(`  figures: NEWS_RE ${JSON.stringify(q)} want ${want}`);
}
const FIG_TOTAL = FIG_CASES.length + 1 + NEWS_Q.length;

const dossierResults = await dossierChecks();
let dPass = 0;
for (const [name, got, want] of dossierResults) {
  if (got === want) dPass++;
  else failures.push(`  dossier: ${name}\n    got ${got}, want ${want}`);
}

// -----------------------------------------------------------------------------
// STREAMING, TRANSLATION, CACHING & ROLE INTEGRITY TESTS
// -----------------------------------------------------------------------------
import { toChatSse, toMessagesBody, maxTokensFor } from "../api/_messages.js";

async function runSseTests() {
  const sseResults = [];
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const collectStream = async (inputLines) => {
    const stream = new ReadableStream({
      start(controller) {
        for (const l of inputLines) controller.enqueue(enc.encode(l));
        controller.close();
      },
    });
    const outStream = toChatSse(stream, "test_req");
    const reader = outStream.getReader();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    const chunks = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:") && trimmed !== "data: [DONE]") {
        try { chunks.push(JSON.parse(trimmed.slice(5).trim())); } catch {}
      }
    }
    return { text, chunks, done: text.includes("data: [DONE]") };
  };

  // Test 1: Contiguous tool indexing (block 0 is text, block 1 is tool_use)
  try {
    const t1Input = [
      'data: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking price"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"get_stock_price"}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"sym"}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"bol\\":\\"TCS\\"}"}}\n\n',
      'data: {"type":"content_block_stop","index":1}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];
    const { chunks, done } = await collectStream(t1Input);
    const tcChunk = chunks.find(c => c.choices?.[0]?.delta?.tool_calls);
    const tcIdx = tcChunk?.choices?.[0]?.delta?.tool_calls?.[0]?.index;
    const term = chunks.find(c => c.choices?.[0]?.finish_reason);
    sseResults.push(["contiguous tool indexing maps block 1 to tool_calls[0]", tcIdx, 0]);
    sseResults.push(["tool_use stop reason maps to tool_calls finish_reason", term?.choices?.[0]?.finish_reason, "tool_calls"]);
    sseResults.push(["stream ends with [DONE]", done, true]);
  } catch (e) {
    sseResults.push(["contiguous tool indexing threw", e.message, "success"]);
  }

  // Test 2: Max-tokens stop reason maps to length
  try {
    const t2Input = [
      'data: {"type":"message_start","message":{"id":"msg_2"}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Incomplete thought..."}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];
    const { chunks } = await collectStream(t2Input);
    const term = chunks.find(c => c.choices?.[0]?.finish_reason);
    sseResults.push(["max_tokens stop reason maps to length finish_reason", term?.choices?.[0]?.finish_reason, "length"]);
  } catch (e) {
    sseResults.push(["max_tokens test threw", e.message, "success"]);
  }

  // Test 3: Premature drop without message_stop throws error
  try {
    const t3Input = [
      'data: {"type":"message_start","message":{"id":"msg_3"}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Cut off mid"}}\n\n',
    ];
    let threw = false;
    try {
      await collectStream(t3Input);
    } catch {
      threw = true;
    }
    sseResults.push(["premature stream drop before message_stop raises error", threw, true]);
  } catch (e) {
    sseResults.push(["premature drop test threw", e.message, "success"]);
  }

  // Test 4: Upstream error event raises error
  try {
    const t4Input = [
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ];
    let threw = false;
    try {
      await collectStream(t4Input);
    } catch {
      threw = true;
    }
    sseResults.push(["upstream error event raises error", threw, true]);
  } catch (e) {
    sseResults.push(["upstream error test threw", e.message, "success"]);
  }

  // Test 5: System prompt caching structure in toMessagesBody
  try {
    const bodyCached = toMessagesBody({
      messages: [{ role: "system", content: "Static System Rules\n\n# RUNTIME FACTS\nClock: 10:30 IST" }],
    }, { profile: "fast" });
    const isArray = Array.isArray(bodyCached.system);
    const hasCache = isArray && bodyCached.system[0]?.cache_control?.type === "ephemeral";
    const staticText = isArray ? bodyCached.system[0]?.text : "";
    const dynText = isArray ? bodyCached.system[1]?.text : "";
    sseResults.push(["system with RUNTIME FACTS splits into dual content blocks", isArray, true]);
    sseResults.push(["static prefix block carries ephemeral cache_control", hasCache, true]);
    sseResults.push(["static prefix text matches rules", staticText, "Static System Rules"]);
    sseResults.push(["dynamic block contains runtime facts", dynText, "# RUNTIME FACTS\nClock: 10:30 IST"]);

    const bodyPlain = toMessagesBody({
      messages: [{ role: "system", content: "Plain System Only" }],
    }, { profile: "fast" });
    sseResults.push(["system without RUNTIME FACTS is string", typeof bodyPlain.system, "string"]);
  } catch (e) {
    sseResults.push(["prompt caching test threw", e.message, "success"]);
  }

  // Test 6: Role integrity (splitForCache is removed from agent.js)
  sseResults.push(["splitForCache completely absent from agent.js", SRC.includes("splitForCache"), false]);

  // Test 7: Output token ceiling is 128k
  sseResults.push(["maxTokensFor ceiling is 128000", maxTokensFor(), 128000]);

  return sseResults;
}

const sseResults = await runSseTests();
let ssePass = 0;
for (const [name, got, want] of sseResults) {
  if (got === want) ssePass++;
  else failures.push(`  sse/cache: ${name}\n    got ${got}, want ${want}`);
}

console.log(`coach guards: ${pass}/${CASES.length} passing`);
console.log(`dossier:      ${dPass}/${dossierResults.length} passing`);
console.log(`advice:       ${aPass}/${ADVICE_CASES.length} passing`);
console.log(`scrub:        ${sPass}/${SCRUB_CASES.length} passing`);
console.log(`language:     ${lPass}/${LANG_CASES.length} passing`);
console.log(`tradeStats:   ${tPass}/${STAT_CASES.length} passing`);
console.log(`figures:      ${fPass}/${FIG_TOTAL} passing`);
console.log(`sse/cache:    ${ssePass}/${sseResults.length} passing`);
if (failures.length) {
  console.error("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}
