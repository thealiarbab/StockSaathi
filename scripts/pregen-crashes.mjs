#!/usr/bin/env node
/**
 * pregen-crashes.mjs — pre-generate the top-10 crash-replay scenarios.
 *
 * Run when:
 *   1. After initial deploy of the perf/03-pregen-top10 PR (one-shot).
 *   2. Any time CURRENT_PROMPT_VERSION bumps in customCrash.js (re-run).
 *   3. After Supabase ai_response_cache table is wiped or migrated.
 *
 * What it does:
 *   For each of the top-10 well-known Indian market events, runs the
 *   identical three-phase generation flow that customCrash.js runs in
 *   the browser, and writes the result to the shared crash_replay
 *   bucket via /api/ai?op=cache-put. The next user who types any of
 *   these phrasings hits the cache instead of paying for a 5–6 s LLM
 *   round-trip. See PERF_AUDIT §1 (item #1) and §4.
 *
 * Why a Node script (not a button in admin.js):
 *   - Reproducible: CI can run it, no manual click-through.
 *   - Fail-fast: any single event that errors gets reported; partial
 *     progress is preserved in cache.
 *   - Service-role-safe: hits the live /api/ai?op=cache-put which uses
 *     SUPABASE_SERVICE_ROLE_KEY server-side, bypassing RLS.
 *
 * Why the prompts are duplicated below (not imported):
 *   customCrash.js is a browser ES module (no package.json type:module
 *   in app/), so importing its top-level prompt strings from a Node
 *   .mjs script doesn't work cleanly. The prompts and queryHash are
 *   inlined here with a "MUST stay in sync" comment. On every prompt
 *   bump in customCrash.js, mirror the change here AND bump
 *   CURRENT_PROMPT_VERSION in both files. The version gate in
 *   cacheReplayGet then evicts old pre-gen rows naturally.
 *
 * Run:
 *   node scripts/pregen-crashes.mjs                    # against prod
 *   node scripts/pregen-crashes.mjs --base http://localhost:7348
 *   node scripts/pregen-crashes.mjs --only "covid"      # one event
 *   node scripts/pregen-crashes.mjs --dry-run           # don't cache-put
 *
 * No external deps — Node 18+ built-in fetch + crypto.subtle.
 */

import crypto from "node:crypto";

// MUST stay in sync with js/features/customCrash.js CURRENT_PROMPT_VERSION.
// See the constant's comment in customCrash.js for bump rules.
const CURRENT_PROMPT_VERSION = "v2.2026-05-03";

// MUST stay in sync with js/features/customCrash.js PHASE1_PROMPT.
const PHASE1_PROMPT = `You are Saathi's historical-event-date picker for Indian markets. Given a free-form description of any Indian market event — even COLLOQUIAL, MIS-SPELT, or HINDI-INFLECTED references — identify the real event and return ONLY JSON:
{
  "startIso": "<YYYY-MM-DD — first trading day of the event>",
  "endIso":   "<YYYY-MM-DD — last day of the recovery/stabilisation window to plot, max 140 trading days after startIso>",
  "symbol":   "^NSEI" | "^BSESN" | "<any NSE ticker>.NS",
  "hint":     "<one-sentence identification of which actual event this refers to, INCLUDING the colloquial-to-formal mapping if relevant>",
  "offTopic": <true only if the query is adult content, vulgar, or has absolutely zero connection to Indian markets/business/policy>
}

Rules:
- startIso MUST be before endIso. Window 10-140 trading days.
- If the event affected a specific stock more than the index, set symbol to that ticker. Otherwise default to ^NSEI.
- Return ONLY the JSON. No prose, no code fences.`;

// MUST stay in sync with js/features/customCrash.js SYSTEM_PROMPT.
const SYSTEM_PROMPT = `You are a financial-history reconstructor for Indian markets. You are given REAL daily closing-price data from Yahoo Finance for the event's date range. Use the real numbers — do NOT hallucinate alternatives.

YOUR DEFAULT IS TO BUILD, NOT REFUSE. If the real data shows the index WENT UP, return: { "error": "not_a_crash", "message": "<one sentence>" }

Otherwise return a JSON object with this EXACT shape:

{
  "title": "<short event name, ≤ 50 chars>",
  "startLabel": "<human-readable start date>",
  "endLabel": "<human-readable end date>",
  "description": "<rich 120-220 word explanation in 2-3 paragraphs>",
  "totalDays": <integer 20..120>,
  "startIndex": <number, day 0 close>,
  "troughIndex": <number, lowest close>,
  "troughDay": <integer, day offset of trough>,
  "endIndex": <number, last close>,
  "indexDrop": <negative number, % drop from start to trough>,
  "recoveryDays": <integer, trading days from trough to a new ATH within window>,
  "panicDay": <integer, typically 3>,
  "keyMoments": [
    { "day": <integer>, "label": "<≤ 24 char>", "narration": "<1-2 sentence>" }
  ]
}

Rules:
- Return ONLY the JSON. No prose, no code fences.
- All numbers come from the REAL data — no fabrication.
- 4 to 7 keyMoments whose "day" maps to actual indices in the data array.
- Every cited price is a CLOSING price; phrase as "closes at ₹X" / "closed at ₹X". NEVER write "opens at" / "opening price".`;

// Top 10 — canonical phrasings + their date brackets. The script trusts
// these brackets directly and skips the Phase A LLM call (the audit's
// item #2 codifies this for the live path; here we hardcode for pregen
// determinism).
const EVENTS = [
  { phrase: "Harshad Mehta 1992",            startIso: "1992-04-01", endIso: "1992-08-31", symbol: "^BSESN" },
  { phrase: "Dot Com 2000",                  startIso: "2000-03-13", endIso: "2000-06-30", symbol: "^NSEI"  },
  { phrase: "Global Financial Crisis 2008",  startIso: "2008-09-15", endIso: "2009-03-31", symbol: "^NSEI"  },
  { phrase: "Satyam scandal 2009",           startIso: "2009-01-07", endIso: "2009-04-30", symbol: "^NSEI"  },
  { phrase: "IL&FS collapse 2018",           startIso: "2018-09-04", endIso: "2019-01-31", symbol: "^NSEI"  },
  { phrase: "DHFL crisis 2019",              startIso: "2019-06-04", endIso: "2019-12-31", symbol: "DHFL.NS" },
  { phrase: "YES Bank moratorium 2020",      startIso: "2020-03-05", endIso: "2020-07-31", symbol: "YESBANK.NS" },
  { phrase: "COVID March 2020",              startIso: "2020-02-20", endIso: "2020-08-31", symbol: "^NSEI"  },
  { phrase: "Paytm IPO Nov 2021",            startIso: "2021-11-18", endIso: "2022-04-30", symbol: "PAYTM.NS" },
  { phrase: "Adani Hindenburg Jan 2023",     startIso: "2023-01-24", endIso: "2023-06-30", symbol: "ADANIENT.NS" },
];

// Hash + scenario shape. MUST stay in sync with customCrash.js queryHash
// and buildScenario, otherwise the cache-key collision and cache-payload
// shape both break.
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

function slugify(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 24).replace(/^_+|_+$/g, "") || "X";
}

function formatIsoToLabel(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch { return iso; }
}

// Reconstruct buildScenario — same shape customCrash.js writes so
// renderReplay can consume the cached payload directly.
function buildScenario(meta, hash, realCloses, startIso) {
  const panicDay = Math.max(1, Math.min(Math.floor(meta.panicDay ?? 3), meta.totalDays - 1));
  const frames = [];
  const narrations = {};
  for (let i = 0; i < meta.totalDays; i++) {
    const niftyLevel = realCloses[i] != null ? realCloses[i] : meta.startIndex;
    const panicNiftyLevel = realCloses[panicDay] != null ? realCloses[panicDay] : meta.startIndex;
    const heldPortfolio = Math.round(100000 * (niftyLevel / meta.startIndex));
    const panicPortfolio = i < panicDay
      ? heldPortfolio
      : Math.round(100000 * (panicNiftyLevel / meta.startIndex));
    frames.push({ day: i, nifty: Math.round(niftyLevel), held: heldPortfolio, panic: panicPortfolio });
  }
  const seenDays = new Set();
  const cleanMoments = (meta.keyMoments || [])
    .map(km => ({ ...km, day: Math.max(0, Math.min(meta.totalDays - 1, Math.floor(km.day))) }))
    .filter(km => { if (seenDays.has(km.day)) return false; seenDays.add(km.day); return true; })
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
  const idSuffix = hash ? hash.slice(0, 12) : Date.now().toString(36);
  return {
    id: "CUSTOM_" + slugify(meta.title) + "_" + idSuffix,
    title: String(meta.title).slice(0, 80),
    subtitle: `${meta.startLabel} – ${meta.endLabel}`,
    description: String(meta.description).slice(0, 2000),
    startLabel: meta.startLabel,
    endLabel: meta.endLabel,
    finalDelta: Math.round(finalDelta * 10) / 10,
    heldEnd: endHeld,
    panicEnd: endPanic,
    indexDrop: Math.round(meta.indexDrop * 10) / 10,
    recoveryDays: Math.max(0, Math.floor(meta.recoveryDays ?? 0)),
    frames,
    narrations,
    isCustom: true,
    _promptVersion: CURRENT_PROMPT_VERSION,
  };
}

function parseJsonLoose(text) {
  if (typeof text !== "string") return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  const f = text.indexOf("{"), l = text.lastIndexOf("}");
  if (f >= 0 && l > f) { try { return JSON.parse(text.slice(f, l + 1)); } catch {} }
  return null;
}

// CLI
const args = process.argv.slice(2);
function flag(name, def = null) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  return args[i + 1] ?? true;
}
const BASE = String(flag("base", "https://stocksaathi.co.in")).replace(/\/$/, "");
// cache-put only accepts a signed-in user or the admin token.
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
const ONLY = flag("only", null);
const DRY  = flag("dry-run", false) === true || flag("dry-run", false) === "true";
if (!DRY && !ADMIN_TOKEN) {
  console.error("Set ADMIN_TOKEN (same value as on Vercel) to write the cache, or pass --dry-run.");
  process.exit(1);
}

console.log(`Pre-generating crash replays against ${BASE} (version ${CURRENT_PROMPT_VERSION})`);
if (DRY) console.log("DRY RUN — will not write to cache");

let okCount = 0;
let skipCount = 0;
let errCount = 0;

for (const ev of EVENTS) {
  if (ONLY && !ev.phrase.toLowerCase().includes(String(ONLY).toLowerCase())) continue;

  const hash = await queryHash(ev.phrase);
  process.stdout.write(`  [${ev.phrase.padEnd(38)}] hash=${hash.slice(0, 12)}… `);

  // Skip if already cached at this version.
  try {
    const r = await fetch(`${BASE}/api/ai?op=cache-get&bucket=crash_replay&key=${encodeURIComponent(hash)}`);
    if (r.ok) {
      const data = await r.json();
      if (data?.hit && data?.payload?._promptVersion === CURRENT_PROMPT_VERSION) {
        console.log("ALREADY-CACHED");
        skipCount++;
        continue;
      }
    }
  } catch {}

  // Phase B: fetch real history (skip Phase A — we already know the dates).
  let history;
  try {
    const qs = `symbol=${encodeURIComponent(ev.symbol)}&from=${encodeURIComponent(ev.startIso)}&to=${encodeURIComponent(ev.endIso)}`;
    const hr = await fetch(`${BASE}/api/ai?op=history&${qs}`);
    if (!hr.ok) throw new Error(`history_${hr.status}`);
    history = await hr.json();
    if (!history?.points?.length || history.points.length < 5) {
      // Fallback to ^NSEI for delisted/missing tickers (e.g. SATYAMCOMP).
      const qs2 = `symbol=^NSEI&from=${encodeURIComponent(ev.startIso)}&to=${encodeURIComponent(ev.endIso)}`;
      const hr2 = await fetch(`${BASE}/api/ai?op=history&${qs2}`);
      if (!hr2.ok) throw new Error(`history_fallback_${hr2.status}`);
      history = await hr2.json();
      ev.symbol = "^NSEI";
    }
    if (!history?.points?.length) throw new Error("no_history");
  } catch (e) {
    console.log(`HISTORY-FAIL (${e.message})`);
    errCount++;
    continue;
  }

  const closes = history.points.map(p => p.c);
  const dates = history.points.map(p => p.d);
  const startIdx = closes[0];
  const troughIdx = Math.min(...closes);
  const endIdx = closes[closes.length - 1];
  const troughDayIdx = closes.indexOf(troughIdx);
  const realDropPct = ((troughIdx - startIdx) / startIdx) * 100;

  if (realDropPct >= -2) {
    console.log(`NOT-A-CRASH (real move ${realDropPct.toFixed(1)}%)`);
    errCount++;
    continue;
  }

  // Phase C: narrative
  const step = Math.max(1, Math.floor(closes.length / 30));
  const sample = [];
  for (let i = 0; i < closes.length; i += step) {
    sample.push(`${i}=${dates[i]}@${Math.round(closes[i] * 100) / 100}`);
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
  ].join("\n");
  const userMsg = `Event description from user: "${ev.phrase}"\n\nREAL MARKET DATA (use these exact numbers, not your memory):\n${factsBlock}`;

  let meta = null;
  for (const temperature of [0.2, 0.55]) {
    try {
      const cr = await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Origin": "https://stocksaathi.co.in" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMsg },
          ],
          temperature,
          max_tokens: 2000,
          response_format: { type: "json_object" },
          profile: "json",
        }),
      });
      if (!cr.ok) continue;
      const body = await cr.json();
      const text = body?.choices?.[0]?.message?.content;
      const parsed = parseJsonLoose(text);
      if (parsed && !parsed.error) { meta = parsed; break; }
    } catch {}
  }
  if (!meta) {
    console.log("PHASE-C-FAIL");
    errCount++;
    continue;
  }

  // Overwrite hallucinated numbers with real ones (same as customCrash.js).
  meta.startIndex = Math.round(startIdx * 100) / 100;
  meta.troughIndex = Math.round(troughIdx * 100) / 100;
  meta.endIndex = Math.round(endIdx * 100) / 100;
  meta.troughDay = troughDayIdx;
  meta.totalDays = history.points.length;
  meta.indexDrop = Math.round(realDropPct * 10) / 10;
  meta.startLabel = meta.startLabel || formatIsoToLabel(ev.startIso);
  meta.endLabel = meta.endLabel || formatIsoToLabel(ev.endIso);

  const scenario = buildScenario(meta, hash, closes, ev.startIso);

  if (DRY) {
    console.log(`DRY-OK (id=${scenario.id}, ${scenario.frames.length} frames)`);
    okCount++;
    continue;
  }

  // Cache write.
  try {
    const pr = await fetch(`${BASE}/api/ai?op=cache-put`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({
        bucket: "crash_replay",
        key: hash,
        display: ev.phrase.slice(0, 200),
        payload: scenario,
      }),
    });
    if (!pr.ok) throw new Error(`put_${pr.status}`);
    console.log(`OK (id=${scenario.id})`);
    okCount++;
  } catch (e) {
    console.log(`PUT-FAIL (${e.message})`);
    errCount++;
  }
}

console.log(`\nPre-gen complete: ${okCount} written, ${skipCount} already-cached, ${errCount} errors`);
process.exit(errCount > 0 ? 1 : 0);
