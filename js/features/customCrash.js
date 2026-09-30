// =============================================================================
// CUSTOM CRASH GENERATOR
//
// Takes a free-text description of an Indian market event ("Harshad Mehta
// 1992", "Satyam scandal", "YES Bank 2020", etc.) and returns a full CRASH
// scenario object compatible with the existing replay UI.
//
// The LLM returns METADATA only (start/trough/end index levels, duration,
// drop %, named moments). We synthesise the day-by-day frame trajectory
// client-side with a realistic piecewise curve — this keeps the LLM call
// small (fits in the 800-token cap) and the output shape deterministic.
//
// Retries up to 3 times with rising temperature; each attempt runs the
// returned JSON through a shape validator before accepting.
// =============================================================================

// -----------------------------------------------------------------------------
// PROFILING — landed first per PERF_AUDIT §1. Performance API marks cost ~µs
// each so they are always on. The console.table report is gated on
//   ?perf  query param  OR  localStorage["ss.perf"] = "1"
// so normal users never see log spam. Server-Timing headers from /api/chat
// and /api/ai are parsed and folded into the same buffer.
// -----------------------------------------------------------------------------
const _perfBuf = [];
function _perfMark(name) {
  try { performance.mark(name); } catch {}
}
function _perfMeasure(name, startMark, endMark) {
  try {
    performance.measure(name, startMark, endMark);
    const m = performance.getEntriesByName(name, "measure").pop();
    if (m) _perfBuf.push({ seg: name, ms: Math.round(m.duration) });
  } catch {}
}
function _perfServerTiming(res, label) {
  try {
    const st = res?.headers?.get?.("server-timing");
    if (!st) return;
    for (const part of st.split(",").map(s => s.trim())) {
      const toks = part.split(";").map(t => t.trim());
      const name = toks[0];
      let dur = null, desc = null;
      for (const t of toks.slice(1)) {
        if (t.startsWith("dur=")) dur = Number(t.slice(4));
        else if (t.startsWith("desc=")) desc = t.slice(5).replace(/^"|"$/g, "");
      }
      if (name && Number.isFinite(dur)) {
        _perfBuf.push({ seg: `${label}:${name}`, ms: Math.round(dur), upstream: desc || "" });
      }
    }
  } catch {}
}
function _perfReport() {
  let enabled = false;
  try {
    enabled = /[?&]perf\b/.test(location.search) || localStorage.getItem("ss.perf") === "1";
  } catch {}
  if (!enabled) { _perfBuf.length = 0; return; }
  try {
    console.groupCollapsed("[crash-replay perf]");
    console.table(_perfBuf);
    const total = performance.getEntriesByName("cc:total", "measure").pop();
    if (total) console.log(`TOTAL ${Math.round(total.duration)} ms (cc:start → cc:first-paint)`);
    console.groupEnd();
  } catch {}
  _perfBuf.length = 0;
}
if (typeof window !== "undefined") {
  window.__ccPerfReport = _perfReport;
  window.__ccPerfBuf = _perfBuf;
}
// =============================================================================

// Phase 1: pick the event's date range + target index. PERF_AUDIT #6
// trimmed this from ~1.7KB to ~700B once the deterministic router (#2)
// began catching the well-known events.
const PHASE1_PROMPT = `You are Saathi's historical-event-date picker for Indian markets. Identify the event in the user's description and return ONLY JSON:
{
  "startIso": "<YYYY-MM-DD, first trading day>",
  "endIso":   "<YYYY-MM-DD, end of recovery window, max 140 trading days from startIso>",
  "symbol":   "^NSEI" | "^BSESN" | "<NSE ticker>.NS",
  "hint":     "<one-sentence event identification>",
  "offTopic": <true only for adult/vulgar content or zero-market-relevance queries>
}

Rules:
- startIso MUST be before endIso. Window 10-140 trading days.
- If the event hit a specific stock harder than the index, set symbol to that ticker (PAYTM.NS, ADANIENT.NS, YESBANK.NS, etc.). Otherwise ^NSEI.
- For rallies/IPO-pops, still pick a range — we judge direction downstream.
- offTopic:true ONLY for porn/vulgarity/sports/recipes/weather. Otherwise build a range.
- Return ONLY the JSON. No prose, no code fences.`;

// Fast client-side filter for clearly inappropriate queries. We check
// BEFORE any Gemini call so a user typing "pornhub" doesn't burn credits
// OR land a replay with suggestive content. Keeping the list short and
// high-signal — adult content, common slurs, explicit acts. The LLM's
// offTopic:true flag in Phase A catches the long tail.
const HARD_BLOCK_PATTERNS = [
  /\b(porn|pornhub|xxx|nsfw|nude|naked|erotic|onlyfans|escort|hentai|cam\s*girl)\b/i,
  /\b(sex(ual|y)?|fuck(ing|ed|er)?|cock|dick|pussy|boob|tits|ass\s*hole|bitch|whore|slut)\b/i,
  /\b(rape|molest|paedo|pedo|child\s*porn)\b/i,
];
function isHardBlocked(text) {
  const t = String(text || "").toLowerCase();
  return HARD_BLOCK_PATTERNS.some(rx => rx.test(t));
}

// PERF_AUDIT #6: trimmed ~500B by condensing the description spec and
// the "closes vs opens" anti-pattern note. The shape rules and field
// list are load-bearing (the validator rejects malformed output) so
// they stay verbatim. The narrative-quality guidance was example-heavy
// and the model has internalized it across thousands of generations.
const SYSTEM_PROMPT = `You are a financial-history reconstructor for Indian markets. You are given REAL daily closing-price data from Yahoo Finance. Use the real numbers — do NOT hallucinate.

DEFAULT IS TO BUILD. If the real data shows the index WENT UP (not a crash), return: { "error": "not_a_crash", "message": "<one sentence>" }. Only refuse for clearly non-market queries.

Otherwise return a JSON object with this EXACT shape:

{
  "title": "<short event name, ≤ 50 chars>",
  "startLabel": "<e.g. 'Mar 11, 2020'>",
  "endLabel": "<human-readable end date>",
  "description": "<120-220 word neutral 2-3 paragraph explanation: scene, event, aftermath. No opinions, no advice.>",
  "totalDays": <integer 20..120, trading days>,
  "startIndex": <day 0 close>,
  "troughIndex": <lowest close>,
  "troughDay": <integer, day offset of trough>,
  "endIndex": <last close>,
  "indexDrop": <negative %, drop from start to trough>,
  "recoveryDays": <integer, trough to new ATH within window; 0 if no recovery>,
  "panicDay": <integer, typically 3>,
  "keyMoments": [
    { "day": <integer>, "label": "<≤ 24 char>", "narration": "<1-2 sentence>" }
  ]
}

Rules:
- Return ONLY the JSON. No prose, no code fences.
- startIndex/troughIndex/endIndex/troughDay come from REAL data. No fabrication.
- indexDrop = ((troughIndex - startIndex) / startIndex) * 100, 1 decimal, negative.
- totalDays == data.length.
- 4 to 7 keyMoments whose "day" maps to actual data indices.
- Every cited price is a CLOSING price. Phrase as "closes at ₹X" / "closed at ₹X". NEVER "opens at" / "opening price" — you do NOT have intraday opens. After-hours news (RBI moratorium, results) day-0 wording is "closes at ₹X" — the figure is the last clean close BEFORE the news.`;

const MAX_DAYS = 140;

// -----------------------------------------------------------------------------
// Phase A deterministic router (PERF_AUDIT item #2)
//
// Most queries to crash-replay are well-known events whose dates we already
// know — Harshad Mehta 1992, COVID March 2020, Adani Hindenburg 2023, etc.
// Burning a 950 ms Phase A LLM call to look up dates we have hardcoded is
// pure waste. This router matches the input against an alias table of ~40
// canonical events (sourced from PHASE1_PROMPT's colloquial-to-formal block
// + EXAMPLE_EVENTS + §4's top 10). On match, returns the same shape Phase
// A's LLM would have returned. On miss, returns null and the caller falls
// through to the LLM unchanged.
//
// Match rules:
//   1. Tokenize input the same way queryKey does (split letters/digits,
//      lowercase, strip punctuation).
//   2. For each alias entry, every "required" token must be present in
//      the input.
//   3. If the entry has a canonical year and the input contains a 4-digit
//      token, those years MUST match. This keeps "covid 2024" from
//      matching "covid 2020" — that query genuinely needs the LLM to
//      identify whether 2024 maps to a known event or off-topic.
//   4. First match in alias-table order wins. Most-specific entries come
//      first (e.g. "satyam computer 2009" before bare "satyam") so an
//      exact phrasing doesn't get shadowed by a looser match.
//
// What this DOESN'T do:
//   - Off-topic detection. The LLM's offTopic:true flag is the long-tail
//     guardrail; the router only matches POSITIVE market events. Any
//     unrecognized query falls through to the LLM, which can flag it.
//   - Off-list events. Brand-new news (next month's IPO, today's RBI
//     decision) cache-miss the router intentionally — the LLM is the
//     right tool for novel queries.
const _PHASE_A_ALIASES = [
  // Harshad Mehta 1992
  { tokens: ["harshad", "mehta"], year: "1992",
    out: { startIso: "1992-04-01", endIso: "1992-08-31", symbol: "^BSESN",
           hint: "Harshad Mehta securities scam, 1992" } },
  // Dot Com 2000
  { tokens: ["dot", "com"], year: "2000",
    out: { startIso: "2000-03-13", endIso: "2000-06-30", symbol: "^NSEI",
           hint: "Dot-com bust, March 2000" } },
  { tokens: ["dotcom"], year: "2000",
    out: { startIso: "2000-03-13", endIso: "2000-06-30", symbol: "^NSEI",
           hint: "Dot-com bust, March 2000" } },
  // Global Financial Crisis 2008
  { tokens: ["lehman"],
    out: { startIso: "2008-09-15", endIso: "2009-03-31", symbol: "^NSEI",
           hint: "Lehman / Global Financial Crisis, Sep 2008" } },
  { tokens: ["global", "financial", "crisis"],
    out: { startIso: "2008-09-15", endIso: "2009-03-31", symbol: "^NSEI",
           hint: "Global Financial Crisis, Sep 2008" } },
  { tokens: ["gfc"],
    out: { startIso: "2008-09-15", endIso: "2009-03-31", symbol: "^NSEI",
           hint: "Global Financial Crisis, Sep 2008" } },
  // Satyam — most-specific first
  { tokens: ["satyam", "computer"],
    out: { startIso: "2009-01-07", endIso: "2009-04-30", symbol: "^NSEI",
           hint: "Satyam Computer fraud, 7 Jan 2009" } },
  { tokens: ["satyam", "scandal"],
    out: { startIso: "2009-01-07", endIso: "2009-04-30", symbol: "^NSEI",
           hint: "Satyam fraud, 7 Jan 2009" } },
  { tokens: ["satyam"],
    out: { startIso: "2009-01-07", endIso: "2009-04-30", symbol: "^NSEI",
           hint: "Satyam fraud, 7 Jan 2009" } },
  // IL&FS 2018 — note IL&FS becomes "il" "fs" after token-split
  { tokens: ["il", "fs"],
    out: { startIso: "2018-09-04", endIso: "2019-01-31", symbol: "^NSEI",
           hint: "IL&FS collapse, Sep 2018" } },
  { tokens: ["ilfs"],
    out: { startIso: "2018-09-04", endIso: "2019-01-31", symbol: "^NSEI",
           hint: "IL&FS collapse, Sep 2018" } },
  // DHFL 2019
  { tokens: ["dhfl"],
    out: { startIso: "2019-06-04", endIso: "2019-12-31", symbol: "DHFL.NS",
           hint: "DHFL liquidity crisis, June 2019" } },
  // YES Bank 2020 — most-specific first to avoid bare "yes" matching unrelated queries
  { tokens: ["yes", "bank", "moratorium"],
    out: { startIso: "2020-03-05", endIso: "2020-07-31", symbol: "YESBANK.NS",
           hint: "YES Bank moratorium, 5 Mar 2020" } },
  { tokens: ["yesbank"],
    out: { startIso: "2020-03-05", endIso: "2020-07-31", symbol: "YESBANK.NS",
           hint: "YES Bank moratorium, 5 Mar 2020" } },
  { tokens: ["yes", "bank"],
    out: { startIso: "2020-03-05", endIso: "2020-07-31", symbol: "YESBANK.NS",
           hint: "YES Bank moratorium, 5 Mar 2020" } },
  // COVID March 2020
  { tokens: ["covid"],
    out: { startIso: "2020-02-20", endIso: "2020-08-31", symbol: "^NSEI",
           hint: "COVID-19 crash, March 2020" } },
  { tokens: ["corona"],
    out: { startIso: "2020-02-20", endIso: "2020-08-31", symbol: "^NSEI",
           hint: "COVID-19 / coronavirus crash, March 2020" } },
  { tokens: ["lockdown"],
    out: { startIso: "2020-02-20", endIso: "2020-08-31", symbol: "^NSEI",
           hint: "Lockdown / COVID crash, March 2020" } },
  { tokens: ["pandemic"],
    out: { startIso: "2020-02-20", endIso: "2020-08-31", symbol: "^NSEI",
           hint: "Pandemic crash, March 2020" } },
  // Paytm IPO 2021
  { tokens: ["paytm", "ipo"],
    out: { startIso: "2021-11-18", endIso: "2022-04-30", symbol: "PAYTM.NS",
           hint: "Paytm IPO listing flop, 18 Nov 2021" } },
  { tokens: ["paytm", "listing"],
    out: { startIso: "2021-11-18", endIso: "2022-04-30", symbol: "PAYTM.NS",
           hint: "Paytm IPO listing flop, 18 Nov 2021" } },
  // Adani Hindenburg 2023
  { tokens: ["adani", "hindenburg"],
    out: { startIso: "2023-01-24", endIso: "2023-06-30", symbol: "ADANIENT.NS",
           hint: "Adani-Hindenburg report, 24 Jan 2023" } },
  { tokens: ["hindenburg"],
    out: { startIso: "2023-01-24", endIso: "2023-06-30", symbol: "ADANIENT.NS",
           hint: "Hindenburg report on Adani, 24 Jan 2023" } },
  { tokens: ["adani", "fpo"],
    out: { startIso: "2023-01-24", endIso: "2023-06-30", symbol: "ADANIENT.NS",
           hint: "Adani FPO cancellation, 1 Feb 2023" } },
  // Demonetisation 2016
  { tokens: ["demonetisation"],
    out: { startIso: "2016-11-08", endIso: "2017-02-28", symbol: "^NSEI",
           hint: "Demonetisation, 8 Nov 2016" } },
  { tokens: ["demonetization"],
    out: { startIso: "2016-11-08", endIso: "2017-02-28", symbol: "^NSEI",
           hint: "Demonetisation, 8 Nov 2016" } },
  { tokens: ["note", "band"],
    out: { startIso: "2016-11-08", endIso: "2017-02-28", symbol: "^NSEI",
           hint: "Note ban / Demonetisation, 8 Nov 2016" } },
  { tokens: ["notebandi"],
    out: { startIso: "2016-11-08", endIso: "2017-02-28", symbol: "^NSEI",
           hint: "Notebandi / Demonetisation, 8 Nov 2016" } },
  // Nirav Modi PNB fraud
  { tokens: ["nirav", "modi"],
    out: { startIso: "2018-02-14", endIso: "2018-06-30", symbol: "PNB.NS",
           hint: "Nirav Modi / PNB fraud, 14 Feb 2018" } },
  { tokens: ["pnb", "fraud"],
    out: { startIso: "2018-02-14", endIso: "2018-06-30", symbol: "PNB.NS",
           hint: "PNB fraud, 14 Feb 2018" } },
  // Reliance Jio launch
  { tokens: ["jio", "launch"],
    out: { startIso: "2016-09-05", endIso: "2017-01-31", symbol: "RELIANCE.NS",
           hint: "Reliance Jio launch, Sep 2016" } },
  // Pani puri vendor GST (well-known meme event)
  { tokens: ["pani", "puri"],
    out: { startIso: "2023-06-01", endIso: "2023-07-31", symbol: "^NSEI",
           hint: "Tamil Nadu pani puri vendor GST notice, June 2023" } },
  { tokens: ["golgappa"],
    out: { startIso: "2023-06-01", endIso: "2023-07-31", symbol: "^NSEI",
           hint: "Pani puri / golgappa GST notice, June 2023" } },
  { tokens: ["fuchka"],
    out: { startIso: "2023-06-01", endIso: "2023-07-31", symbol: "^NSEI",
           hint: "Fuchka / pani puri GST notice, June 2023" } },
  // Russia / Ukraine — Feb 2022 sell-off
  { tokens: ["russia", "ukraine"],
    out: { startIso: "2022-02-24", endIso: "2022-06-30", symbol: "^NSEI",
           hint: "Russia-Ukraine war shock, 24 Feb 2022" } },
  { tokens: ["ukraine", "invasion"],
    out: { startIso: "2022-02-24", endIso: "2022-06-30", symbol: "^NSEI",
           hint: "Ukraine invasion, 24 Feb 2022" } },
  // Brexit
  { tokens: ["brexit"],
    out: { startIso: "2016-06-23", endIso: "2016-09-30", symbol: "^NSEI",
           hint: "Brexit referendum, 23 June 2016" } },
  // 2G spectrum scam — A. Raja, CAG report Nov 2010, SC cancellation Feb 2012.
  // Hit telecom hardest. Bharti Airtel was the most-traded survivor; RCOM /
  // Tata Tele / Idea were impacted but RCOM is delisted. Use BHARTIARTL.NS.
  { tokens: ["2g", "scam"],
    out: { startIso: "2010-11-10", endIso: "2011-04-30", symbol: "BHARTIARTL.NS",
           hint: "2G spectrum scam, CAG report Nov 2010 → telecom sector wipe-out" } },
  { tokens: ["2g", "spectrum"],
    out: { startIso: "2010-11-10", endIso: "2011-04-30", symbol: "BHARTIARTL.NS",
           hint: "2G spectrum allocation scandal, Nov 2010" } },
  { tokens: ["raja", "telecom"],
    out: { startIso: "2010-11-10", endIso: "2011-04-30", symbol: "BHARTIARTL.NS",
           hint: "A. Raja telecom scam (2G spectrum), Nov 2010" } },
  // Coal scam — Coalgate, CAG report 2012
  { tokens: ["coal", "scam"],
    out: { startIso: "2012-08-17", endIso: "2013-01-31", symbol: "COALINDIA.NS",
           hint: "Coal allocation scam (Coalgate), CAG report Aug 2012" } },
  { tokens: ["coalgate"],
    out: { startIso: "2012-08-17", endIso: "2013-01-31", symbol: "COALINDIA.NS",
           hint: "Coalgate, Aug 2012" } },
  // Vijay Mallya / Kingfisher Airlines collapse, late 2012
  { tokens: ["mallya"],
    out: { startIso: "2012-10-01", endIso: "2013-03-31", symbol: "^NSEI",
           hint: "Vijay Mallya / Kingfisher Airlines collapse, Oct 2012" } },
  { tokens: ["kingfisher", "airlines"],
    out: { startIso: "2012-10-01", endIso: "2013-03-31", symbol: "^NSEI",
           hint: "Kingfisher Airlines grounded, Oct 2012" } },
  // SVB — March 2023
  { tokens: ["svb"],
    out: { startIso: "2023-03-08", endIso: "2023-05-31", symbol: "^NSEI",
           hint: "Silicon Valley Bank failure, 10 Mar 2023" } },
  { tokens: ["silicon", "valley", "bank"],
    out: { startIso: "2023-03-08", endIso: "2023-05-31", symbol: "^NSEI",
           hint: "SVB collapse, Mar 2023" } },
  // Trump tariffs — early 2025 sell-off
  { tokens: ["trump", "tariff"], year: "2025",
    out: { startIso: "2025-04-01", endIso: "2025-06-30", symbol: "^NSEI",
           hint: "Trump tariff war, Apr 2025" } },
  // BSE early days / "first opened" / Liberalisation-era boom
  // Range capped at 24 months (opHistory rejects > 2 years).
  { tokens: ["stock", "market", "first"],
    out: { startIso: "1990-04-01", endIso: "1992-03-31", symbol: "^BSESN",
           hint: "BSE Sensex early-1990s boom (curated archive)" } },
  { tokens: ["bse", "first"],
    out: { startIso: "1990-04-01", endIso: "1992-03-31", symbol: "^BSESN",
           hint: "BSE early-1990s, Liberalisation-era boom" } },
  { tokens: ["liberalisation"],
    out: { startIso: "1991-06-01", endIso: "1992-03-31", symbol: "^BSESN",
           hint: "1991 Liberalisation reforms, Sensex tripling" } },
  { tokens: ["liberalization"],
    out: { startIso: "1991-06-01", endIso: "1992-03-31", symbol: "^BSESN",
           hint: "1991 Liberalisation reforms, Sensex tripling" } },
  // Asian Financial Crisis 1997
  { tokens: ["asian", "crisis"],
    out: { startIso: "1997-06-01", endIso: "1998-09-30", symbol: "^BSESN",
           hint: "Asian Financial Crisis impact on Sensex, Jul 1997 onward" } },
  { tokens: ["asian", "financial", "crisis"],
    out: { startIso: "1997-06-01", endIso: "1998-09-30", symbol: "^BSESN",
           hint: "Asian Financial Crisis, Jul 1997" } },
  // 2004 Election Black Monday
  { tokens: ["election"], year: "2004",
    out: { startIso: "2004-04-15", endIso: "2004-09-30", symbol: "^BSESN",
           hint: "2004 General Election Black Monday — Sensex -11% intraday on May 17" } },
  { tokens: ["black", "monday"], year: "2004",
    out: { startIso: "2004-04-15", endIso: "2004-09-30", symbol: "^BSESN",
           hint: "Black Monday 2004 — UPA election shock" } },
  // Election day 2024 — June 4, NDA underperformed exit-poll → 6% intraday drop
  { tokens: ["election", "result"], year: "2024",
    out: { startIso: "2024-06-04", endIso: "2024-08-31", symbol: "^NSEI",
           hint: "2024 General Election results day shock, 4 Jun 2024" } },
  { tokens: ["election", "day"], year: "2024",
    out: { startIso: "2024-06-04", endIso: "2024-08-31", symbol: "^NSEI",
           hint: "2024 election results day, 4 Jun 2024" } },
];

function _routePhaseADeterministic(description) {
  // Reuse queryKey's tokenization for byte-identical input handling.
  const tokens = String(description || "")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return null;
  const tokSet = new Set(tokens);
  // Any 4-digit year tokens — used for the year-must-match guard. Year
  // range guard: 1900-2099 to filter out non-year 4-digit numbers.
  const yearsInInput = tokens.filter(t => /^[12]\d{3}$/.test(t));
  for (const entry of _PHASE_A_ALIASES) {
    // Every required token must be present.
    if (!entry.tokens.every(t => tokSet.has(t))) continue;
    // Year guard: if the entry pins a year AND the input has any year,
    // they must match. Lets bare "covid" hit, blocks "covid 2024".
    if (entry.year && yearsInInput.length && !yearsInInput.includes(entry.year)) continue;
    return { ...entry.out, offTopic: false };
  }
  return null;
}

// Each attempt tuple is [profile, temperature]. We lead with the json
// profile (Gemini 2.5 Flash — non-thinking, reliable structured output)
// because Gemini 3.x preview models burn so many tokens on internal
// reasoning that the JSON gets truncated mid-object. If the json attempts
// fail validation (rare — only on wildly ambiguous queries), we escalate
// to reasoning (Pro) with full thinking budget for the hard cases.
const ATTEMPTS = [
  { profile: "json",      temperature: 0.2  },
  { profile: "json",      temperature: 0.55 },
  { profile: "reasoning", temperature: 0.3  },
];

// Normalised query key used for dedup lookup + as a stable alias that points
// at whichever scenario id was generated for this query first. Mirrors the
// aggressive tokenise+sort used by queryHash so the local-cache lookup
// matches the same rephrasings the server-cache matches.
function queryKey(desc) {
  const tokens = String(desc || "")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return Array.from(new Set(tokens)).sort().join("_").slice(0, 120);
}

const QUERY_INDEX_STORAGE_KEY = "ss.customCrashes.queryIndex.v1";
function queryIndex() {
  try { return JSON.parse(localStorage.getItem(QUERY_INDEX_STORAGE_KEY) || "{}") || {}; }
  catch { return {}; }
}
function rememberQuery(key, scenarioId) {
  try {
    const idx = queryIndex();
    idx[key] = scenarioId;
    localStorage.setItem(QUERY_INDEX_STORAGE_KEY, JSON.stringify(idx));
  } catch {}
}

// Public: return scenario id for a query string if we've generated one before
// AND it still exists in the custom-crash cache. Lets the UI avoid calling
// the LLM twice for the same user query.
export function existingScenarioForQuery(description) {
  const key = queryKey(description);
  if (!key) return null;
  const id = queryIndex()[key];
  if (!id) return null;
  try {
    const all = JSON.parse(localStorage.getItem("ss.customCrashes.v1") || "{}");
    const scenario = all[id];
    if (!scenario) return null;
    // Version gate — same logic as cacheReplayGet. Old scenarios from a
    // previous prompt version (or no version stamp at all) are evicted
    // so the user gets a fresh generation against current router/prompts.
    if (scenario._promptVersion !== CURRENT_PROMPT_VERSION) {
      try {
        delete all[id];
        localStorage.setItem("ss.customCrashes.v1", JSON.stringify(all));
        const idx = queryIndex();
        delete idx[key];
        localStorage.setItem(QUERY_INDEX_STORAGE_KEY, JSON.stringify(idx));
      } catch {}
      return null;
    }
    return id;
  } catch { return null; }
}

// Stable SHA-256 of a normalised description. Used as the cross-user cache
// key AND as the deterministic suffix for the scenario id so the generated
// URL is stable for a given prompt — shareable, and identical across users.
//
// Normalisation is AGGRESSIVE on purpose: users rephrase ("Adani Hindenburg
// 2023" vs "Hindenburg 2023 Adani" vs "AdaniHindenburg2023" vs "adani-
// hindenburg 2023!") and without collapsing these we'd cache-miss on every
// rephrasing and burn LLM credits regenerating the same scenario.
//
// Strategy:
//   1. Split letter/digit runs ("hindenburg2023" → "hindenburg 2023")
//   2. Lowercase
//   3. Replace every non-alphanumeric run with a single space
//   4. Split into word-tokens, dedupe, sort alphabetically
//   5. Rejoin — word-order no longer matters, punctuation no longer matters
//
// Side effect: "Adani 2023" and "2023 Adani" hash the same (fine — same
// event). "Adani Enterprises IPO" vs "IPO Adani Enterprises" same. "Adani
// Hindenburg" vs "Hindenburg Adani" same. What they hash DIFFERENTLY from:
// queries that contain genuinely distinct words ("Adani IPO 2023" vs
// "Adani Hindenburg 2023") — which is correct, those are different events.
async function queryHash(desc) {
  const tokens = String(desc || "")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const canonical = Array.from(new Set(tokens)).sort().join(" ").slice(0, 400);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Prompt version — bump whenever PHASE1_PROMPT or SYSTEM_PROMPT changes
// MEANINGFULLY (a new required field, a fundamentally different output
// shape, a new colloquial map). Don't bump on comment edits or wording
// tweaks — the cache is huge and re-running pre-gen costs LLM credits.
//
// On bump: pre-gen rows with the OLD version are silently rejected by
// cacheReplayGet and the user falls through to live generation. Re-run
// scripts/pregen-crashes.mjs after the bump (which uses this same constant)
// to repopulate the top-10 with fresh-version rows. See PERF_AUDIT §4.
//
// Format: "v<major>.<YYYY-MM-DD>". Date helps debugging; major version
// helps coordinate breaking changes across the script + live code.
// v2 (2026-05-03): bumped after PERF_AUDIT router/race/trim/companion/stream
// PRs landed. Old v1 cache rows had wrong tickers (LLM picked RELINFRA for
// 2G scam, etc.) and pre-streaming-aware shape. Bumping invalidates all old
// rows in BOTH the cross-user Supabase cache AND the per-browser localStorage
// cache so users get a fresh generation against the current router + prompts.
export const CURRENT_PROMPT_VERSION = "v2.2026-05-03";

// Cross-user cache via /api/ai?op=cache-get|cache-put (Supabase-backed).
// Popular prompts get generated once, ever — the first user pays the LLM
// cost, everyone after that gets an instant hit on the same scenario, same
// stable URL. Fire-and-forget write — the UI never blocks on cache I/O.
//
// Version-gated: hits whose _promptVersion differs from CURRENT_PROMPT_VERSION
// fall through as cache misses. Lets us evolve prompts without tasting stale
// scenarios from old versions. Pre-gen scenarios from scripts/pregen-crashes.mjs
// stamp the same version so they hit; user-generated scenarios from a previous
// version naturally age out as the user re-queries.
async function cacheReplayGet(hash) {
  try {
    const res = await fetch(`/api/ai?op=cache-get&bucket=crash_replay&key=${encodeURIComponent(hash)}`);
    _perfServerTiming(res, "cache");
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.hit) return null;
    const payload = data.payload;
    // Version gate. Missing _promptVersion = pre-pregen cache, treat as stale
    // so the next request regenerates with the current prompt and stamps a
    // version on the way back into cache. This converges naturally without
    // a one-time migration.
    if (payload?._promptVersion !== CURRENT_PROMPT_VERSION) return null;
    return payload;
  } catch { return null; }
}
function cacheReplayPut(hash, description, payload) {
  try {
    // Stamp the version onto the payload BEFORE writing so the next reader
    // sees the version that produced it. Mutating in place is fine — caller
    // returns the same object to renderReplay, which doesn't read the field.
    if (payload && typeof payload === "object") {
      payload._promptVersion = CURRENT_PROMPT_VERSION;
    }
    fetch("/api/ai?op=cache-put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket: "crash_replay",
        key: hash,
        display: String(description || "").slice(0, 200),
        payload,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

export async function generateCustomCrash(description, opts = {}) {
  // PERF — start of cold-start clock. cc:first-paint fires from crashReplay.js
  // after the chart renders; cc:total measures the wall clock. See §1.
  _perfMark("cc:start");
  // PERF_AUDIT #4: optional onProgress callback so the UI can update the
  // status text as we move through phases — perceived-time win even though
  // wall-clock is unchanged. Stages: cache-check, phase-a, phase-b, phase-c,
  // phase-c-streaming.
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};

  // 0. Hard content filter — reject adult / vulgar / slur queries BEFORE
  //    any LLM call. These would either burn Gemini credits on junk or
  //    surface an inappropriate-looking replay. Rejection is friendly —
  //    we don't shame the user, just redirect them.
  if (isHardBlocked(description)) {
    const err = new Error("That isn't something I can turn into a market replay. Try a real event like 'Harshad Mehta 1992' or 'Adani Hindenburg 2023'.");
    err.kind = "not_a_crash";
    throw err;
  }

  // Stable hash of the prompt — serves as both the cross-user cache key and
  // the suffix of the scenario id, so the same prompt always yields the same
  // URL regardless of browser/device/user.
  const hash = await queryHash(description);

  // 1. Local dedup (same-browser instant reuse, survives cache-miss too).
  _perfMark("cc:local-start");
  const cachedId = existingScenarioForQuery(description);
  _perfMark("cc:local-end");
  _perfMeasure("cc:local-cache", "cc:local-start", "cc:local-end");
  if (cachedId) {
    try {
      const all = JSON.parse(localStorage.getItem("ss.customCrashes.v1") || "{}");
      if (all[cachedId]) return all[cachedId];
    } catch {}
  }

  // 2. Supabase cross-user cache RACED against Phase A (router → LLM).
  //    See PERF_AUDIT items #2 (router) + #3 (race) + #4 (onProgress).
  onProgress("cache-check");
  _perfMark("cc:cache-start");
  _perfMark("cc:phaseA-start");
  onProgress("phase-a");
  const phaseAAbort = new AbortController();
  const cachePromise = cacheReplayGet(hash);
  const routerBracket = _routePhaseADeterministic(description);
  // Router hit → no LLM needed; otherwise LLM in parallel with cache.
  const llmPromise = routerBracket
    ? Promise.resolve(routerBracket)
    : callLlmForBracket(description, phaseAAbort.signal).catch(e => ({ _err: e }));

  // Race for the cache-hit fast path.
  const winner = await Promise.race([
    cachePromise.then(c => ({ kind: "cache", value: c })),
    llmPromise.then(b => ({ kind: "llm", value: b })),
  ]);

  // Helper to apply a cache hit.
  const applyCacheHit = (cached) => {
    try {
      const all = JSON.parse(localStorage.getItem("ss.customCrashes.v1") || "{}");
      all[cached.id] = cached;
      localStorage.setItem("ss.customCrashes.v1", JSON.stringify(all));
    } catch {}
    rememberQuery(queryKey(description), cached.id);
  };

  if (winner.kind === "cache" && winner.value && winner.value.id && !winner.value.error) {
    // Cache won the race AND had a hit. Save Phase A LLM cost.
    phaseAAbort.abort();
    _perfMark("cc:cache-end");
    _perfMeasure("cc:cache-get", "cc:cache-start", "cc:cache-end");
    applyCacheHit(winner.value);
    return winner.value;
  }

  // Either cache missed OR Phase A finished first. Wait for both to settle.
  const [cached, bracketResult] = await Promise.all([cachePromise, llmPromise]);
  _perfMark("cc:cache-end");
  _perfMeasure("cc:cache-get", "cc:cache-start", "cc:cache-end");
  if (cached && cached.id && !cached.error) {
    phaseAAbort.abort();
    applyCacheHit(cached);
    return cached;
  }

  // 3. Cache miss → continue with Phase A bracket (router OR LLM).
  let lastErr = null;
  const bracket = bracketResult && !bracketResult._err ? bracketResult : null;
  _perfMark("cc:phaseA-end");
  _perfMeasure("cc:phaseA", "cc:phaseA-start", "cc:phaseA-end");
  if (!bracket) {
    throw new Error("Couldn't figure out the event's dates. Try a more specific phrasing, like 'Adani Hindenburg Jan 2023' or 'COVID March 2020'.");
  }
  // LLM's off-topic flag — catches adult/vulgar/zero-market queries that the
  // regex blocklist missed. Reject cleanly.
  if (bracket?.offTopic === true) {
    const err = new Error(`That doesn't fit a market replay. Try something like "${pickRandomExample()}".`);
    err.kind = "not_a_crash";
    throw err;
  }
  if (!bracket?.startIso || !bracket?.endIso) {
    throw new Error("Couldn't figure out the event's dates. Try a more specific phrasing.");
  }

  // Phase B: fetch real historical data in PARALLEL for the main symbol +
  // companion indices, so Phase C sees broader sector context (Bank Nifty
  // for bank events, Nifty IT for tech events, etc.). The primary symbol
  // is the source of truth for the chart; companions are context-only
  // and don't block rendering if they fail.
  // PERF_AUDIT #7: companions removed from the cold path. Saves 200-400 ms
  // by skipping sector-index fetches that only feed narrative colour.
  onProgress("phase-b");
  const primary = bracket.symbol || "^NSEI";
  _perfMark("cc:phaseB-start");
  let history = await fetchHistory(primary, bracket.startIso, bracket.endIso).catch(() => null);
  // Surface which source served Phase B (yahoo / fallback / cache) so the
  // generating-stage UI can show "via fallback" or similar in the stage
  // row's detail line. PERF_AUDIT #2 multi-source addition.
  if (history?.source) {
    onProgress("phase-b-source", {
      source: history.source,
      sources_tried: history.sources_tried || [],
      fallback_reason: history.fallback_reason || null,
    });
  }
  _perfMark("cc:phaseB-end");
  _perfMeasure("cc:phaseB", "cc:phaseB-start", "cc:phaseB-end");
  const companionHistory = [];
  // Fallback: if the LLM picked a specific ticker and Yahoo returned too little
  // data, retry with ^NSEI before giving up. This catches delisted-stock
  // events where the stock no longer exists on Yahoo (Satyam 2009 →
  // SATYAMCOMP.NS was absorbed by Tech Mahindra and is no longer queryable;
  // the Nifty 50 move on Raju's confession day IS captured in ^NSEI) and
  // tickers with non-standard Yahoo suffixes that we can't guess.
  if ((!history?.points?.length || history.points.length < 5) && primary !== "^NSEI") {
    const fallback = await fetchHistory("^NSEI", bracket.startIso, bracket.endIso).catch(() => null);
    if (fallback?.points?.length >= 5) {
      history = fallback;
      bracket.symbol = "^NSEI"; // propagate so the narrative references the right index
    }
  }
  if (!history?.points?.length || history.points.length < 5) {
    throw new Error("Not enough historical data for that range. Try a different event or check your date phrasing.");
  }

  // Real data gives us the hard truth about whether this was a crash or rally.
  const closes = history.points.map(p => p.c);
  const pointDates = history.points.map(p => p.d);
  const startIdx = closes[0];
  const troughIdx = Math.min(...closes);
  const endIdx = closes[closes.length - 1];
  const troughDayIdx = closes.indexOf(troughIdx);
  const realDropPct = ((troughIdx - startIdx) / startIdx) * 100;

  // If the real index went UP the whole time, this isn't a crash event.
  if (realDropPct >= -2) {
    const err = new Error(`Real market data for ${bracket.startIso} to ${bracket.endIso} doesn't show a notable drop (${realDropPct.toFixed(1)}%). Pick a real crash event like 'COVID March 2020' or 'Harshad Mehta 1992'.`);
    err.kind = "not_a_crash";
    throw err;
  }

  // PERF: Phase B is done — we have everything needed to draw the chart.
  // Build a stub scenario with REAL chart data + placeholder narrative,
  // and hand it to the caller via onChartReady. The caller can navigate
  // to the replay page immediately so the chart appears at ~1s instead
  // of ~5s. Phase C will return the full scenario; the caller patches
  // the live page when that resolves.
  if (typeof opts.onChartReady === "function") {
    try {
      const stubMeta = {
        title: bracket.hint
          ? bracket.hint.replace(/\.$/, "").slice(0, 50)
          : "Building event details…",
        startLabel: formatIsoToLabel(bracket.startIso),
        endLabel: formatIsoToLabel(bracket.endIso),
        description: "Pulling the narrative now — should land in a couple of seconds. The chart below is real data from Yahoo Finance.",
        totalDays: history.points.length,
        startIndex: Math.round(startIdx * 100) / 100,
        troughIndex: Math.round(troughIdx * 100) / 100,
        endIndex: Math.round(endIdx * 100) / 100,
        troughDay: troughDayIdx,
        indexDrop: Math.round(realDropPct * 10) / 10,
        recoveryDays: 0,
        panicDay: Math.min(3, history.points.length - 2),
        keyMoments: [
          { day: 0, label: "Start", narration: "" },
          { day: troughDayIdx, label: "Trough", narration: "" },
          { day: history.points.length - 1, label: "End of window", narration: "" },
        ],
        _realCloses: closes,
        _realDates: pointDates,
        _startIso: bracket.startIso,
      };
      const stubScenario = buildScenario(stubMeta, hash);
      stubScenario._partial = true;
      stubScenario._promptVersion = CURRENT_PROMPT_VERSION;
      try { opts.onChartReady(stubScenario); } catch {}
    } catch {}
  }

  // Phase C: generate narrative with real data in context
  onProgress("phase-c");
  for (const { profile, temperature } of ATTEMPTS) {
    try {
      _perfMark("cc:phaseC-start");
      const meta = await callLlmWithHistory(description, bracket, history, companionHistory, temperature, profile, onProgress);
      _perfMark("cc:phaseC-end");
      _perfMeasure("cc:phaseC", "cc:phaseC-start", "cc:phaseC-end");
      if (meta && meta.error === "not_a_crash") {
        const msg = typeof meta.message === "string" && meta.message.trim()
          ? meta.message.trim()
          : `That event wasn't a crash (real ${bracket.symbol} move was ${realDropPct.toFixed(1)}%). Try 'Harshad Mehta 1992' or 'Adani Hindenburg 2023'.`;
        const err = new Error(msg);
        err.kind = "not_a_crash";
        throw err;
      }
      // Overwrite any hallucinated numbers with the REAL ones. The LLM's
      // numbers are a sanity cross-check; the real-data numbers are truth.
      _perfMark("cc:parse-start");
      if (meta && typeof meta === "object") {
        meta.startIndex = Math.round(startIdx * 100) / 100;
        meta.troughIndex = Math.round(troughIdx * 100) / 100;
        meta.endIndex = Math.round(endIdx * 100) / 100;
        meta.troughDay = troughDayIdx;
        meta.totalDays = history.points.length;
        meta.indexDrop = Math.round(realDropPct * 10) / 10;
        meta.startLabel = meta.startLabel || formatIsoToLabel(bracket.startIso);
        meta.endLabel = meta.endLabel || formatIsoToLabel(bracket.endIso);
      }
      reshape(meta);
      const valid = validate(meta);
      _perfMark("cc:parse-end");
      _perfMeasure("cc:parse-validate", "cc:parse-start", "cc:parse-end");
      if (!valid.ok) { lastErr = valid.error; continue; }
      // Attach real daily closes so buildScenario can use them for the
      // day-by-day curve instead of interpolating.
      meta._realCloses = closes;
      meta._realDates = pointDates;
      meta._startIso = bracket.startIso;
      _perfMark("cc:build-start");
      const scenario = buildScenario(meta, hash);
      _perfMark("cc:build-end");
      _perfMeasure("cc:buildScenario", "cc:build-start", "cc:build-end");
      // Stamp the prompt version onto the local copy too — existingScenario-
      // ForQuery checks this on read so the local cache evicts old-version
      // scenarios the same way the cross-user cache does.
      scenario._promptVersion = CURRENT_PROMPT_VERSION;
      rememberQuery(queryKey(description), scenario.id);
      cacheReplayPut(hash, description, scenario);
      return scenario;
    } catch (e) {
      if (e?.kind === "not_a_crash") throw e;
      lastErr = e?.message || String(e);
    }
  }
  throw new Error(lastErr || "The coach couldn't build that one. Try rephrasing.");
}

function formatIsoToLabel(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch { return iso; }
}

const EXAMPLE_EVENTS = [
  "Harshad Mehta 1992",
  "Satyam scandal 2009",
  "Global Financial Crisis 2008",
  "COVID March 2020",
  "Demonetisation 2016",
  "YES Bank moratorium 2020",
  "Adani Hindenburg 2023",
  "Paytm IPO 2021",
  "Nirav Modi PNB fraud",
  "IL&FS collapse 2018",
];
function pickRandomExample() {
  return EXAMPLE_EVENTS[Math.floor(Math.random() * EXAMPLE_EVENTS.length)];
}

// Phase A: ask Gemini for the event's date range + target symbol.
// Optional AbortSignal lets the caller cancel a redundant LLM round-trip
// when the cross-user cache wins the race in generateCustomCrash (PERF #3).
// Aborted fetches throw an AbortError; the caller .catch()s it as _err.
async function callLlmForBracket(description, signal) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: PHASE1_PROMPT },
        { role: "user", content: String(description).trim().slice(0, 400) },
      ],
      temperature: 0.1,
      max_tokens: 200,
      response_format: { type: "json_object" },
      profile: "json",
    }),
    signal,
  });
  _perfServerTiming(res, "phaseA");
  if (!res.ok) throw new Error(`phase1_http_${res.status}`);
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  const parsed = parseJsonLoose(text);
  if (!parsed) throw new Error("phase1_non_json");
  // Normalise loose LLM outputs.
  // Dates: the prompt asks for YYYY-MM-DD but Gemini sometimes emits full
  // ISO-8601 with T00:00:00Z — just slice the date portion.
  if (typeof parsed.startIso === "string") parsed.startIso = parsed.startIso.slice(0, 10);
  if (typeof parsed.endIso === "string") parsed.endIso = parsed.endIso.slice(0, 10);
  // Symbol: must match Yahoo's ticker shape (letters/digits/caret/dot/dash).
  // "GST" or similar made-up strings → fall back to the index.
  const validSymbolRe = /^[A-Za-z0-9.\-\^]{1,24}$/;
  const knownSymbols = new Set(["^NSEI", "^BSESN", "^NSEBANK", "^CNXIT", "^CNXFMCG", "^CNXAUTO", "^CNXPHARMA"]);
  if (!parsed.symbol || typeof parsed.symbol !== "string" ||
      !validSymbolRe.test(parsed.symbol) ||
      // Single-word non-ticker like "GST", "NIFTY", "INDIA"
      (!knownSymbols.has(parsed.symbol) && !parsed.symbol.includes(".") && !parsed.symbol.startsWith("^"))) {
    parsed.symbol = "^NSEI";
  }
  // Date sanity
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.startIso || "")) throw new Error("phase1_bad_start");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.endIso || "")) throw new Error("phase1_bad_end");
  // Widen too-narrow ranges — a 30-day window is often too tight for a good
  // replay. Extend endIso by 60 days if < 30 trading days apart to give the
  // market time to show a full drawdown + partial recovery.
  const startMs = new Date(parsed.startIso).getTime();
  const endMs = new Date(parsed.endIso).getTime();
  if (!isNaN(startMs) && !isNaN(endMs) && endMs - startMs < 30 * 86400_000) {
    const wider = new Date(startMs + 90 * 86400_000);
    parsed.endIso = wider.toISOString().slice(0, 10);
  }
  return parsed;
}

// Phase B: fetch Yahoo historical data via our server-side proxy.
async function fetchHistory(symbol, fromIso, toIso) {
  const qs = `symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
  const res = await fetch(`/api/ai?op=history&${qs}`);
  _perfServerTiming(res, "phaseB");
  if (!res.ok) throw new Error(`history_http_${res.status}`);
  return await res.json();
}

// Mutate the raw LLM output into something the validator/builder can
// accept. LLMs tend to describe long-arc events with key moments that
// overflow the day window they pick — rather than reject, grow the
// window to fit the story (within our 140-day cap).
function reshape(m) {
  if (!m || typeof m !== "object") return;
  if (Array.isArray(m.keyMoments)) {
    let maxDay = 0;
    for (const km of m.keyMoments) {
      if (km && typeof km.day === "number" && km.day > maxDay) maxDay = km.day;
    }
    if (maxDay >= (m.totalDays ?? 0)) {
      m.totalDays = Math.min(MAX_DAYS, Math.max(m.totalDays || 0, maxDay + 3));
    }
  }
  if (typeof m.totalDays === "number") {
    m.totalDays = Math.max(10, Math.min(MAX_DAYS, Math.floor(m.totalDays)));
  }
  if (typeof m.troughDay === "number" && typeof m.totalDays === "number") {
    m.troughDay = Math.max(1, Math.min(m.totalDays - 1, Math.floor(m.troughDay)));
  }
}

// Robust JSON parser — handles Markdown code fences and leading/trailing
// prose that Gemini 3.x preview models sometimes emit despite response_format.
// Mirrors the server-side parseJsonLoose in api/ai.js.
function parseJsonLoose(text) {
  if (typeof text !== "string") return null;
  try { return JSON.parse(text); }
  catch {}
  // Try a ```json ... ``` fence first (most common model misbehaviour).
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch {}
  }
  // Last resort: biggest `{ ... }` substring we can find.
  const first = text.indexOf("{");
  const last  = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }
  return null;
}

// Pick companion symbols for richer sector context in Phase C. Doesn't
// change the chart — just feeds the LLM extra datapoints to draw on.
// Keep it to 2-3 max to keep prompt tokens reasonable.
function pickCompanionSymbols(primary, description) {
  const d = String(description || "").toLowerCase();
  const already = primary.toUpperCase();
  const want = new Set();
  // Always add Bank Nifty for the broadest "banks vs rest" signal.
  if (already !== "^NSEBANK") want.add("^NSEBANK");
  // IT events → Nifty IT
  if (/\b(it|infosys|tcs|wipro|hcl|tech|software)\b/.test(d)) want.add("^CNXIT");
  // FMCG / consumer events → Nifty FMCG
  if (/\b(fmcg|consumer|hindustan|itc|nestle|dabur|britannia|pani\s*puri|golgappa|fuchka)\b/.test(d)) want.add("^CNXFMCG");
  // Auto events → Nifty Auto
  if (/\b(auto|maruti|tata\s*motors|bajaj|hero|eicher|mahindra)\b/.test(d)) want.add("^CNXAUTO");
  // Pharma events → Nifty Pharma
  if (/\b(pharma|sun\s*pharma|cipla|dr\s*reddy|lupin)\b/.test(d)) want.add("^CNXPHARMA");
  // If primary is a specific stock, also pull the sector index above.
  // If primary is ^NSEI already, add ^BSESN for cross-check.
  if (primary === "^NSEI" && !want.has("^BSESN")) want.add("^BSESN");
  // Cap at 3 companions to keep Promise.all fast + prompt lean.
  return Array.from(want).slice(0, 3);
}

async function callLlmWithHistory(description, bracket, history, companionHistory, temperature, profile, onProgress) {
  const _progress = typeof onProgress === "function" ? onProgress : () => {};
  // Compose a compact, LLM-readable table of the real daily closes.
  const closes = history.points.map(p => p.c);
  const dates = history.points.map(p => p.d);
  const startIdx = closes[0];
  const troughIdx = Math.min(...closes);
  const endIdx = closes[closes.length - 1];
  const troughDayIdx = closes.indexOf(troughIdx);
  const realDropPct = ((troughIdx - startIdx) / startIdx) * 100;
  // Pack ~30 sampled points to keep context small (full array can be 140+).
  const step = Math.max(1, Math.floor(closes.length / 30));
  const sample = [];
  for (let i = 0; i < closes.length; i += step) {
    sample.push(`${i}=${dates[i]}@${Math.round(closes[i] * 100) / 100}`);
  }
  if (sample[sample.length - 1]?.startsWith(`${closes.length - 1}=`) === false) {
    sample.push(`${closes.length - 1}=${dates[closes.length - 1]}@${Math.round(endIdx * 100) / 100}`);
  }
  const factsBlock = [
    `SYMBOL: ${history.symbol}`,
    `DATE RANGE: ${dates[0]} to ${dates[dates.length - 1]}`,
    `TOTAL TRADING DAYS: ${closes.length}`,
    `START CLOSE: ${Math.round(startIdx * 100) / 100} (day 0)`,
    `TROUGH CLOSE: ${Math.round(troughIdx * 100) / 100} (day ${troughDayIdx}, ${dates[troughDayIdx]})`,
    `END CLOSE: ${Math.round(endIdx * 100) / 100} (day ${closes.length - 1})`,
    `REAL DROP: ${realDropPct.toFixed(2)}% from start to trough`,
    `SAMPLED CLOSES (day=date@price): ${sample.join(", ")}`,
    `LLM-IDENTIFIED EVENT: ${bracket.hint || "unknown"}`,
  ].join("\n");
  // Tack on companion-symbol context so the LLM can write narration that
  // references sector relativity (e.g. "banks fell 12% while IT held").
  let companionBlock = "";
  if (companionHistory && companionHistory.length) {
    companionBlock = "\n\nCOMPANION SYMBOLS (for sector context only, NOT the chart):\n" + companionHistory.map(h => {
      const cc = h.points.map(p => p.c);
      const s = cc[0];
      const t = Math.min(...cc);
      const e = cc[cc.length - 1];
      const dp = ((t - s) / s) * 100;
      return `  ${h.symbol}: ${s.toFixed(0)} → trough ${t.toFixed(0)} → ${e.toFixed(0)} (drop ${dp.toFixed(2)}%)`;
    }).join("\n");
  }
  const userMsg = `Event description from user: "${String(description).trim().slice(0, 400)}"\n\nREAL MARKET DATA (use these exact numbers, not your memory):\n${factsBlock}${companionBlock}`;
  // PERF_AUDIT #4: Phase C uses SSE streaming so we can fire a progress
  // callback the moment the upstream starts emitting tokens (TTFT,
  // typically ~700 ms before the full response). The UI uses this to
  // change the status text from "Building scenario..." to "Writing
  // narrative..." — a perceived-time win even though wall-clock to
  // valid JSON is unchanged. The accumulated text is parsed AFTER the
  // stream ends with the same parseJsonLoose path as before; no
  // incremental parsing (incremental would need a streaming JSON
  // parser, which is out of scope for this PR).
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      temperature,
      // PERF_AUDIT #5: capped 2000 -> 1200 after measuring actual output.
      // Longest observed JSON across the §4 top-10 events was 893 tokens
      // (Adani Hindenburg with 7 keyMoments). 1200 leaves ~33% headroom.
      // Gemini Flash Lite reserves wall-clock budget proportional to
      // max_tokens — a 2000-cap request is ~350 ms slower than a
      // 1200-cap request for the SAME ~700-token response. If a future
      // SYSTEM_PROMPT change pushes output past 1100 tokens, bump this
      // AND add a regression assertion in scripts/pregen-crashes.mjs.
      max_tokens: 1200,
      response_format: { type: "json_object" },
      profile,
      stream: true,
    }),
  });
  _perfServerTiming(res, "phaseC");
  if (!res.ok) {
    // Translate HTTP failures into user-facing, jargon-free messages.
    // The UI never mentions API, keys, tokens, settings, or providers —
    // the user should never think about infrastructure.
    if (res.status === 429) {
      throw new Error("The coach is a bit overloaded right now. Try again in a few minutes, or pick one of the curated replays below.");
    }
    if (res.status === 403) {
      throw new Error("Couldn't reach the coach from this page. Try refreshing.");
    }
    if (res.status >= 500) {
      throw new Error("The coach hiccuped on our side. Try again in a moment.");
    }
    throw new Error("The coach couldn't build that one. Try a different phrasing or a curated replay.");
  }
  // SSE stream consumer. Each chunk is a "data: {json}\n\n" line in
  // OpenAI-compat format. We accumulate the .delta.content fragments
  // into a single string. Fires the progress callback on first byte
  // (perceived-time win) and on every chunk with the partial accumulated
  // text (so the UI can extract title / description as JSON keys close).
  const text = await _consumeSseStream(
    res,
    () => _progress("phase-c-streaming"),
    (acc) => _progress("phase-c-chunk", acc)
  );
  if (!text) throw new Error("The coach returned an empty answer. Try again.");
  const meta = parseJsonLoose(text);
  if (!meta) throw new Error("The coach's answer didn't parse cleanly. Try again or rephrase.");
  return meta;
}

// Read an SSE "data: ..." stream from /api/chat and accumulate the
// concatenated content. Calls onFirstByte exactly once when the first
// non-empty data: chunk is seen, and onChunk(acc) on every chunk — the
// caller can use the accumulated text to show real-time progress in the
// UI (e.g. extract the JSON 'title' field as soon as it parses, render
// a token counter, etc.). Falls back gracefully if the response turns
// out to be plain JSON (chat.js can disable streaming when tools are
// present).
async function _consumeSseStream(res, onFirstByte, onChunk) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  // Non-streaming fallback: chat.js returned JSON despite stream:true.
  if (!ct.includes("text/event-stream")) {
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content || "";
    if (text && typeof onFirstByte === "function") { try { onFirstByte(); } catch {} }
    if (text && typeof onChunk === "function") { try { onChunk(text); } catch {} }
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let firstSent = false;
  let buf = "";
  let acc = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE framing: events separated by blank lines. Each event has
    // one or more "field: value" lines. We only care about "data:".
    let idx;
    let accChanged = false;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          const delta = obj?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            if (!firstSent) {
              firstSent = true;
              try { onFirstByte && onFirstByte(); } catch {}
            }
            acc += delta;
            accChanged = true;
          }
        } catch {
          // Ignore malformed chunks — the next one usually parses.
        }
      }
    }
    if (accChanged && typeof onChunk === "function") {
      try { onChunk(acc); } catch {}
    }
  }
  return acc;
}

function validate(m) {
  if (!m || typeof m !== "object") return { ok: false, error: "not an object" };
  const must = ["title", "startLabel", "endLabel", "description", "totalDays",
                "startIndex", "troughIndex", "troughDay", "endIndex", "indexDrop",
                "recoveryDays", "panicDay", "keyMoments"];
  for (const k of must) if (m[k] == null) return { ok: false, error: `missing ${k}` };
  const n = (v) => typeof v === "number" && Number.isFinite(v);
  if (!n(m.totalDays) || m.totalDays < 10 || m.totalDays > MAX_DAYS)
    return { ok: false, error: "totalDays out of [10,140]" };
  if (!n(m.startIndex) || m.startIndex <= 0) return { ok: false, error: "bad startIndex" };
  if (!n(m.troughIndex) || m.troughIndex <= 0) return { ok: false, error: "bad troughIndex" };
  if (!n(m.endIndex) || m.endIndex <= 0) return { ok: false, error: "bad endIndex" };
  if (m.troughIndex >= m.startIndex) return { ok: false, error: "trough must be below start" };
  if (!n(m.troughDay) || m.troughDay < 1 || m.troughDay >= m.totalDays)
    return { ok: false, error: "troughDay out of range" };
  if (!n(m.indexDrop) || m.indexDrop >= 0 || m.indexDrop < -95)
    return { ok: false, error: "bad indexDrop" };
  if (!Array.isArray(m.keyMoments) || m.keyMoments.length < 2)
    return { ok: false, error: "need ≥ 2 keyMoments" };
  for (const km of m.keyMoments) {
    if (!n(km?.day)) return { ok: false, error: "keyMoment missing day" };
    if (!km?.label || !km?.narration)
      return { ok: false, error: "keyMoment missing label/narration" };
  }
  return { ok: true };
}

// Convert validated metadata into a scenario that matches the shape the
// replay UI already expects (same as entries in data/crashes.js).
function buildScenario(m, hash) {
  const panicDay = Math.max(1, Math.min(Math.floor(m.panicDay ?? 3), m.totalDays - 1));
  const frames = [];
  const narrations = {};
  // If Phase B produced a real close-price array, use it verbatim. Every
  // frame's Nifty value is a real Yahoo close, not an interpolated curve.
  // Falls back to interpIndex only if real data isn't available (never
  // happens in the new flow but kept for defensive backcompat).
  const realCloses = Array.isArray(m._realCloses) ? m._realCloses : null;

  for (let i = 0; i < m.totalDays; i++) {
    const niftyLevel = realCloses && realCloses[i] != null
      ? realCloses[i]
      : interpIndex(i, m);
    const panicNiftyLevel = realCloses && realCloses[panicDay] != null
      ? realCloses[panicDay]
      : interpIndex(panicDay, m);
    const heldPortfolio = Math.round(100000 * (niftyLevel / m.startIndex));
    const panicPortfolio = i < panicDay
      ? heldPortfolio
      : Math.round(100000 * (panicNiftyLevel / m.startIndex));
    const f = { day: i, nifty: Math.round(niftyLevel), held: heldPortfolio, panic: panicPortfolio };
    frames.push(f);
  }

  // Sort key moments by day + dedupe on day (prefer first), then attach.
  // Clamp any day that crept outside the window — reshape() should have
  // grown totalDays to fit, but defend just in case the LLM reshuffled.
  const seenDays = new Set();
  const cleanMoments = m.keyMoments
    .map(km => ({
      ...km,
      day: Math.max(0, Math.min(m.totalDays - 1, Math.floor(km.day))),
    }))
    .filter(km => {
      if (seenDays.has(km.day)) return false;
      seenDays.add(km.day);
      return true;
    })
    .sort((a, b) => a.day - b.day);

  for (const km of cleanMoments) {
    const key = "n_custom_" + km.day;
    narrations[key] = km.narration;
    if (frames[km.day]) frames[km.day].n = key;
  }

  const startHeld = frames[0].held;
  const endHeld = frames[frames.length - 1].held;
  const endPanic = frames[frames.length - 1].panic;
  const finalDelta = ((endHeld - endPanic) / endPanic) * 100;

  // Deterministic id — same prompt → same hash → same id → same shareable URL.
  // Falls back to a timestamp only if hash wasn't supplied (shouldn't happen in
  // the real flow; defensive default to preserve old callers).
  const idSuffix = hash ? hash.slice(0, 12) : Date.now().toString(36);
  const id = "CUSTOM_" + slugify(m.title) + "_" + idSuffix;
  return {
    id,
    title: String(m.title).slice(0, 80),
    subtitle: `${m.startLabel} – ${m.endLabel}`,
    description: String(m.description).slice(0, 2000),
    startLabel: m.startLabel,
    endLabel: m.endLabel,
    finalDelta: Math.round(finalDelta * 10) / 10,
    heldEnd: endHeld,
    panicEnd: endPanic,
    indexDrop: Math.round(m.indexDrop * 10) / 10,
    recoveryDays: Math.max(0, Math.floor(m.recoveryDays ?? 0)),
    frames,
    narrations,
    // Real trading date of each frame (the replay's date flip shows them).
    // Absent on replays cached before 2026-10-01; the UI falls back to days.
    dates: Array.isArray(m._realDates) && m._realDates.length === frames.length ? m._realDates : undefined,
    isCustom: true,
  };
}

// Piecewise curve from day 0 → trough → end. Decline is slightly convex
// (panic accelerates), recovery is concave (slows down near the top).
// No randomness — output is deterministic for a given metadata set, which
// matters for reproducibility in the replay.
function interpIndex(day, m) {
  if (day <= 0) return m.startIndex;
  if (day >= m.totalDays - 1) return m.endIndex;
  if (day <= m.troughDay) {
    const t = day / m.troughDay;
    const frac = Math.pow(t, 1.4);
    return m.startIndex + (m.troughIndex - m.startIndex) * frac;
  } else {
    const t = (day - m.troughDay) / (m.totalDays - 1 - m.troughDay);
    const frac = Math.sqrt(t);
    return m.troughIndex + (m.endIndex - m.troughIndex) * frac;
  }
}

function slugify(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 24).replace(/^_+|_+$/g, "") || "X";
}
