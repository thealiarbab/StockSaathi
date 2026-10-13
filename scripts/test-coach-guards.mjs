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
import { fileURLToPath } from "node:url";

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
  const mk = (getState, getInstrument, getQuoteBatch, getCachedQuotes = () => ({})) =>
    new Function("getState", "getInstrument", "getQuoteBatch", "getCachedQuotes",
      src + "; return { buildDossier, realisedPaise, isCorrupt };")(getState, getInstrument, getQuoteBatch, getCachedQuotes);

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

  const expectedTotal = 4210000 + 40 * 43820 + 500 * 980;   // cash + market values
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

const dossierResults = await dossierChecks();
let dPass = 0;
for (const [name, got, want] of dossierResults) {
  if (got === want) dPass++;
  else failures.push(`  dossier: ${name}\n    got ${got}, want ${want}`);
}

console.log(`coach guards: ${pass}/${CASES.length} passing`);
console.log(`dossier:      ${dPass}/${dossierResults.length} passing`);
console.log(`advice:       ${aPass}/${ADVICE_CASES.length} passing`);
console.log(`scrub:        ${sPass}/${SCRUB_CASES.length} passing`);
console.log(`language:     ${lPass}/${LANG_CASES.length} passing`);
if (failures.length) {
  console.error("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}
