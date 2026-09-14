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

let pass = 0;
const failures = [];
for (const [name, reply, user, want] of CASES) {
  let got;
  try { got = looksLikePricelessList(reply, user); }
  catch (e) { got = `THREW: ${e.message}`; }
  if (got === want) { pass++; }
  else { failures.push(`  ${name}\n    got ${got}, want ${want}`); }
}

console.log(`coach guards: ${pass}/${CASES.length} passing`);
if (failures.length) {
  console.error("\nFAILURES:\n" + failures.join("\n"));
  process.exit(1);
}
