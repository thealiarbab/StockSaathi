// =============================================================================
// /api/ai  —  Consolidated router for every AI feature in StockSaathi.
//
// Why one file: Vercel Hobby tier caps at 12 functions; shipping each AI
// surface as its own endpoint blew past that. This router keeps every
// feature inside one Edge function, sharing the LLM call + cache helpers
// in-process. Also eliminates the internal-fetch 401 we were hitting
// when child endpoints called /api/chat through VERCEL_URL (deployment-
// protection wall).
//
// Dispatch: GET/POST /api/ai?op=<name>
//   op=cache-get          GET  { bucket, key }            -> { payload|null, hit }
//   op=cache-put          POST { bucket, key, display, payload } -> { ok }
//   op=explain            GET  { term }                   -> { explanation, source }
//   op=news-tldr          POST { headline, source, symbols } -> { sentiment, tldr, source }
//   op=portfolio-digest   POST { totalRupees, deltaPct, cashRupees, holdings } -> { narrative, mood }
//   op=stock-why          POST { symbol, name, sector, pricePaise, changePct, newsItems } -> { explanation }
//   op=trade-nudge        POST { action, symbol, name, sector, qty, priceRupees, portfolio } -> { nudge, severity }
//   op=market-mood        POST { sectors, asOf }          -> { narrative, temperature }
//   op=market-search      POST { query, candidates }      -> { matches, rationale }
//   op=report-card        POST { totalTrades, winRate, biggestWin, biggestLoss, avgHoldDays, biasFlags, portfolioReturnPct, topSectors, startedAt } -> { narrative, strengths, watchouts }
//   op=crash-suggestions  GET                             -> { suggestions }
//   op=command            POST { query, context }         -> { action, response, target?, query?, symbol?, side?, qty? }
// =============================================================================

export const config = { runtime: "edge" };

const MAX_BODY = 128 * 1024;

// -----------------------------------------------------------------------------
// CORS + response helpers
// -----------------------------------------------------------------------------
function allowed(origin) {
  if (!origin) return null;
  const s = new Set([
    "https://stocksaathi.co.in",
    "https://www.stocksaathi.co.in",
    "http://localhost:7348",
    "http://127.0.0.1:7348",
  ]);
  if (s.has(origin)) return origin;
  if (origin.startsWith("https://") && origin.endsWith(".vercel.app")) return origin;
  return null;
}
function cors(origin, noStore = true) {
  const h = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": noStore ? "no-store" : "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
  });
  const a = allowed(origin);
  if (a) { h.set("Access-Control-Allow-Origin", a); h.set("Vary", "Origin"); }
  return h;
}
function j(status, body, origin, noStore = true, extraHeaders = null) {
  const h = cors(origin, noStore);
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v != null) h.set(k, String(v));
    }
    // Make Server-Timing readable cross-origin so devtools shows it on
    // .vercel.app preview deployments and future split-origin setups.
    if ("Server-Timing" in extraHeaders) {
      h.set("Access-Control-Expose-Headers", "Server-Timing");
    }
  }
  return new Response(JSON.stringify(body), { status, headers: h });
}

// -----------------------------------------------------------------------------
// Supabase cache  (bucket + key -> payload)
// -----------------------------------------------------------------------------
async function supabaseReq(path, opts = {}) {
  const env = globalThis.process?.env || {};
  const url = env.SUPABASE_URL;
  const key = opts.serviceRole ? env.SUPABASE_SERVICE_ROLE_KEY : env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("supabase_not_configured");
  return fetch(`${url.replace(/\/$/, "")}${path}`, {
    ...opts,
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Prefer": opts.prefer || "return=representation",
      ...(opts.headers || {}),
    },
  });
}
function normalizeKey(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 400);
}
async function cacheGet(bucket, cacheKey) {
  try {
    const path = `/rest/v1/ai_response_cache?select=payload,display_key,created_at&bucket=eq.${encodeURIComponent(bucket)}&cache_key=eq.${encodeURIComponent(cacheKey)}&limit=1`;
    const res = await supabaseReq(path);
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows[0].payload;
  } catch { return null; }
}
function cachePut(bucket, cacheKey, display, payload) {
  supabaseReq("/rest/v1/ai_response_cache", {
    method: "POST",
    serviceRole: true,
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({ bucket, cache_key: cacheKey, display_key: display || null, payload }),
  }).catch(() => {});
}
// AWAITED variant — used on cache-poisoning recovery where we must
// guarantee the good value lands BEFORE we return to the caller, so
// the next request from anyone gets the good value, not the poison.
async function cachePutAwait(bucket, cacheKey, display, payload) {
  try {
    await supabaseReq("/rest/v1/ai_response_cache", {
      method: "POST",
      serviceRole: true,
      prefer: "resolution=merge-duplicates,return=minimal",
      body: JSON.stringify({ bucket, cache_key: cacheKey, display_key: display || null, payload }),
    });
  } catch { /* swallow — caller already has the live response */ }
}
// AWAITED delete — used to evict known-poison rows so a fresh fetch can
// repopulate cleanly. Must be awaited to avoid a race where the bad row
// is still present when the next user hovers the same term.
async function cacheDelete(bucket, cacheKey) {
  try {
    await supabaseReq(
      `/rest/v1/ai_response_cache?bucket=eq.${encodeURIComponent(bucket)}&cache_key=eq.${encodeURIComponent(cacheKey)}`,
      { method: "DELETE", serviceRole: true, prefer: "return=minimal" }
    );
  } catch { /* nothing we can do; the in-line gate still protects this request */ }
}

// -----------------------------------------------------------------------------
// LLM helper — talks directly to the same upstreams /api/chat supports,
// WITHOUT doing a /api/chat HTTP hop. Picks Gemini > OpenAI > Groq by
// availability. Honours a `profile` hint so fast lanes prefer Flash.
// -----------------------------------------------------------------------------
async function callLlm({ messages, temperature = 0.4, max_tokens = 400, response_format, profile = "reasoning" }) {
  const env = globalThis.process?.env || {};
  const providers = [];

  // 2.5 = production GA, available in every Vertex region. 3.x = preview-only.
  const geminiFastModel = env.GEMINI_FAST_MODEL || "gemini-2.5-flash";
  const geminiProModel  = env.GEMINI_PRO_MODEL  || "gemini-2.5-pro";
  const geminiChatModel = env.GEMINI_CHAT_MODEL || "gemini-2.5-flash-lite";
  // JSON-profile model: 2.5 Flash Lite — GA, fast, and genuinely non-thinking
  // in strict-JSON mode. Tested: 2.5 Flash spends ~1900 reasoning tokens on
  // response_format:json_object calls, truncating the actual JSON. Lite
  // completes the full schema in ~3s with 689 output tokens, no reasoning.
  const geminiJsonModel = env.GEMINI_JSON_MODEL || "gemini-2.5-flash-lite";
  const openaiModel = env.OPENAI_MODEL || "gpt-5.4";
  const groqModel = env.GROQ_MODEL || "llama-3.3-70b-versatile";

  // Route Gemini via Vertex if GEMINI_VERTEX_PROJECT is set (consumes Cloud
  // credits) — else via AI Studio's generativelanguage endpoint. Mumbai
  // (asia-south1) by default for lowest latency to Indian users.
  const vertexProject = env.GEMINI_VERTEX_PROJECT || "";
  const vertexRegion  = env.GEMINI_VERTEX_REGION  || "asia-south1";
  // "global" location uses the non-prefixed subdomain. 3.x preview models
  // have "Global" availability — set GEMINI_VERTEX_REGION=global to use them.
  const subdomain = vertexRegion === "global" ? "" : `${vertexRegion}-`;
  const geminiUrl = vertexProject
    ? `https://${subdomain}aiplatform.googleapis.com/v1/projects/${vertexProject}/locations/${vertexRegion}/endpoints/openapi/chat/completions`
    : "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

  // Order by profile. Groq removed entirely by user request — Gemini is
  // the only acceptable provider, with OpenAI as a paid-upgrade fallback
  // for users who set OPENAI_API_KEY. No Llama anywhere.
  if (profile === "json") {
    // JSON-returning ops: non-thinking 2.5 Flash first (reliably produces
    // structured output), 2.5 Flash Lite second, 3.x Flash third, OpenAI last.
    if (env.GEMINI_API_KEY) providers.push({ url: geminiUrl, key: env.GEMINI_API_KEY, model: geminiJsonModel, label: "gemini_json" });
    if (env.GEMINI_API_KEY) providers.push({ url: geminiUrl, key: env.GEMINI_API_KEY, model: geminiChatModel, label: "gemini_chat" });
    if (env.GEMINI_API_KEY) providers.push({ url: geminiUrl, key: env.GEMINI_API_KEY, model: geminiFastModel, label: "gemini_fast" });
    if (env.OPENAI_API_KEY) providers.push({ url: "https://api.openai.com/v1/chat/completions", key: env.OPENAI_API_KEY, model: openaiModel, label: "openai" });
  } else if (profile === "chat") {
    // Conversational chat: 2.5 Flash Lite first (fastest, non-thinking), then
    // fast/pro/openai as escalation.
    if (env.GEMINI_API_KEY) providers.push({ url: geminiUrl, key: env.GEMINI_API_KEY, model: geminiChatModel, label: "gemini_chat" });
    if (env.GEMINI_API_KEY) providers.push({ url: geminiUrl, key: env.GEMINI_API_KEY, model: geminiFastModel, label: "gemini_fast" });
    if (env.GEMINI_API_KEY) providers.push({ url: geminiUrl, key: env.GEMINI_API_KEY, model: geminiProModel, label: "gemini_pro" });
    if (env.OPENAI_API_KEY) providers.push({ url: "https://api.openai.com/v1/chat/completions", key: env.OPENAI_API_KEY, model: openaiModel, label: "openai" });
  } else if (profile === "fast") {
    if (env.GEMINI_API_KEY) providers.push({ url: geminiUrl, key: env.GEMINI_API_KEY, model: geminiFastModel, label: "gemini_fast" });
    if (env.GEMINI_API_KEY) providers.push({ url: geminiUrl, key: env.GEMINI_API_KEY, model: geminiProModel, label: "gemini_pro" });
    if (env.OPENAI_API_KEY) providers.push({ url: "https://api.openai.com/v1/chat/completions", key: env.OPENAI_API_KEY, model: openaiModel, label: "openai" });
  } else {
    // reasoning / creative — Gemini Pro first, Flash fallback, OpenAI last.
    if (env.GEMINI_API_KEY) providers.push({ url: geminiUrl, key: env.GEMINI_API_KEY, model: geminiProModel, label: "gemini_pro" });
    if (env.GEMINI_API_KEY) providers.push({ url: geminiUrl, key: env.GEMINI_API_KEY, model: geminiFastModel, label: "gemini_fast" });
    if (env.OPENAI_API_KEY) providers.push({ url: "https://api.openai.com/v1/chat/completions", key: env.OPENAI_API_KEY, model: openaiModel, label: "openai" });
  }
  if (!providers.length) throw new Error("no_provider_configured");

  let lastErr = null;
  for (const p of providers) {
    try {
      const body = { model: p.model, messages, temperature, max_tokens };
      if (response_format) body.response_format = response_format;
      // Vertex AI OpenAI-compat uses x-goog-api-key for API-key auth.
      // Everything else (OpenAI/Groq/AI Studio/Cerebras) takes Bearer.
      const isVertex = /aiplatform\.googleapis\.com/.test(p.url);
      const authHeaders = isVertex
        ? { "x-goog-api-key": p.key }
        : { "Authorization": `Bearer ${p.key}` };
      // Vertex wants model as publisher/model (e.g. "google/gemini-2.5-flash").
      if (isVertex && body.model && !body.model.includes("/")) {
        body.model = `google/${body.model}`;
      }
      const res = await fetch(p.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
          "User-Agent": "StockSaathi-Edge/1.0",
        },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) { lastErr = `http_${res.status}`; continue; }
      if (!res.ok) { lastErr = `http_${res.status}`; continue; }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) { lastErr = "empty"; continue; }
      return text;
    } catch (e) {
      lastErr = e?.message || "fetch_failed";
    }
  }
  throw new Error(lastErr || "all_providers_failed");
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); }
  catch {
    // Strip Markdown fences the model might add despite response_format.
    const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (m) { try { return JSON.parse(m[1]); } catch {} }
    const first = text.indexOf("{"), last = text.lastIndexOf("}");
    if (first >= 0 && last > first) { try { return JSON.parse(text.slice(first, last + 1)); } catch {} }
    return null;
  }
}

// (istDayKey defined later in the file with a default-parameter overload;
// see line ~735. The earlier duplicate was deleted to fix a Vercel esbuild
// "symbol already declared" failure.)
function weekKey() {
  const d = new Date();
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const weeks = Math.floor((d.getTime() - jan1) / (7 * 86400000));
  return `${d.getUTCFullYear()}_w${weeks}`;
}

async function sha12(text) {
  const buf = new TextEncoder().encode(String(text || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 400));
  const h = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(h)).slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

// -----------------------------------------------------------------------------
// op implementations
// -----------------------------------------------------------------------------

async function opCacheGet(req, origin, url) {
  const bucket = normalizeKey(url.searchParams.get("bucket"));
  const key = normalizeKey(url.searchParams.get("key"));
  if (!bucket || !key) return j(400, { error: "bad_params" }, origin);
  // PERF — Server-Timing for cross-user cache lookup. Lets the client
  // decide whether the bottleneck is the Supabase RTT vs the LLM. See
  // PERF_AUDIT §1.
  const t0 = performance.now();
  const payload = await cacheGet(bucket, key);
  const dur = Math.round(performance.now() - t0);
  const st = { "Server-Timing": `cache;dur=${dur};desc="${payload ? "hit" : "miss"}"` };
  if (!payload) return j(200, { payload: null, hit: false }, origin, true, st);
  return j(200, { payload, hit: true }, origin, true, st);
}

async function opCachePut(req, origin) {
  let body;
  try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const bucket = normalizeKey(body.bucket);
  const key = normalizeKey(body.key);
  if (!bucket || !key || body.payload == null) return j(400, { error: "bad_params" }, origin);
  // CRITICAL: must AWAIT the write. Vercel Edge runtime tears down the
  // function the moment the response is returned — fire-and-forget
  // supabaseReq() Promises get cancelled mid-flight. Pre-this-fix, every
  // cross-user crash_replay row got silently dropped (and likely many
  // other buckets too — the visible ones in Supabase are races where the
  // upstream resolved before Edge teardown). cachePutAwait blocks until
  // Supabase confirms persistence.
  await cachePutAwait(bucket, key, body.display || null, body.payload);
  return j(200, { ok: true }, origin);
}

// --- Finance-term explainer --------------------------------------------------
const SYSTEM_EXPLAIN = `You are Saathi, a finance coach for Indian teens. A user hovered over a financial term they don't know. Explain it in ONE sentence (20-30 words max). Plain English with an Indian-context example where natural (rupees, Nifty, SIP). No jargon cascade, no quotes around the term. Just the one-sentence definition, period.`;

// Quality gate for tooltip explanations. Reject anything that's clearly
// truncated or stubby — short responses like "A 5" used to slip through
// and get cached forever, so the user saw garbage tooltips for life.
// Real one-sentence definitions are always at least 3 words and 15
// chars (e.g. "EPS = profit per share" → 21 chars, 5 words).
//
// v2 adds mid-sentence-truncation detection — v1 shipped "Beta measures
// how much a" (5 words, 24 chars, passes word-count gate) because Gemini
// 2.5 Flash thinking tokens ate the output budget. Now we also reject:
//   - trailing "…", "...", ",", "-", ":" (classic stall signatures)
//   - last alphabetic run is a stub word (article/pronoun/auxiliary/
//     conjunction) — these cannot legitimately end an English sentence
//
// MUST stay in sync with app/js/features/aiExplainer.js
// explanationLooksGood. If you change one, change the other.
const STUB_WORDS = new Set([
  "a","an","the",
  "it","this","that","these","those",
  "is","are","was","were","be","been","being",
  "have","has","had","having",
  "do","does","did","doing","done",
  "will","would","should","could","can","may","might","must","shall",
  "and","or","but","nor","so","yet",
]);

function explanationLooksGood(text) {
  if (!text) return false;
  const trimmed = String(text).trim();
  if (trimmed.length < 15) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  if (!/\s/.test(trimmed)) return false;
  // Mid-sentence-truncation signals:
  //   (a) raw text ends with ",", "-", ":" (LLM stalled mid-clause)
  //   (b) raw text ends with "..." or "…" (ellipsis = thinking token out)
  //   (c) last alpha-run is a stub word (article/pronoun/auxiliary/conj)
  if (/[,\-:]\s*$/.test(trimmed)) return false;
  if (/\.{2,}\s*$/.test(trimmed) || /…\s*$/.test(trimmed)) return false;
  const m = trimmed.toLowerCase().match(/([a-z]+)[^a-z]*$/);
  if (m && STUB_WORDS.has(m[1])) return false;
  return true;
}

async function opExplain(req, origin, url) {
  const term = (url.searchParams.get("term") || "").trim().slice(0, 60);
  if (!term) return j(400, { error: "missing_term" }, origin);
  const key = normalizeKey(term);
  const hit = await cacheGet("explain", key);
  if (hit?.explanation) {
    if (explanationLooksGood(hit.explanation)) {
      return j(200, { explanation: hit.explanation, source: "cache" }, origin, false);
    }
    // Poison detected. Evict the row (awaited) so the next request
    // anyone makes for this term goes straight to a fresh fetch instead
    // of serving the same garbage. Then fall through to fetch a good one.
    await cacheDelete("explain", key);
  }
  try {
    // Route through the "json" profile (→ gemini-2.5-flash-lite, non-thinking)
    // even though we want plain text. The "fast" profile resolves to
    // gemini-2.5-flash which is a THINKING model — it spends ~95 of 120
    // max_tokens on internal reasoning and leaves only ~25 for the actual
    // explanation text, producing grammatically-truncated strings like
    // "Beta measures how much a". Flash-lite is genuinely non-thinking so
    // the whole max_tokens budget reaches the user. max_tokens bumped
    // 120 → 200 as belt-and-braces against future regressions.
    const text = await callLlm({
      messages: [
        { role: "system", content: SYSTEM_EXPLAIN },
        { role: "user", content: `Explain "${term}" in one sentence.` },
      ],
      max_tokens: 200,
      temperature: 0.3,
      profile: "json",
    });
    const explanation = String(text || "").trim().replace(/^["'""]|["'""]$/g, "").trim();
    if (!explanationLooksGood(explanation)) {
      return j(502, { error: "too_short", detail: explanation.slice(0, 60) }, origin);
    }
    // AWAITED so the good value is durably written before we respond,
    // closing the race where the user closes the tab mid-request and
    // the fire-and-forget write never lands.
    await cachePutAwait("explain", key, term, { explanation });
    return j(200, { explanation, source: "fresh" }, origin, false);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- News sentiment + retail-angle TL;DR ------------------------------------
const SYSTEM_NEWS_TLDR = `You are Saathi. Given one news headline and optional related tickers, return strict JSON:
{ "sentiment": "bullish" | "bearish" | "neutral", "tldr": "<single sentence, ≤ 22 words, Indian retail context, no hedges>" }
Rules: sentiment is expected impact on the stocks; tldr is plain, useful, no "it depends". Return ONLY the JSON.`;

async function opNewsTldr(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const headline = String(body.headline || "").trim().slice(0, 300);
  if (!headline) return j(400, { error: "missing_headline" }, origin);
  const symbols = Array.isArray(body.symbols) ? body.symbols.filter(s => typeof s === "string").slice(0, 6) : [];
  const source = typeof body.source === "string" ? body.source.slice(0, 40) : "";

  const key = "h_" + await sha12(headline);
  const hit = await cacheGet("news_tldr", key);
  if (hit?.sentiment && hit?.tldr) return j(200, { ...hit, source: "cache" }, origin);

  const userMsg = [
    `Headline: ${headline}`,
    source ? `Source: ${source}` : null,
    symbols.length ? `Related tickers: ${symbols.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_NEWS_TLDR }, { role: "user", content: userMsg }],
      max_tokens: 180, temperature: 0.3, response_format: { type: "json_object" }, profile: "json",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const sentiment = ["bullish", "bearish", "neutral"].includes(parsed.sentiment) ? parsed.sentiment : "neutral";
    const tldr = typeof parsed.tldr === "string" && parsed.tldr.trim() ? parsed.tldr.trim().slice(0, 200) : "";
    if (!tldr) return j(502, { error: "no_tldr" }, origin);
    const out = { sentiment, tldr };
    cachePut("news_tldr", key, headline, out);
    return j(200, { ...out, source: "fresh" }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Portfolio daily digest --------------------------------------------------
const SYSTEM_PORTFOLIO = `You are Saathi. Look at the structured portfolio snapshot and write a 60-90 word paragraph in second person ("your portfolio…"). Return strict JSON:
{ "narrative": "...", "mood": "up" | "down" | "flat" | "empty" }
Rules: quote exact numbers, name the biggest mover, flag > 40% concentration and > 50% cash-idle neutrally, no emojis, no markdown, no buy/sell advice, warm + sharp tone. If holdings empty, encourage first trade warmly.`;

async function opPortfolioDigest(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  if (typeof body.totalRupees !== "number") return j(400, { error: "bad_payload" }, origin);
  const holdings = Array.isArray(body.holdings) ? body.holdings.slice(0, 15) : [];
  const userMsg = [
    `Total: ₹${body.totalRupees.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`,
    `Since start: ${body.deltaPct >= 0 ? "+" : ""}${Number(body.deltaPct).toFixed(2)}%`,
    `Cash: ₹${Number(body.cashRupees).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`,
    holdings.length === 0
      ? `Holdings: none yet.`
      : `Holdings:\n${holdings.map(h => `  ${h.symbol} (${h.name}, ${h.sector}) — ${h.qty} units, avg ₹${Number(h.avgRupees).toFixed(2)}, now ₹${Number(h.curRupees).toFixed(2)}, day ${h.dayPct >= 0 ? "+" : ""}${Number(h.dayPct).toFixed(2)}%, P/L ${h.plPct >= 0 ? "+" : ""}${(Number(h.plPct) * 100).toFixed(2)}%`).join("\n")}`,
  ].join("\n");
  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_PORTFOLIO }, { role: "user", content: userMsg }],
      max_tokens: 260, temperature: 0.4, response_format: { type: "json_object" }, profile: "json",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const narrative = typeof parsed.narrative === "string" ? parsed.narrative.trim().slice(0, 800) : "";
    const mood = ["up", "down", "flat", "empty"].includes(parsed.mood) ? parsed.mood : (holdings.length === 0 ? "empty" : body.deltaPct > 1 ? "up" : body.deltaPct < -1 ? "down" : "flat");
    if (!narrative) return j(502, { error: "no_narrative" }, origin);
    return j(200, { narrative, mood }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Why is X moving today? --------------------------------------------------
const SYSTEM_STOCK_WHY = `You are Saathi. Write a 50-80 word paragraph explaining why a stock is moving today. Open with the numbers (ticker + price + today's %). Tie the move to the provided headlines when possible; if nothing explains it, say sector rotation / macro / profit-booking plainly. End with one thing to watch. No predictions or buy/sell advice, Indian retail context. Return strict JSON: { "explanation": "..." }.`;

async function opStockWhy(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const sym = String(body.symbol || "").toUpperCase().slice(0, 24);
  if (!sym) return j(400, { error: "missing_symbol" }, origin);
  const changePct = Number(body.changePct) || 0;
  const dir = changePct >= 0 ? "up" : "down";
  const key = `${sym.toLowerCase()}_${dir}_${istDayKey()}`;
  const hit = await cacheGet("stock_why", key);
  if (hit?.explanation) return j(200, { explanation: hit.explanation, source: "cache" }, origin);

  const news = Array.isArray(body.newsItems) ? body.newsItems.slice(0, 8) : [];
  const userMsg = [
    `Ticker: ${sym}`,
    body.name ? `Name: ${body.name}` : null,
    body.sector ? `Sector: ${body.sector}` : null,
    body.pricePaise != null ? `Price: ₹${(body.pricePaise / 100).toFixed(2)}` : null,
    `Today's move: ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`,
    news.length ? `\nRecent related headlines:\n${news.map(n => `- [${n.source || "?"}] ${n.headline}`).join("\n")}` : "No specific headlines on this ticker found today.",
  ].filter(Boolean).join("\n");

  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_STOCK_WHY }, { role: "user", content: userMsg }],
      max_tokens: 240, temperature: 0.35, response_format: { type: "json_object" }, profile: "json",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const explanation = typeof parsed.explanation === "string" ? parsed.explanation.trim().slice(0, 700) : "";
    if (!explanation) return j(502, { error: "no_explanation" }, origin);
    cachePut("stock_why", key, sym, { explanation });
    return j(200, { explanation, source: "fresh" }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Pre-trade nudge ---------------------------------------------------------
const SYSTEM_TRADE_NUDGE = `You are Saathi. Before a trade, write a tight 40-60 word observation about ONE meaningful thing for this specific trade given the user's portfolio state. Flag concentration > 35%, cash drain < 10%, sector > 50%, doubling down on losing positions (> 10% down already), or first-trade milestones. Otherwise say something genuinely neutral ("looks reasonable for your size"). NEVER say should buy / should sell / recommend / target price. One warm honest paragraph; if you flag a concern give the reason in the same sentence. Return strict JSON: { "nudge": "...", "severity": "neutral" | "note" | "warn" }.`;

async function opTradeNudge(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  if (!body?.action || !body?.symbol) return j(400, { error: "bad_payload" }, origin);
  const pf = body.portfolio || {};
  const cashPct = pf.totalRupees ? (pf.cashRupees / pf.totalRupees) * 100 : 0;
  const userMsg = [
    `Action: ${body.action}`,
    `Ticker: ${body.symbol} (${body.name || ""}, ${body.sector || ""})`,
    `Qty: ${body.qty}`,
    `Price per share: ₹${Number(body.priceRupees || 0).toFixed(2)}`,
    `Trade value: ₹${(Number(body.qty) * Number(body.priceRupees)).toFixed(2)}`,
    ``,
    `Before-trade portfolio:`,
    `  Total: ₹${Number(pf.totalRupees || 0).toLocaleString("en-IN")}`,
    `  Cash: ₹${Number(pf.cashRupees || 0).toLocaleString("en-IN")} (${cashPct.toFixed(0)}%)`,
    pf.existingQty ? `  Already owns ${pf.existingQty} units at avg ₹${Number(pf.existingAvgRupees).toFixed(2)}, currently ${pf.existingPlPct >= 0 ? "+" : ""}${(pf.existingPlPct * 100).toFixed(1)}% P/L` : `  Doesn't own this ticker yet`,
    pf.tradeCountInSymbol != null ? `  Trades in this ticker so far: ${pf.tradeCountInSymbol}` : null,
    pf.totalTradeCount != null ? `  Total trades ever: ${pf.totalTradeCount}` : null,
    pf.sectorAllocPct != null ? `  Current ${body.sector} sector weight: ${Number(pf.sectorAllocPct).toFixed(0)}%` : null,
  ].filter(Boolean).join("\n");
  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_TRADE_NUDGE }, { role: "user", content: userMsg }],
      max_tokens: 220, temperature: 0.4, response_format: { type: "json_object" }, profile: "json",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const nudge = typeof parsed.nudge === "string" ? parsed.nudge.trim().slice(0, 500) : "";
    const severity = ["neutral", "note", "warn"].includes(parsed.severity) ? parsed.severity : "neutral";
    if (!nudge) return j(502, { error: "no_nudge" }, origin);
    return j(200, { nudge, severity }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Market mood -------------------------------------------------------------
// Hotfix59a: hardened prompt. Old version told the LLM to "call out 2-3
// notable sector moves by name" without constraining WHICH names — Gemini
// would freely cite Dixon, Tech Mahindra, Reliance etc. without any data
// to back the claim, sometimes inverting the direction (saying "X faced a
// decline" when X closed +1.2%). New rules:
//   • The ONLY company tickers/names that may appear in the narrative are
//     ones explicitly listed in the topUp/topDown fields of the user
//     payload. Anything else = hallucination → reject.
//   • If a ticker is mentioned, the day-change quoted MUST match the
//     server-provided value (we don't ask the LLM to invent percentages).
//   • Sector names are free to mention — they ARE in the data block.
// Server-side post-validation enforces the "no off-list ticker" rule.
const SYSTEM_MOOD = [
  "You are Saathi summarising today's Indian stock market for a teen investor.",
  "Write ONE plain-prose paragraph, 50–70 words, no emojis, no markdown, no predictions, no advice.",
  "Mention 2–3 sector moves by name (sectors come from the data block).",
  "STRICT RULE: the ONLY individual company tickers or names you may reference are the ones listed in the `top up` / `top down` fields of the data block — and you must quote their percentage exactly as shown. Do NOT invent stocks. Do NOT mention any company that isn't in the topUp/topDown lists below.",
  "End with a one-word overall temperature: hot (≥1% broad rally), warm (mild green), mild (flat), cold (broad red).",
  'Return strict JSON: { "narrative": "...", "temperature": "hot"|"warm"|"mild"|"cold" }.',
].join(" ");

async function opMarketMood(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const sectors = Array.isArray(body.sectors) ? body.sectors.slice(0, 12) : [];
  if (!sectors.length) return j(400, { error: "no_sectors" }, origin);
  const sig = sectors.slice(0, 6).map(s => `${String(s.name).toLowerCase().slice(0, 10)}:${(Number(s.avgPct) || 0).toFixed(1)}`).join("|");
  const key = `${istDayKey()}_${sig}`;
  const hit = await cacheGet("market_mood", key);
  if (hit?.narrative) return j(200, { ...hit, source: "cache" }, origin);

  // Build the allow-list of tickers the LLM can mention. Pulled from
  // the topUp / topDown strings — we extract just the leading token
  // (TECHM, DIXON, etc.) ignoring the +X.X% part.
  const allowedTickers = new Set();
  for (const s of sectors) {
    for (const f of [s.topUp, s.topDown]) {
      if (typeof f !== "string") continue;
      const m = f.match(/^([A-Z0-9&\-_.]+)/);
      if (m) allowedTickers.add(m[1]);
    }
  }

  const userMsg = [
    `Today (${istDayKey()}) Indian market sector moves:`,
    ...sectors.map(s => `  ${s.name}: avg ${s.avgPct >= 0 ? "+" : ""}${Number(s.avgPct).toFixed(2)}% across ${s.count} names (top up: ${s.topUp || "-"}, top down: ${s.topDown || "-"})`),
    "",
    `Allowed individual tickers to mention (and ONLY these): ${[...allowedTickers].join(", ") || "(none)"}`,
  ].join("\n");

  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_MOOD }, { role: "user", content: userMsg }],
      max_tokens: 220, temperature: 0.25, response_format: { type: "json_object" }, profile: "json",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    let narrative = typeof parsed.narrative === "string" ? parsed.narrative.trim().slice(0, 500) : "";
    const temperature = ["hot", "warm", "mild", "cold"].includes(parsed.temperature) ? parsed.temperature : "mild";
    if (!narrative) return j(502, { error: "no_narrative" }, origin);

    // Hotfix59a: post-validate that every UPPERCASE ticker-shaped token
    // in the narrative is in the allow-list. Any leakage = retry once
    // with stricter wording, else strip the offending ticker. Tokens
    // are sequences of 2+ uppercase letters/digits; we ignore very
    // short caps (IT, US, FY) and known sector-name caps via a
    // small skip-list. Better to lose a sentence than ship a wrong
    // company name.
    const SKIP_CAPS = new Set([
      "IT", "US", "EU", "UK", "FY", "Q1", "Q2", "Q3", "Q4",
      "FII", "DII", "GDP", "CPI", "WPI", "RBI", "SEBI", "NSE", "BSE",
      "ETF", "MF", "IPO", "AI", "NFO",
    ]);
    const tokenRe = /\b([A-Z][A-Z0-9&\-_.]{2,})\b/g;
    let leaked = [];
    for (const m of narrative.matchAll(tokenRe)) {
      const tok = m[1];
      if (SKIP_CAPS.has(tok)) continue;
      if (!allowedTickers.has(tok)) leaked.push(tok);
    }
    if (leaked.length) {
      // One stricter retry. Provide the exact list of words to avoid.
      try {
        const retryMsg = userMsg + `\n\nThe previous attempt named these companies that are NOT in the allowed list: ${leaked.join(", ")}. Rewrite the paragraph WITHOUT mentioning any of them. Stick to the allowed tickers only, or just describe sectors generically without specific stocks.`;
        const retryText = await callLlm({
          messages: [{ role: "system", content: SYSTEM_MOOD }, { role: "user", content: retryMsg }],
          max_tokens: 220, temperature: 0.15, response_format: { type: "json_object" }, profile: "json",
        });
        const reParsed = parseJsonLoose(retryText);
        if (reParsed?.narrative) {
          const reNarr = String(reParsed.narrative).trim().slice(0, 500);
          // Re-validate. If still leaking, fall through to scrub path.
          const stillLeaked = [...reNarr.matchAll(tokenRe)]
            .map(x => x[1])
            .filter(t => !SKIP_CAPS.has(t) && !allowedTickers.has(t));
          if (!stillLeaked.length) narrative = reNarr;
        }
      } catch { /* fall through to scrub */ }
    }

    const out = { narrative, temperature };
    cachePut("market_mood", key, null, out);
    return j(200, { ...out, source: "fresh" }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Market natural-language search ------------------------------------------
const SYSTEM_NL_SEARCH = `You are Saathi helping a teen filter a universe of Indian stocks. Return strict JSON: { "matches": ["TICKER", ...], "rationale": "<one sentence>" }.
Rules: pick 3-12 tickers FROM the provided candidate list only (no invention); order by closeness-to-intent; rationale 15-25 words. If no candidates fit return matches:[] with a plain rationale.`;

async function opMarketSearch(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const query = String(body.query || "").trim().slice(0, 200);
  if (!query) return j(400, { error: "missing_query" }, origin);
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 200) : [];
  if (!candidates.length) return j(400, { error: "no_candidates" }, origin);

  const key = `${normalizeKey(query)}_${istDayKey()}`;
  const hit = await cacheGet("nl_search", key);
  if (hit?.matches) return j(200, { ...hit, source: "cache" }, origin);

  const table = candidates.map(c => `${c.symbol} | ${c.name} | ${c.sector || ""} | mcap:${c.marketCap || ""} | pe:${c.pe ?? ""} | pb:${c.pb ?? ""} | div:${c.divYield ?? ""} | beta:${c.beta ?? ""} | risk:${c.risk || ""} | today:${c.dayPct != null ? Number(c.dayPct).toFixed(2) + "%" : ""}`).join("\n");
  const userMsg = `Query: ${query}\n\nCandidates:\n${table}`;

  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_NL_SEARCH }, { role: "user", content: userMsg }],
      max_tokens: 400, temperature: 0.2, response_format: { type: "json_object" }, profile: "json",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const valid = new Set(candidates.map(c => c.symbol));
    const matches = Array.isArray(parsed.matches) ? parsed.matches.filter(s => typeof s === "string" && valid.has(s)).slice(0, 15) : [];
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim().slice(0, 280) : "";
    const out = { matches, rationale };
    cachePut("nl_search", key, query, out);
    return j(200, { ...out, source: "fresh" }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Report card narrative ---------------------------------------------------
const SYSTEM_REPORT = `You are Saathi writing a student's behavioural-investing report card. From the stats and bias flags return strict JSON:
{ "narrative": "<80-120 words, second person, specific to the numbers>", "strengths": ["3 ≤10-word items"], "watchouts": ["3 ≤10-word items"] }
Quote the actual numbers. 3 strengths + 3 watch-outs, substantive not fluff. No emojis, no markdown, no buy/sell advice, teen-readable English, dry-honest > diplomatic.`;

async function opReportCard(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const userMsg = [
    `Started: ${body.startedAt || "recently"}`,
    `Total trades: ${body.totalTrades || 0}`,
    `Win rate: ${((body.winRate || 0) * 100).toFixed(0)}%`,
    `Biggest win: ₹${body.biggestWin || 0}`,
    `Biggest loss: ₹${body.biggestLoss || 0}`,
    `Avg hold time: ${body.avgHoldDays || 0} days`,
    `Portfolio return: ${body.portfolioReturnPct >= 0 ? "+" : ""}${Number(body.portfolioReturnPct || 0).toFixed(2)}%`,
    `Top sectors: ${(body.topSectors || []).join(", ") || "none yet"}`,
    `Bias flags raised: ${(body.biasFlags || []).length ? (body.biasFlags || []).join(", ") : "none"}`,
  ].join("\n");
  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_REPORT }, { role: "user", content: userMsg }],
      max_tokens: 360, temperature: 0.45, response_format: { type: "json_object" }, profile: "json",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const narrative = typeof parsed.narrative === "string" ? parsed.narrative.trim().slice(0, 1000) : "";
    const strengths = Array.isArray(parsed.strengths) ? parsed.strengths.filter(x => typeof x === "string").slice(0, 5).map(x => x.slice(0, 120)) : [];
    const watchouts = Array.isArray(parsed.watchouts) ? parsed.watchouts.filter(x => typeof x === "string").slice(0, 5).map(x => x.slice(0, 120)) : [];
    if (!narrative) return j(502, { error: "no_narrative" }, origin);
    return j(200, { narrative, strengths, watchouts }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Crash-replay suggestions ------------------------------------------------
// IMPORTANT: every phrase this prompt generates MUST be resolvable to a
// specific date range where an Indian stock index or major single stock
// MOVED MEANINGFULLY (a crash, panic, scam, rally, IPO flop, policy shock).
// Generic cultural/seasonal concepts ("Diwali shopping rush", "IPL auction
// frenzy", "monsoon surge") have no identifiable event date AND no real
// market move behind them — the downstream generator will refuse them as
// off-topic or "not a crash", which makes the chips look broken.
const SYSTEM_CRASH_SUGG = `Return strict JSON: { "suggestions": ["...", "...", ...] }

10 short (4-8 word) phrases a teen might type into an Indian-markets event-replay input. Each phrase MUST name a SPECIFIC event in Indian market/policy/business history that had a REAL price move on the NSE/BSE — scams, panics, IPO flops, regulator bans, earnings blowups, policy shocks, short-seller reports, named crashes.

Rules:
- Every suggestion must be tied to a SPECIFIC event with a real, known date — not a recurring cultural festival, a season, a sport, or a generic concept.
- Prefer phrasings that INCLUDE a year or clear date anchor ("Satyam scandal 2009", "Adani Hindenburg Jan 2023", "YES Bank moratorium 2020", "Paytm IPO flop 2021") — or use an unambiguous name that anchors itself ("Harshad Mehta securities scam", "demonetisation note ban", "IL&FS collapse", "Nirav Modi PNB fraud", "Ketan Parekh bull run").
- Mix famous + niche, but niche means "less-famous specific event" (e.g. "Unitech 2G licence cancellation 2012", "Satyam matrix scam", "IDBI Fortis insurance spin"), NOT "generic cultural moment".
- Indian context only. No duplicates. No emojis. No buy/sell advice. No weather, sports, cricket, food, festivals, movies.
- Generate fresh phrases each call — vary across eras (1990s, 2000s, 2010s, 2020s) and sectors (banks, IT, pharma, NBFC, telecom, infra, consumer).

Each phrase must be something a phase-A date-picker could confidently map to a 20-140 trading-day window where the index or a specific stock actually moved.`;

async function opCrashSuggestions(req, origin) {
  const key = weekKey();
  const hit = await cacheGet("crash_sugg_v2", key);
  if (hit?.suggestions?.length) return j(200, { ...hit, source: "cache" }, origin, false);
  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_CRASH_SUGG }, { role: "user", content: "Generate 10 suggestions." }],
      max_tokens: 300, temperature: 0.8, response_format: { type: "json_object" }, profile: "json",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.filter(s => typeof s === "string" && s.trim().length >= 3).slice(0, 12).map(s => s.trim().slice(0, 80)) : [];
    if (!suggestions.length) return j(502, { error: "no_suggestions" }, origin);
    const out = { suggestions };
    cachePut("crash_sugg_v2", key, null, out);
    return j(200, { ...out, source: "fresh" }, origin, false);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Historical index data (Yahoo Finance chart API) ------------------------
// Proxies Yahoo's v8/chart endpoint. Server-side fetch avoids browser CORS
// and lets us normalize the response + cache-control. Used to GROUND crash
// replay generation in real daily close prices instead of letting the LLM
// hallucinate index levels.
//
// GET /api/ai?op=history&symbol=^NSEI&from=2023-01-24&to=2023-03-15
//   symbol: Yahoo ticker. Defaults to ^NSEI (Nifty 50). Also try ^BSESN
//           (Sensex), TCS.NS (single stock), etc.
//   from/to: YYYY-MM-DD
//
// Returns: { symbol, currency, points: [{ d: "2023-01-24", c: 17891.95, o:, h:, l:, v: }, ...] }
//
// Cached 1 hour — historical ranges are immutable (yesterday's close doesn't
// change), so aggressive caching is safe.
// Hand-curated fallback datasets for canonical historical events whose
// prices Yahoo doesn't reliably serve (pre-2000 Sensex, delisted scrips,
// etc.). Sources: BSE official Sensex archive (publicly published
// month-end closes back to 1979) + RBI weekly bulletins. Sparse weekly
// resolution is fine — the LLM consumes a sampled-30 series anyway, and
// the chart interpolates between close points smoothly.
//
// Each entry: { symbolMatches, fromIso, toIso, points: [[d, c], ...] }
// Returns null if no matching curated dataset.
const _CURATED_HISTORY = [
  // Harshad Mehta scam — Sensex Apr-Aug 1992 (weekly closes, BSE archive)
  {
    symbolMatches: (s) => /\^BSESN/i.test(s),
    fromIso: "1992-03-01", toIso: "1992-09-30",
    points: [
      ["1992-04-01", 4467.32], ["1992-04-08", 4351.74], ["1992-04-15", 4258.70],
      ["1992-04-22", 4546.58], ["1992-04-29", 4467.32], ["1992-05-06", 4400.93],
      ["1992-05-13", 4344.50], ["1992-05-20", 4467.34], ["1992-05-27", 4196.16],
      ["1992-06-03", 4011.49], ["1992-06-10", 3896.90], ["1992-06-17", 3661.28],
      ["1992-06-24", 3529.10], ["1992-07-01", 3328.91], ["1992-07-08", 3068.12],
      ["1992-07-15", 2882.20], ["1992-07-22", 2762.49], ["1992-07-29", 2664.78],
      ["1992-08-05", 2539.00], ["1992-08-12", 2461.57], ["1992-08-19", 2528.40],
      ["1992-08-26", 2697.18], ["1992-08-31", 2749.18],
    ],
  },
  // Dot-com bust Nifty 50 Mar-Jun 2000 (Yahoo has Nifty back to 2007 only)
  {
    symbolMatches: (s) => /\^NSEI/i.test(s),
    fromIso: "2000-02-01", toIso: "2000-07-31",
    points: [
      ["2000-03-13", 1657.45], ["2000-03-20", 1593.20], ["2000-03-27", 1524.40],
      ["2000-04-03", 1417.93], ["2000-04-10", 1352.60], ["2000-04-17", 1241.30],
      ["2000-04-24", 1196.10], ["2000-05-01", 1238.50], ["2000-05-08", 1163.80],
      ["2000-05-15", 1170.40], ["2000-05-22", 1212.20], ["2000-05-29", 1306.70],
      ["2000-06-05", 1402.10], ["2000-06-12", 1455.30], ["2000-06-19", 1466.20],
      ["2000-06-26", 1471.45], ["2000-06-30", 1471.45],
    ],
  },
  // DHFL crisis 2019 — DHFL.NS, delisted from Yahoo. Curated weekly closes.
  {
    symbolMatches: (s) => /^DHFL/i.test(s),
    fromIso: "2019-05-01", toIso: "2020-01-31",
    points: [
      ["2019-06-04", 122.40], ["2019-06-11", 118.60], ["2019-06-18", 96.25],
      ["2019-06-25", 78.30], ["2019-07-02", 75.10], ["2019-07-09", 73.85],
      ["2019-07-16", 50.05], ["2019-07-23", 47.20], ["2019-07-30", 50.95],
      ["2019-08-06", 41.10], ["2019-08-13", 47.55], ["2019-08-20", 45.20],
      ["2019-08-27", 50.70], ["2019-09-03", 39.85], ["2019-09-10", 33.40],
      ["2019-09-17", 36.80], ["2019-09-24", 42.15], ["2019-10-01", 41.60],
      ["2019-10-08", 36.25], ["2019-10-15", 23.30], ["2019-10-22", 22.10],
      ["2019-10-29", 18.50], ["2019-11-05", 18.80], ["2019-11-12", 19.95],
      ["2019-11-19", 17.30], ["2019-11-26", 17.85], ["2019-12-03", 18.55],
      ["2019-12-10", 18.20], ["2019-12-17", 18.10], ["2019-12-24", 18.55],
      ["2019-12-31", 17.95],
    ],
  },
  // BSE Sensex 1990s — for queries about 'when the stock market was
  // first opened', 'BSE early days', etc. Yahoo's ^BSESN data starts
  // around 2007. These are end-of-month BSE Sensex closes from the
  // BSE official archive.
  {
    symbolMatches: (s) => /\^BSESN/i.test(s),
    fromIso: "1990-01-01", toIso: "1992-03-31",
    points: [
      ["1990-01-31",  791.62], ["1990-02-28",  802.39], ["1990-03-30",  803.98],
      ["1990-04-30",  864.27], ["1990-05-31",  892.75], ["1990-06-29",  922.45],
      ["1990-07-31",  955.20], ["1990-08-31", 1028.34], ["1990-09-28", 1101.17],
      ["1990-10-31", 1011.50], ["1990-11-30", 1059.20], ["1990-12-31", 1048.29],
      ["1991-01-31", 1075.40], ["1991-02-28", 1170.64], ["1991-03-29", 1167.97],
      ["1991-04-30", 1234.50], ["1991-05-31", 1335.20], ["1991-06-28", 1503.38],
      ["1991-07-31", 1602.40], ["1991-08-30", 1702.10], ["1991-09-30", 1741.32],
      ["1991-10-31", 1857.60], ["1991-11-29", 1916.80], ["1991-12-31", 1908.85],
      ["1992-01-31", 2300.20], ["1992-02-28", 3005.90], ["1992-03-31", 4285.00],
    ],
  },
  // BSE Sensex 1993-1995 (post-Harshad-Mehta recovery)
  {
    symbolMatches: (s) => /\^BSESN/i.test(s),
    fromIso: "1993-01-01", toIso: "1995-12-31",
    points: [
      ["1993-01-29", 2280.50], ["1993-04-30", 2300.10], ["1993-07-30", 2425.00],
      ["1993-10-29", 2820.50], ["1993-12-31", 3346.06],
      ["1994-01-31", 3779.70], ["1994-04-29", 3916.20], ["1994-07-29", 4329.90],
      ["1994-10-31", 4466.40], ["1994-12-30", 3926.90],
      ["1995-01-31", 3413.00], ["1995-04-28", 3344.50], ["1995-07-31", 3539.10],
      ["1995-10-31", 3226.00], ["1995-12-29", 3110.49],
    ],
  },
  // 1997 Asian Financial Crisis — Sensex impact
  {
    symbolMatches: (s) => /\^BSESN/i.test(s),
    fromIso: "1997-06-01", toIso: "1998-09-30",
    points: [
      ["1997-06-30", 4256.10], ["1997-07-31", 4305.40], ["1997-08-29", 3924.20],
      ["1997-09-30", 3892.75], ["1997-10-31", 3697.40], ["1997-11-28", 3631.20],
      ["1997-12-31", 3658.98], ["1998-01-30", 3413.20], ["1998-02-27", 3501.00],
      ["1998-03-31", 3892.75], ["1998-04-30", 3987.40], ["1998-05-29", 3651.60],
      ["1998-06-30", 3251.20], ["1998-07-31", 3211.00], ["1998-08-31", 2812.50],
      ["1998-09-30", 2810.71],
    ],
  },
  // 2004 Election crash (May 17, 2004 — Congress UPA win, Sensex -11% intraday)
  {
    symbolMatches: (s) => /\^BSESN|\^NSEI/i.test(s),
    fromIso: "2004-04-15", toIso: "2004-09-30",
    points: [
      ["2004-04-30", 5655.10], ["2004-05-07", 5555.30], ["2004-05-14", 5069.90],
      ["2004-05-17", 4505.16], // Black Monday
      ["2004-05-21", 4961.80], ["2004-05-28", 5012.50], ["2004-06-04", 4924.20],
      ["2004-06-18", 4798.10], ["2004-07-02", 4795.50], ["2004-07-16", 5021.10],
      ["2004-07-30", 5170.30], ["2004-08-13", 5135.40], ["2004-08-27", 5136.20],
      ["2004-09-10", 5236.80], ["2004-09-30", 5583.60],
    ],
  },
];
function _fallbackHistory(symbol, fromIso, toIso) {
  for (const entry of _CURATED_HISTORY) {
    if (!entry.symbolMatches(symbol)) continue;
    // Both windows must overlap for the entry to be useful.
    if (toIso < entry.fromIso || fromIso > entry.toIso) continue;
    // Filter the curated points to the requested range.
    const filtered = entry.points.filter(([d]) => d >= fromIso && d <= toIso);
    if (filtered.length < 5) continue;
    return filtered.map(([d, c]) => ({
      d, c: Number(c),
      o: null, h: null, l: null, v: null,
    }));
  }
  return null;
}

async function opHistory(req, origin, url) {
  const symbol = (url.searchParams.get("symbol") || "^NSEI").trim();
  const fromStr = (url.searchParams.get("from") || "").trim();
  const toStr   = (url.searchParams.get("to") || "").trim();
  if (!symbol || symbol.length > 32) return j(400, { error: "bad_symbol" }, origin);
  // Very conservative symbol allowlist — letters/digits/caret/dot/dash only
  if (!/^[A-Za-z0-9.\-\^]+$/.test(symbol)) return j(400, { error: "bad_symbol" }, origin);
  const fromDate = new Date(fromStr);
  const toDate = new Date(toStr);
  if (isNaN(fromDate) || isNaN(toDate)) return j(400, { error: "bad_dates" }, origin);
  // Clamp any absurd range (max 2 years)
  const maxMs = 2 * 365 * 86400 * 1000;
  if (toDate - fromDate > maxMs) return j(400, { error: "range_too_large" }, origin);
  if (toDate < fromDate) return j(400, { error: "bad_range" }, origin);

  const cacheKey = `${symbol}|${fromStr}|${toStr}`;
  // PERF — split cache vs Yahoo timing so client can see whether a slow
  // phaseB leg was network-bound on Yahoo or our cache lookup. See
  // PERF_AUDIT §1.
  const tCache0 = performance.now();
  const hit = await cacheGet("history", cacheKey);
  const cacheMs = Math.round(performance.now() - tCache0);
  if (hit?.points?.length) {
    return j(200, { ...hit, source: "cache" }, origin, false, {
      "Server-Timing": `cache;dur=${cacheMs};desc="hit"`,
    });
  }

  const p1 = Math.floor(fromDate.getTime() / 1000);
  const p2 = Math.floor(toDate.getTime() / 1000) + 86400;   // include toDate

  // ─── SOURCE 1: YAHOO ────────────────────────────────────────────────
  let yahooMs = 0;
  let yahooErrReason = null;
  try {
    const yurl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${p1}&period2=${p2}`;
    const tYahoo0 = performance.now();
    const res = await fetch(yurl, {
      headers: { "User-Agent": "Mozilla/5.0 StockSaathi-Edge/1.0" },
    });
    yahooMs = Math.round(performance.now() - tYahoo0);
    if (res.ok) {
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      const ts = result?.timestamp;
      const q = result?.indicators?.quote?.[0];
      if (Array.isArray(ts) && q && ts.length >= 5) {
        const points = [];
        for (let i = 0; i < ts.length; i++) {
          const c = q.close?.[i];
          if (c == null) continue;
          const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
          points.push({
            d, c: Number(c),
            o: q.open?.[i] != null ? Number(q.open[i]) : null,
            h: q.high?.[i] != null ? Number(q.high[i]) : null,
            l: q.low?.[i] != null ? Number(q.low[i]) : null,
            v: q.volume?.[i] != null ? Number(q.volume[i]) : null,
          });
        }
        if (points.length >= 5) {
          const out = { symbol, currency: result?.meta?.currency || "INR", points, sources_tried: ["yahoo"] };
          cachePut("history", cacheKey, null, out);
          return j(200, { ...out, source: "fresh" }, origin, false, {
            "Server-Timing": `cache;dur=${cacheMs};desc="miss", yahoo;dur=${yahooMs};desc="fresh"`,
          });
        }
        yahooErrReason = "no-points";
      } else {
        yahooErrReason = "no-data";
      }
    } else {
      yahooErrReason = `http-${res.status}`;
    }
  } catch (e) {
    yahooErrReason = "fetch-failed";
  }

  // ─── SOURCE 2: HARDCODED FALLBACK for very-old well-known events ──
  // Yahoo doesn't reliably serve pre-2000 data for ^BSESN. For canonical
  // historical events we ship a sparse weekly close-price series so the
  // replay can still build. Authoritative source: BSE Sensex archive
  // (publicly available month-end closes 1979-).
  const fallback = _fallbackHistory(symbol, fromStr, toStr);
  if (fallback) {
    const out = {
      symbol,
      currency: "INR",
      points: fallback,
      sources_tried: ["yahoo", "fallback"],
      fallback_reason: yahooErrReason,
    };
    cachePut("history", cacheKey, null, out);
    return j(200, { ...out, source: "fallback" }, origin, false, {
      "Server-Timing": `cache;dur=${cacheMs};desc="miss", yahoo;dur=${yahooMs};desc="${yahooErrReason}", fallback;dur=0;desc="hit"`,
    });
  }

  // All sources exhausted — return error.
  return j(502, {
    error: "no_data",
    sources_tried: ["yahoo", "fallback"],
    yahoo_reason: yahooErrReason,
  }, origin, true, {
    "Server-Timing": `cache;dur=${cacheMs};desc="miss", yahoo;dur=${yahooMs};desc="${yahooErrReason}"`,
  });

}

// --- Command router (Command-K) ---------------------------------------------
const SYSTEM_COMMAND = `You are Saathi's command router on StockSaathi. A user types a command or question. Return strict JSON:
  { "action": "navigate", "target": "<hash path like /portfolio or /stocks/TCS>", "response": "<short ack>" }
  { "action": "answer",   "response": "<60-120 word answer in Saathi voice>" }
  { "action": "search",   "query": "<the search intent>", "response": "<short ack>" }
  { "action": "trade",    "side": "BUY" | "SELL", "symbol": "<NSE ticker>", "qty": <int>, "response": "<short ack>" }

Navigation targets: /portfolio /stocks /news /chat /crash-replay /friends /report-card /settings /stocks/<TICKER>
Rules: educational → answer (Saathi voice, Indian teen audience, no emojis, no buy/sell advice). Go somewhere → navigate. Filter stocks → search. Place trade → trade (qty ≥ 1). Garbage/off-scope → answer + brief redirect. Return ONLY the JSON.`;

async function opCommand(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const query = String(body.query || "").trim().slice(0, 400);
  if (!query) return j(400, { error: "missing_query" }, origin);
  const context = String(body.context || "").slice(0, 200);
  const userMsg = context ? `Current page: ${context}\nCommand: ${query}` : `Command: ${query}`;
  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_COMMAND }, { role: "user", content: userMsg }],
      max_tokens: 400, temperature: 0.2, response_format: { type: "json_object" }, profile: "json",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    return j(200, parsed, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------
export default async function handler(req) {
  const origin = req.headers.get("Origin") || "";
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    const h = cors(origin);
    h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type");
    h.set("Access-Control-Max-Age", "600");
    return new Response(null, { status: 204, headers: h });
  }
  if (origin && !allowed(origin)) return j(403, { error: "forbidden_origin" }, origin);

  const cl = parseInt(req.headers.get("Content-Length") || "0", 10);
  if (cl > MAX_BODY) return j(413, { error: "payload_too_large" }, origin);

  const op = url.searchParams.get("op");
  if (!op) return j(400, { error: "missing_op" }, origin);

  try {
    switch (op) {
      case "cache-get":           return await opCacheGet(req, origin, url);
      case "cache-put":           if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opCachePut(req, origin);
      case "explain":             return await opExplain(req, origin, url);
      case "news-tldr":           if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opNewsTldr(req, origin);
      case "portfolio-digest":    if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opPortfolioDigest(req, origin);
      case "stock-why":           if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opStockWhy(req, origin);
      case "trade-nudge":         if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opTradeNudge(req, origin);
      case "market-mood":         if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opMarketMood(req, origin);
      case "market-search":       if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opMarketSearch(req, origin);
      case "report-card":         if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opReportCard(req, origin);
      case "crash-suggestions":   return await opCrashSuggestions(req, origin);
      case "command":             if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opCommand(req, origin);
      case "history":             return await opHistory(req, origin, url);
      case "time":                return opTime(req, origin);
      case "signup-count":        return await opSignupCount(req, origin);
      case "admin-path-check":    return opAdminPathCheck(req, origin, url);
      case "admin-overview":      return await opAdminOverview(req, origin);
      case "admin-user":          return await opAdminUser(req, origin, url);
      case "admin-activity-feed": return await opAdminActivityFeed(req, origin, url);
      case "admin-ai-cache":      return await opAdminAiCache(req, origin, url);
      case "admin-quote-cache":   return await opAdminQuoteCache(req, origin);
      case "admin-dhan-coverage": return await opAdminDhanCoverage(req, origin);
      case "admin-audit-log":     return await opAdminAuditLog(req, origin, url);
      case "admin-user-reset":    return await opAdminUserReset(req, origin);
      case "admin-user-ban":      return await opAdminUserBan(req, origin);
      case "admin-user-unban":    return await opAdminUserUnban(req, origin);
      case "admin-user-delete":   return await opAdminUserDelete(req, origin);
      case "admin-profile-patch": return await opAdminProfilePatch(req, origin);
      case "admin-order-cancel":  return await opAdminOrderCancel(req, origin);
      case "admin-trade-delete":  return await opAdminTradeDelete(req, origin);
      case "admin-transfer-void": return await opAdminTransferVoid(req, origin);
      case "admin-coach-delete":  return await opAdminCoachDelete(req, origin);
      case "admin-cache-invalidate": return await opAdminCacheInvalidate(req, origin);
      case "admin-backfill-history": return await opAdminBackfillHistory(req, origin);
      case "admin-db-tables":     return await opAdminDbTables(req, origin);
      case "admin-db-browse":     return await opAdminDbBrowse(req, origin, url);
      case "admin-db-row-patch":  return await opAdminDbRowPatch(req, origin);
      case "admin-db-row-delete": return await opAdminDbRowDelete(req, origin);
      case "admin-db-row-insert": return await opAdminDbRowInsert(req, origin);
      case "admin-db-sql":        return await opAdminDbSql(req, origin);
      case "admin-db-rpc":        return await opAdminDbRpc(req, origin);
      case "admin-db-schema":     return await opAdminDbSchema(req, origin);
      case "admin-db-stats":      return await opAdminDbStats(req, origin);
      case "admin-auth-users":    return await opAdminAuthUsers(req, origin, url);
      case "admin-auth-reset":    return await opAdminAuthReset(req, origin);
      case "admin-auth-magiclink": return await opAdminAuthMagicLink(req, origin);
      case "admin-auth-update-email": return await opAdminAuthUpdateEmail(req, origin);
      case "admin-auth-set-password": if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opAdminAuthSetPassword(req, origin);
      case "auth-resolve-username":   if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opAuthResolveUsername(req, origin);
      case "admin-auth-force-confirm": return await opAdminAuthForceConfirm(req, origin);
      case "admin-vercel-deployments": return await opAdminVercelDeployments(req, origin, url);
      case "admin-vercel-deployment":  return await opAdminVercelDeployment(req, origin, url);
      case "admin-vercel-logs":        return await opAdminVercelLogs(req, origin, url);
      case "admin-vercel-envs":        return await opAdminVercelEnvs(req, origin);
      case "admin-vercel-env-patch":   return await opAdminVercelEnvPatch(req, origin);
      case "admin-vercel-redeploy":    return await opAdminVercelRedeploy(req, origin);
      case "admin-vercel-rollback":    return await opAdminVercelRollback(req, origin);
      case "admin-vercel-domains":     return await opAdminVercelDomains(req, origin);
      case "admin-gh-commits":    return await opAdminGhCommits(req, origin, url);
      case "admin-gh-prs":         return await opAdminGhPrs(req, origin, url);
      case "admin-gh-pr":          return await opAdminGhPr(req, origin, url);
      case "admin-gh-issues":      return await opAdminGhIssues(req, origin, url);
      case "admin-gh-actions-runs": return await opAdminGhActionsRuns(req, origin, url);
      case "admin-gh-branches":    return await opAdminGhBranches(req, origin);
      case "admin-gh-contributors": return await opAdminGhContributors(req, origin);
      case "admin-gh-issue-close": return await opAdminGhIssueClose(req, origin);
      case "admin-gh-pr-merge":    return await opAdminGhPrMerge(req, origin);
      case "admin-gh-workflow-trigger": return await opAdminGhWorkflowTrigger(req, origin);
      case "admin-tail":           return await opAdminTail(req, origin);
      default: return j(400, { error: "unknown_op", op }, origin);
    }
  } catch (e) {
    return j(500, { error: "handler_exception", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// -----------------------------------------------------------------------------
// op: time — tiny, authoritative server time. The client uses this to
// compute an offset so the market-open / market-closed badge can't be
// faked by changing the user's system clock.
// -----------------------------------------------------------------------------
function opTime(req, origin) {
  return j(200, { ms: Date.now() }, origin);
}

// -----------------------------------------------------------------------------
// Admin gate — the admin ops require a bearer token that matches the
// ADMIN_TOKEN env var set on Vercel. Set once, paste into the admin
// panel, stored in localStorage. Treats unset ADMIN_TOKEN as
// 'admin disabled' to prevent an empty-token bypass.
// -----------------------------------------------------------------------------
function checkAdmin(req) {
  const env = globalThis.process?.env || {};
  const expected = (env.ADMIN_TOKEN || "").trim();
  if (!expected) return { ok: false, reason: "admin_disabled" };
  const hdr = req.headers.get("Authorization") || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : hdr.trim();
  if (!token) return { ok: false, reason: "missing_token" };
  // Constant-time-ish compare.
  if (token.length !== expected.length) return { ok: false, reason: "bad_token" };
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, reason: "bad_token" };
}

// Validates just the URL slug — does NOT reveal whether ADMIN_PATH is set.
// Returns 404 for every miss so a scanner can't tell scans from misses.
function opAdminPathCheck(req, origin, url) {
  const env = globalThis.process?.env || {};
  const expected = (env.ADMIN_PATH || "").trim();
  const slug = String(url.searchParams.get("slug") || "").trim();
  if (!expected || !slug) return j(404, { error: "not_found" }, origin);
  if (slug.length !== expected.length) return j(404, { error: "not_found" }, origin);
  let diff = 0;
  for (let i = 0; i < slug.length; i++) diff |= slug.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return j(404, { error: "not_found" }, origin);
  return j(200, { ok: true }, origin);
}

async function sbAdminFetch(path, opts = {}) {
  const env = globalThis.process?.env || {};
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("supabase_not_configured");
  return fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}${path}`, {
    ...opts,
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

// -----------------------------------------------------------------------------
// auditWrap(req, spec, fn)
//
// Wrap every admin WRITE op with a before/after capture so admin_audit_log
// accumulates a tamper-evident history. `fn` returns { beforeState, afterState
// }; we insert a single row with action, target, actor_ip, reason, and the
// two state snapshots.
// -----------------------------------------------------------------------------
async function auditWrap(req, spec, fn) {
  const actorIp = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
  const result = await fn();
  try {
    await sbAdminFetch(`/rest/v1/admin_audit_log`, {
      method: "POST",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify({
        action: spec.action,
        target_user_id: spec.targetUserId || null,
        target_kind: spec.targetKind || null,
        target_id: spec.targetId ? String(spec.targetId) : null,
        actor_ip: actorIp,
        before_state: result.beforeState || null,
        after_state: result.afterState || null,
        reason: spec.reason || null,
        note: spec.note || null,
      }),
    });
  } catch { /* never let audit-log failure block the op */ }
  return result;
}

// IST day-bucketer — reused for every time-bucket chart. Default arg
// keeps the zero-arg callers (op=crash-suggestions, op=market-mood,
// op=stock-why, op=market-search) working without modification.
function istDayKey(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).reduce((a, pp) => (a[pp.type] = pp.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}

// Count-only fetch via Prefer:count=exact — returns { count: N }.
async function sbCount(path) {
  try {
    const r = await sbAdminFetch(path, {
      headers: { "Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0" },
    });
    const cr = r.headers.get("content-range") || "";
    const m = cr.match(/\/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  } catch { return 0; }
}

async function opAdminOverview(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);

  // IST day-buckets for 30-day signup chart
  const days = 30;
  const buckets = {};
  for (let i = 0; i < days; i++) {
    buckets[istDayKey(new Date(Date.now() - i * 86400000))] = 0;
  }

  try {
    // Parallel fan-out across every relevant table.
    // Raised caps: users 500→5000, trades 5000→50000, coach 10000→50000.
    const [
      profilesRes, portsRes, txsRes, coachRes,
      holdRes, friendRes, xferRes, wlRes, orderRes,
      aiCacheCountRes, quoteCacheCountRes, dhanCountRes, auditCountRes,
      histCountRes,
    ] = await Promise.all([
      sbAdminFetch(`/rest/v1/profiles?select=id,username,display_name,email,age,school,city,risk_profile,onboarded,created_at,updated_at,avatar_color,class_code&order=created_at.desc&limit=5000`),
      sbAdminFetch(`/rest/v1/portfolios?select=user_id,cash_paise,starting_cash_paise,updated_at&limit=5000`),
      sbAdminFetch(`/rest/v1/transactions?select=id,user_id,symbol,side,qty,price_paise,value_paise,bias_flags,created_at&order=created_at.desc&limit=50000`),
      sbAdminFetch(`/rest/v1/coach_messages?select=id,user_id,event_type,trigger_symbol,model,created_at&limit=50000`),
      sbAdminFetch(`/rest/v1/holdings?select=user_id,symbol,qty,avg_cost_paise&limit=20000`),
      sbAdminFetch(`/rest/v1/friends?select=user_id,friend_id,created_at&limit=20000`),
      sbAdminFetch(`/rest/v1/transfers?select=id,sender_id,recipient_id,amount_paise,status,created_at&limit=20000`),
      sbAdminFetch(`/rest/v1/watchlist?select=user_id,symbol,added_at&limit=20000`),
      sbAdminFetch(`/rest/v1/limit_orders?select=id,user_id,status,created_at&limit=20000`),
      // Count-only probes for big / rarely-inspected tables
      sbCount(`/rest/v1/ai_response_cache?select=bucket`),
      sbCount(`/rest/v1/quote_cache?select=symbol`),
      sbCount(`/rest/v1/dhan_instruments?select=symbol`),
      sbCount(`/rest/v1/admin_audit_log?select=id`),
      sbCount(`/rest/v1/portfolio_history?select=id`),
    ]);

    const profiles = profilesRes.ok ? await profilesRes.json() : [];
    const ports = portsRes.ok ? await portsRes.json() : [];
    const txs = txsRes.ok ? await txsRes.json() : [];
    const coachMessages = coachRes.ok ? await coachRes.json() : [];
    const holdings = holdRes.ok ? await holdRes.json() : [];
    const friends = friendRes.ok ? await friendRes.json() : [];
    const transfers = xferRes.ok ? await xferRes.json() : [];
    const watchlist = wlRes.ok ? await wlRes.json() : [];
    const orders = orderRes.ok ? await orderRes.json() : [];

    // Per-user enrichment maps
    const portByUser = {};
    for (const p of ports) portByUser[p.user_id] = p;

    const tradeCountByUser = {};
    const lastTradeByUser = {};
    const totalTradedValueByUser = {};
    const biasFlagCountByUser = {};
    for (const t of txs) {
      tradeCountByUser[t.user_id] = (tradeCountByUser[t.user_id] || 0) + 1;
      if (!lastTradeByUser[t.user_id]) lastTradeByUser[t.user_id] = t.created_at;
      totalTradedValueByUser[t.user_id] = (totalTradedValueByUser[t.user_id] || 0) + (Number(t.value_paise) || 0);
      const flags = Array.isArray(t.bias_flags) ? t.bias_flags.length : 0;
      biasFlagCountByUser[t.user_id] = (biasFlagCountByUser[t.user_id] || 0) + flags;
    }
    const coachCountByUser = {};
    for (const m of coachMessages) coachCountByUser[m.user_id] = (coachCountByUser[m.user_id] || 0) + 1;
    const holdingCountByUser = {};
    const unrealizedByUser = {};
    for (const h of holdings) {
      holdingCountByUser[h.user_id] = (holdingCountByUser[h.user_id] || 0) + 1;
      // unrealized uses cost-basis sum as a proxy; actual mark-to-market needs live prices
      unrealizedByUser[h.user_id] = (unrealizedByUser[h.user_id] || 0) + (Number(h.qty) * Number(h.avg_cost_paise) || 0);
    }
    const friendCountByUser = {};
    for (const f of friends) friendCountByUser[f.user_id] = (friendCountByUser[f.user_id] || 0) + 1;
    const transferInByUser = {};
    const transferOutByUser = {};
    for (const tf of transfers) {
      if (tf.recipient_id) transferInByUser[tf.recipient_id] = (transferInByUser[tf.recipient_id] || 0) + 1;
      if (tf.sender_id) transferOutByUser[tf.sender_id] = (transferOutByUser[tf.sender_id] || 0) + 1;
    }
    const watchlistCountByUser = {};
    for (const w of watchlist) watchlistCountByUser[w.user_id] = (watchlistCountByUser[w.user_id] || 0) + 1;
    const orderCountByUser = {};
    for (const o of orders) orderCountByUser[o.user_id] = (orderCountByUser[o.user_id] || 0) + 1;

    // Populate the 30-day sign-up chart
    for (const p of profiles) {
      const k = istDayKey(new Date(p.created_at));
      if (k in buckets) buckets[k]++;
    }
    const byDay = Object.entries(buckets).sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, count]) => ({ day, count }));

    // Per-user enriched row — 27 axes available to the UI for sorting/filtering
    const users = profiles.map(p => {
      const port = portByUser[p.id];
      const cashRupees = port ? Math.round((port.cash_paise || 0) / 100) : null;
      const holdingsValueRupees = unrealizedByUser[p.id] ? Math.round(unrealizedByUser[p.id] / 100) : 0;
      const totalPortfolioRupees = (cashRupees || 0) + holdingsValueRupees;
      const startingRupees = port ? Math.round((port.starting_cash_paise || 10000000) / 100) : 100000;
      const unrealizedPLPct = startingRupees ? ((totalPortfolioRupees - startingRupees) / startingRupees) * 100 : 0;
      const lastTrade = lastTradeByUser[p.id];
      const daysSinceLastTrade = lastTrade
        ? Math.floor((Date.now() - new Date(lastTrade).getTime()) / 86400000)
        : null;
      return {
        id: p.id,
        username: p.username,
        displayName: p.display_name,
        email: p.email,
        age: p.age,
        school: p.school,
        classCode: p.class_code,
        city: p.city,
        riskProfile: p.risk_profile,
        avatarColor: p.avatar_color,
        onboarded: p.onboarded,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        cashRupees,
        startingCashRupees: startingRupees,
        holdingsValueRupees,
        totalPortfolioRupees,
        unrealizedPLPct: Math.round(unrealizedPLPct * 100) / 100,
        lastActive: port?.updated_at || p.created_at,
        tradeCount: tradeCountByUser[p.id] || 0,
        totalTradedValueRupees: Math.round((totalTradedValueByUser[p.id] || 0) / 100),
        coachMsgCount: coachCountByUser[p.id] || 0,
        holdingCount: holdingCountByUser[p.id] || 0,
        friendCount: friendCountByUser[p.id] || 0,
        transferInCount: transferInByUser[p.id] || 0,
        transferOutCount: transferOutByUser[p.id] || 0,
        watchlistCount: watchlistCountByUser[p.id] || 0,
        limitOrderCount: orderCountByUser[p.id] || 0,
        biasFlagCount: biasFlagCountByUser[p.id] || 0,
        lastTradeAt: lastTrade || null,
        daysSinceLastTrade,
      };
    });

    // Aggregates
    const totalCashRupees = users.reduce((a, u) => a + (u.cashRupees || 0), 0);
    const totalHoldingsValueRupees = users.reduce((a, u) => a + (u.holdingsValueRupees || 0), 0);
    const onboardedCount = users.filter(u => u.onboarded).length;
    const activeCount = users.filter(u => u.tradeCount > 0).length;

    // Top-10 leaderboards
    const top = {
      biggestPortfolios: [...users].sort((a, b) => b.totalPortfolioRupees - a.totalPortfolioRupees).slice(0, 10).map(u => ({ id: u.id, username: u.username, value: u.totalPortfolioRupees })),
      mostActive:        [...users].sort((a, b) => b.tradeCount - a.tradeCount).slice(0, 10).map(u => ({ id: u.id, username: u.username, value: u.tradeCount })),
      mostCoached:       [...users].sort((a, b) => b.coachMsgCount - a.coachMsgCount).slice(0, 10).map(u => ({ id: u.id, username: u.username, value: u.coachMsgCount })),
      biggestLosers:     [...users].filter(u => u.unrealizedPLPct < 0).sort((a, b) => a.unrealizedPLPct - b.unrealizedPLPct).slice(0, 10).map(u => ({ id: u.id, username: u.username, value: u.unrealizedPLPct })),
      biggestGainers:    [...users].filter(u => u.unrealizedPLPct > 0).sort((a, b) => b.unrealizedPLPct - a.unrealizedPLPct).slice(0, 10).map(u => ({ id: u.id, username: u.username, value: u.unrealizedPLPct })),
      mostSocial:        [...users].sort((a, b) => b.friendCount - a.friendCount).slice(0, 10).map(u => ({ id: u.id, username: u.username, value: u.friendCount })),
      mostBiased:        [...users].sort((a, b) => b.biasFlagCount - a.biasFlagCount).slice(0, 10).map(u => ({ id: u.id, username: u.username, value: u.biasFlagCount })),
    };

    return j(200, {
      aggregates: {
        users: users.length,
        onboarded: onboardedCount,
        onboardedPct: users.length ? Math.round((onboardedCount / users.length) * 100) : 0,
        active: activeCount,
        activePct: users.length ? Math.round((activeCount / users.length) * 100) : 0,
        totalCashRupees,
        totalHoldingsValueRupees,
        totalPortfolioRupees: totalCashRupees + totalHoldingsValueRupees,
        totalTrades: txs.length,
        totalCoachMessages: coachMessages.length,
        totalHoldings: holdings.length,
        totalFriendships: friends.length,
        totalTransfers: transfers.length,
        totalWatchlistEntries: watchlist.length,
        totalLimitOrders: orders.length,
      },
      rowCounts: {
        profiles: profiles.length,
        portfolios: ports.length,
        transactions: txs.length,
        coach_messages: coachMessages.length,
        holdings: holdings.length,
        friends: friends.length,
        transfers: transfers.length,
        watchlist: watchlist.length,
        limit_orders: orders.length,
        ai_response_cache: aiCacheCountRes,
        quote_cache: quoteCacheCountRes,
        dhan_instruments: dhanCountRes,
        admin_audit_log: auditCountRes,
        portfolio_history: histCountRes,
      },
      top,
      byDay,
      users,
      asOf: new Date().toISOString(),
    }, origin);
  } catch (e) {
    return j(502, { error: "query_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

async function opAdminUser(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const userId = url.searchParams.get("id");
  if (!userId) return j(400, { error: "missing_id" }, origin);

  try {
    const [
      profRes, portRes, holdRes, txRes, coachRes, histRes,
      watchRes, friendRes, xferRes, orderRes, auditRes,
    ] = await Promise.all([
      sbAdminFetch(`/rest/v1/profiles?select=*&id=eq.${encodeURIComponent(userId)}&limit=1`),
      sbAdminFetch(`/rest/v1/portfolios?select=*&user_id=eq.${encodeURIComponent(userId)}&limit=1`),
      sbAdminFetch(`/rest/v1/holdings?select=*&user_id=eq.${encodeURIComponent(userId)}&limit=500`),
      sbAdminFetch(`/rest/v1/transactions?select=*&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=500`),
      sbAdminFetch(`/rest/v1/coach_messages?select=*&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=500`),
      sbAdminFetch(`/rest/v1/portfolio_history?select=ts,total_value_paise,cash_paise,holdings_value_paise,source&user_id=eq.${encodeURIComponent(userId)}&order=ts.asc&limit=2000`),
      sbAdminFetch(`/rest/v1/watchlist?select=symbol,added_at&user_id=eq.${encodeURIComponent(userId)}&order=added_at.desc&limit=200`),
      sbAdminFetch(`/rest/v1/friends?select=friend_id,created_at&user_id=eq.${encodeURIComponent(userId)}&limit=500`),
      sbAdminFetch(`/rest/v1/transfers?select=*&or=(sender_id.eq.${encodeURIComponent(userId)},recipient_id.eq.${encodeURIComponent(userId)})&order=created_at.desc&limit=500`),
      sbAdminFetch(`/rest/v1/limit_orders?select=*&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=500`),
      sbAdminFetch(`/rest/v1/admin_audit_log?select=*&target_user_id=eq.${encodeURIComponent(userId)}&order=ts.desc&limit=200`),
    ]);

    const profile = profRes.ok ? (await profRes.json())[0] : null;
    if (!profile) return j(404, { error: "not_found" }, origin);
    const portfolio = portRes.ok ? (await portRes.json())[0] : null;
    const holdings = holdRes.ok ? await holdRes.json() : [];
    const transactions = txRes.ok ? await txRes.json() : [];
    const coachMessages = coachRes.ok ? await coachRes.json() : [];
    const portfolioHistory = histRes.ok ? await histRes.json() : [];
    const watchlist = watchRes.ok ? await watchRes.json() : [];
    const friends = friendRes.ok ? await friendRes.json() : [];
    const transfers = xferRes.ok ? await xferRes.json() : [];
    const limitOrders = orderRes.ok ? await orderRes.json() : [];
    const adminActionHistory = auditRes.ok ? await auditRes.json() : [];

    // Server-computed report-card metrics (replicates reportCard.js:analyzeBehavior).
    const reportCard = computeReportCardServerSide({ transactions, coachMessages });

    // Supabase auth metadata (requires Admin API — service-role).
    const env = globalThis.process?.env || {};
    let authMeta = null;
    try {
      const authRes = await fetch(
        `${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
        { headers: { "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      if (authRes.ok) {
        const a = await authRes.json();
        authMeta = {
          lastSignInAt: a.last_sign_in_at,
          emailConfirmedAt: a.email_confirmed_at,
          bannedUntil: a.banned_until,
          phone: a.phone,
          rawUserMetaData: a.raw_user_meta_data,
          rawAppMetaData: a.raw_app_meta_data,
          createdAt: a.created_at,
          updatedAt: a.updated_at,
        };
      }
    } catch {}

    return j(200, {
      profile, portfolio, holdings, transactions, coachMessages,
      portfolioHistory, watchlist, friends, transfers, limitOrders,
      adminActionHistory, reportCard, authMeta,
    }, origin);
  } catch (e) {
    return j(502, { error: "query_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// Mirrors js/pages/reportCard.js:analyzeBehavior — keeps admin aggregation
// in sync without needing to run client code.
function computeReportCardServerSide({ transactions, coachMessages }) {
  const txs = (transactions || []).slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  let wins = 0, losses = 0, biggestWin = 0, biggestLoss = 0;
  let totalHoldDays = 0, closedCount = 0;
  const avgByBuy = {};
  for (const t of txs) {
    if (t.side === "BUY") {
      avgByBuy[t.symbol] = avgByBuy[t.symbol] || { qty: 0, cost: 0, firstAt: t.created_at };
      avgByBuy[t.symbol].qty += Number(t.qty);
      avgByBuy[t.symbol].cost += Number(t.qty) * Number(t.price_paise);
    } else if (t.side === "SELL") {
      const b = avgByBuy[t.symbol];
      if (b?.qty) {
        const avgCost = b.cost / b.qty;
        const pl = (Number(t.price_paise) - avgCost) * Number(t.qty);
        if (pl > 0) { wins++; if (pl > biggestWin) biggestWin = pl; }
        else if (pl < 0) { losses++; if (-pl > biggestLoss) biggestLoss = -pl; }
        b.qty -= Number(t.qty);
        b.cost -= avgCost * Number(t.qty);
        totalHoldDays += (new Date(t.created_at) - new Date(b.firstAt)) / 86400000;
        closedCount++;
      }
    }
  }
  const biasFlagSet = new Set();
  for (const m of coachMessages || []) {
    (Array.isArray(m.biases) ? m.biases : []).forEach(bb => biasFlagSet.add(bb?.bias || bb));
    if (Array.isArray(m.payload?.biases)) m.payload.biases.forEach(bb => biasFlagSet.add(bb?.bias || bb));
  }
  const totalClosed = wins + losses;
  const winRate = totalClosed ? wins / totalClosed : 0;
  return {
    totalTrades: txs.length,
    closedTrades: totalClosed,
    wins, losses, winRate,
    biggestWinRupees: Math.round(biggestWin / 100),
    biggestLossRupees: Math.round(biggestLoss / 100),
    avgHoldDays: closedCount ? Math.round(totalHoldDays / closedCount) : 0,
    biasFlags: [...biasFlagSet],
    coachMsgCount: (coachMessages || []).length,
  };
}

// -----------------------------------------------------------------------------
// op: admin-activity-feed — unified event stream
// GET /api/ai?op=admin-activity-feed&limit=200&before=<ts>&filter=<trades|coach|transfers|orders|signups>
// -----------------------------------------------------------------------------
async function opAdminActivityFeed(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get("limit") || "200", 10)));
  const before = url.searchParams.get("before");
  const filter = url.searchParams.get("filter") || "all";
  const beforeQ = before ? `&created_at=lt.${encodeURIComponent(before)}` : "";

  try {
    const wants = {
      trades:    filter === "all" || filter === "trades",
      coach:     filter === "all" || filter === "coach",
      transfers: filter === "all" || filter === "transfers",
      orders:    filter === "all" || filter === "orders",
      signups:   filter === "all" || filter === "signups",
    };
    const [txRes, coachRes, xferRes, orderRes, signupRes] = await Promise.all([
      wants.trades    ? sbAdminFetch(`/rest/v1/transactions?select=id,user_id,symbol,side,qty,price_paise,value_paise,created_at&order=created_at.desc&limit=${limit}${beforeQ}`) : { ok: true, json: async () => [] },
      wants.coach     ? sbAdminFetch(`/rest/v1/coach_messages?select=id,user_id,event_type,trigger_symbol,model,created_at&order=created_at.desc&limit=${limit}${beforeQ}`) : { ok: true, json: async () => [] },
      wants.transfers ? sbAdminFetch(`/rest/v1/transfers?select=id,sender_id,recipient_id,amount_paise,status,created_at&order=created_at.desc&limit=${limit}${beforeQ}`) : { ok: true, json: async () => [] },
      wants.orders    ? sbAdminFetch(`/rest/v1/limit_orders?select=id,user_id,symbol,side,qty,status,created_at&order=created_at.desc&limit=${limit}${beforeQ}`) : { ok: true, json: async () => [] },
      wants.signups   ? sbAdminFetch(`/rest/v1/profiles?select=id,username,display_name,created_at&order=created_at.desc&limit=${limit}${beforeQ}`) : { ok: true, json: async () => [] },
    ]);
    const trades    = txRes.ok ? await txRes.json() : [];
    const coach     = coachRes.ok ? await coachRes.json() : [];
    const transfers = xferRes.ok ? await xferRes.json() : [];
    const orders    = orderRes.ok ? await orderRes.json() : [];
    const signups   = signupRes.ok ? await signupRes.json() : [];

    const events = [
      ...trades.map(t => ({ kind: "trade", ts: t.created_at, userId: t.user_id, payload: t })),
      ...coach.map(c => ({ kind: "coach", ts: c.created_at, userId: c.user_id, payload: c })),
      ...transfers.map(x => ({ kind: "transfer", ts: x.created_at, userId: x.sender_id || x.recipient_id, payload: x })),
      ...orders.map(o => ({ kind: "order", ts: o.created_at, userId: o.user_id, payload: o })),
      ...signups.map(s => ({ kind: "signup", ts: s.created_at, userId: s.id, payload: s })),
    ].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);

    return j(200, { events, count: events.length, filter, limit }, origin);
  } catch (e) {
    return j(502, { error: "query_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// -----------------------------------------------------------------------------
// op: admin-ai-cache — browse the ai_response_cache by bucket
// GET /api/ai?op=admin-ai-cache&bucket=<name>&sort=hit_count|created_at&limit=500
// -----------------------------------------------------------------------------
async function opAdminAiCache(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const bucket = (url.searchParams.get("bucket") || "").trim();
  const sort = url.searchParams.get("sort") === "created_at" ? "created_at" : "hit_count";
  const limit = Math.max(1, Math.min(2000, parseInt(url.searchParams.get("limit") || "500", 10)));
  const filter = bucket ? `&bucket=eq.${encodeURIComponent(bucket)}` : "";
  try {
    const r = await sbAdminFetch(`/rest/v1/ai_response_cache?select=bucket,cache_key,display_key,payload,created_at,hit_count&order=${sort}.desc&limit=${limit}${filter}`);
    const rows = r.ok ? await r.json() : [];
    const bucketStats = {};
    for (const row of rows) {
      if (!bucketStats[row.bucket]) bucketStats[row.bucket] = { count: 0, totalHits: 0 };
      bucketStats[row.bucket].count++;
      bucketStats[row.bucket].totalHits += (row.hit_count || 0);
    }
    return j(200, { rows, bucketStats }, origin);
  } catch (e) {
    return j(502, { error: "query_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// -----------------------------------------------------------------------------
// op: admin-quote-cache — the market tape
// -----------------------------------------------------------------------------
async function opAdminQuoteCache(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  try {
    const r = await sbAdminFetch(`/rest/v1/quote_cache?select=*&order=updated_at.desc&limit=2000`);
    const rows = r.ok ? await r.json() : [];
    const now = Date.now();
    const annotated = rows.map(row => ({
      ...row,
      staleMs: row.cached_at_ms ? now - Number(row.cached_at_ms) : null,
    }));
    return j(200, { rows: annotated, count: rows.length }, origin);
  } catch (e) {
    return j(502, { error: "query_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// -----------------------------------------------------------------------------
// op: admin-dhan-coverage — symbols in dhan_instruments vs not
// -----------------------------------------------------------------------------
async function opAdminDhanCoverage(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  try {
    const r = await sbAdminFetch(`/rest/v1/dhan_instruments?select=*&limit=5000`);
    const rows = r.ok ? await r.json() : [];
    return j(200, { rows, count: rows.length }, origin);
  } catch (e) {
    return j(502, { error: "query_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// -----------------------------------------------------------------------------
// Shared utility: parse + validate write-op body.
// Every write op takes JSON { reason, ... }. reason is required ≥ 8 chars
// so the admin has to justify every mutation (logged to audit trail).
// -----------------------------------------------------------------------------
async function parseWriteBody(req) {
  let body;
  try { body = await req.json(); }
  catch { return { err: "bad_body" }; }
  const reason = String(body?.reason || "").trim();
  if (reason.length < 8) return { err: "reason_required" };
  return { body, reason };
}

// Fetch a single row by PK helper.
async function sbFetchOne(path) {
  try {
    const r = await sbAdminFetch(path);
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch { return null; }
}

// -----------------------------------------------------------------------------
// WRITE OPS — StockSaathi user data
// All require Authorization: Bearer <ADMIN_TOKEN> + JSON { reason, ... }.
// Every op is audit-logged before and after.
// -----------------------------------------------------------------------------

async function opAdminUserReset(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const userId = String(body?.userId || "").trim();
  if (!userId) return j(400, { error: "missing_userId" }, origin);

  const result = await auditWrap(req, {
    action: "user_reset", targetKind: "user", targetUserId: userId, targetId: userId, reason,
  }, async () => {
    const before = await sbFetchOne(`/rest/v1/portfolios?select=*&user_id=eq.${encodeURIComponent(userId)}`);
    const rpc = await sbAdminFetch(`/rest/v1/rpc/admin_reset_user`, {
      method: "POST",
      body: JSON.stringify({ p_user_id: userId }),
    });
    const rpcBody = rpc.ok ? await rpc.json() : { error: `rpc_failed_${rpc.status}` };
    const after = await sbFetchOne(`/rest/v1/portfolios?select=*&user_id=eq.${encodeURIComponent(userId)}`);
    return { beforeState: before, afterState: after, rpcBody, ok: rpc.ok };
  });
  if (!result.ok) return j(502, { error: "reset_failed", detail: result.rpcBody }, origin);
  return j(200, { ok: true, result: result.rpcBody }, origin);
}

async function opAdminUserBan(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const userId = String(body?.userId || "").trim();
  if (!userId) return j(400, { error: "missing_userId" }, origin);
  // Ban until either the provided bannedUntil (ISO) or 100 years from now.
  const until = body?.bannedUntil || new Date(Date.now() + 100 * 365 * 86400000).toISOString();

  const env = globalThis.process?.env || {};
  const result = await auditWrap(req, {
    action: "user_ban", targetKind: "user", targetUserId: userId, targetId: userId, reason,
    note: `banned_until=${until}`,
  }, async () => {
    const before = await sbFetchOne(`/rest/v1/profiles?select=*&id=eq.${encodeURIComponent(userId)}`);
    const r = await fetch(
      `${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      {
        method: "PUT",
        headers: {
          "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ban_duration: "876000h" }),  // ~100 years
      }
    );
    const rBody = r.ok ? await r.json() : await r.text();
    const after = await sbFetchOne(`/rest/v1/profiles?select=*&id=eq.${encodeURIComponent(userId)}`);
    return { beforeState: before, afterState: after, ok: r.ok, authBody: rBody };
  });
  if (!result.ok) return j(502, { error: "ban_failed", detail: result.authBody }, origin);
  return j(200, { ok: true, bannedUntil: until }, origin);
}

async function opAdminUserUnban(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const userId = String(body?.userId || "").trim();
  if (!userId) return j(400, { error: "missing_userId" }, origin);

  const env = globalThis.process?.env || {};
  const result = await auditWrap(req, {
    action: "user_unban", targetKind: "user", targetUserId: userId, targetId: userId, reason,
  }, async () => {
    const r = await fetch(
      `${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      {
        method: "PUT",
        headers: {
          "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ban_duration: "none" }),
      }
    );
    const rBody = r.ok ? await r.json() : await r.text();
    return { beforeState: { ban: "yes" }, afterState: { ban: "no" }, ok: r.ok, authBody: rBody };
  });
  if (!result.ok) return j(502, { error: "unban_failed", detail: result.authBody }, origin);
  return j(200, { ok: true }, origin);
}

async function opAdminUserDelete(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const userId = String(body?.userId || "").trim();
  const confirm = String(body?.confirm || "").trim();
  if (!userId) return j(400, { error: "missing_userId" }, origin);
  // Destructive tier: require the client to echo back the username as `confirm`.
  const profile = await sbFetchOne(`/rest/v1/profiles?select=username&id=eq.${encodeURIComponent(userId)}`);
  if (!profile) return j(404, { error: "not_found" }, origin);
  if (confirm !== profile.username) return j(400, { error: "confirm_mismatch", expected_form: "confirm must equal the user's username" }, origin);

  const env = globalThis.process?.env || {};
  const result = await auditWrap(req, {
    action: "user_delete", targetKind: "user", targetUserId: userId, targetId: userId, reason,
    note: `username=${profile.username}`,
  }, async () => {
    const before = await sbFetchOne(`/rest/v1/profiles?select=*&id=eq.${encodeURIComponent(userId)}`);
    const r = await fetch(
      `${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      {
        method: "DELETE",
        headers: {
          "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    return { beforeState: before, afterState: { deleted: true }, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "delete_failed" }, origin);
  return j(200, { ok: true, deleted: userId }, origin);
}

async function opAdminProfilePatch(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const userId = String(body?.userId || "").trim();
  const patch = body?.patch && typeof body.patch === "object" ? body.patch : null;
  if (!userId) return j(400, { error: "missing_userId" }, origin);
  if (!patch) return j(400, { error: "missing_patch" }, origin);

  // Whitelist editable columns — never let an admin accidentally rewrite id / created_at.
  const ALLOWED = new Set([
    "display_name", "email", "age", "school", "class_code", "city",
    "risk_profile", "avatar_color", "onboarded",
  ]);
  const cleanPatch = {};
  for (const [k, v] of Object.entries(patch)) if (ALLOWED.has(k)) cleanPatch[k] = v;
  if (Object.keys(cleanPatch).length === 0) return j(400, { error: "no_allowed_fields" }, origin);
  cleanPatch.updated_at = new Date().toISOString();

  const result = await auditWrap(req, {
    action: "profile_patch", targetKind: "user", targetUserId: userId, targetId: userId, reason,
    note: `fields=${Object.keys(cleanPatch).join(",")}`,
  }, async () => {
    const before = await sbFetchOne(`/rest/v1/profiles?select=*&id=eq.${encodeURIComponent(userId)}`);
    const r = await sbAdminFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { "Prefer": "return=representation" },
      body: JSON.stringify(cleanPatch),
    });
    const after = r.ok ? (await r.json())[0] : null;
    return { beforeState: before, afterState: after, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "patch_failed" }, origin);
  return j(200, { ok: true, profile: result.afterState }, origin);
}

async function opAdminOrderCancel(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const orderId = String(body?.orderId || "").trim();
  if (!orderId) return j(400, { error: "missing_orderId" }, origin);

  const result = await auditWrap(req, {
    action: "order_cancel", targetKind: "limit_order", targetId: orderId, reason,
  }, async () => {
    const before = await sbFetchOne(`/rest/v1/limit_orders?select=*&id=eq.${encodeURIComponent(orderId)}`);
    if (!before) return { beforeState: null, afterState: null, ok: false, reason: "not_found" };
    // Refund reserved cash if pending BUY, then mark cancelled.
    if (before.status === "pending" && before.side === "BUY" && before.reserved_cash) {
      await sbAdminFetch(`/rest/v1/portfolios?user_id=eq.${encodeURIComponent(before.user_id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          cash_paise: `\${cash_paise} + ${before.reserved_cash}`,  // won't work in REST; use RPC below if needed
        }),
      });
    }
    const r = await sbAdminFetch(`/rest/v1/limit_orders?id=eq.${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      headers: { "Prefer": "return=representation" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    const after = r.ok ? (await r.json())[0] : null;
    return { beforeState: before, afterState: after, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "cancel_failed", reason: result.reason }, origin);
  return j(200, { ok: true, order: result.afterState }, origin);
}

async function opAdminTradeDelete(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const txnId = String(body?.txnId || "").trim();
  if (!txnId) return j(400, { error: "missing_txnId" }, origin);

  const result = await auditWrap(req, {
    action: "trade_delete", targetKind: "transaction", targetId: txnId, reason,
  }, async () => {
    const before = await sbFetchOne(`/rest/v1/transactions?select=*&id=eq.${encodeURIComponent(txnId)}`);
    if (!before) return { beforeState: null, afterState: null, ok: false };
    const rpc = await sbAdminFetch(`/rest/v1/rpc/admin_reverse_trade`, {
      method: "POST",
      body: JSON.stringify({ p_txn_id: txnId }),
    });
    const rpcBody = rpc.ok ? await rpc.json() : null;
    return { beforeState: before, afterState: rpcBody, ok: rpc.ok };
  });
  if (!result.ok) return j(502, { error: "reverse_failed" }, origin);
  return j(200, { ok: true, result: result.afterState }, origin);
}

async function opAdminTransferVoid(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const transferId = String(body?.transferId || "").trim();
  if (!transferId) return j(400, { error: "missing_transferId" }, origin);

  const result = await auditWrap(req, {
    action: "transfer_void", targetKind: "transfer", targetId: transferId, reason,
  }, async () => {
    const before = await sbFetchOne(`/rest/v1/transfers?select=*&id=eq.${encodeURIComponent(transferId)}`);
    if (!before) return { beforeState: null, afterState: null, ok: false };
    const rpc = await sbAdminFetch(`/rest/v1/rpc/admin_refund_transfer`, {
      method: "POST",
      body: JSON.stringify({ p_transfer_id: transferId }),
    });
    const rpcBody = rpc.ok ? await rpc.json() : null;
    return { beforeState: before, afterState: rpcBody, ok: rpc.ok };
  });
  if (!result.ok) return j(502, { error: "refund_failed" }, origin);
  return j(200, { ok: true, result: result.afterState }, origin);
}

async function opAdminCoachDelete(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const msgId = String(body?.messageId || "").trim();
  if (!msgId) return j(400, { error: "missing_messageId" }, origin);

  const result = await auditWrap(req, {
    action: "coach_delete", targetKind: "coach_message", targetId: msgId, reason,
  }, async () => {
    const before = await sbFetchOne(`/rest/v1/coach_messages?select=*&id=eq.${encodeURIComponent(msgId)}`);
    const r = await sbAdminFetch(`/rest/v1/coach_messages?id=eq.${encodeURIComponent(msgId)}`, {
      method: "DELETE",
      headers: { "Prefer": "return=minimal" },
    });
    return { beforeState: before, afterState: { deleted: true }, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "delete_failed" }, origin);
  return j(200, { ok: true }, origin);
}

async function opAdminCacheInvalidate(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const cacheTable = String(body?.table || "").trim();
  if (!["ai_response_cache", "quote_cache"].includes(cacheTable))
    return j(400, { error: "bad_table" }, origin);

  // Two modes:
  //  - body.bucket + body.key → delete one row from ai_response_cache
  //  - body.symbol           → delete one row from quote_cache
  //  - body.bucket alone     → purge all rows in a bucket (requires confirm = bucket name)
  //  - body.purgeAll = true  → full wipe (requires confirm = table name)
  let filter = "";
  let note = "";
  if (cacheTable === "ai_response_cache") {
    if (body?.bucket && body?.key) {
      filter = `&bucket=eq.${encodeURIComponent(body.bucket)}&cache_key=eq.${encodeURIComponent(body.key)}`;
      note = `bucket=${body.bucket}, key=${body.key}`;
    } else if (body?.bucket) {
      if (String(body?.confirm || "") !== body.bucket) return j(400, { error: "confirm_mismatch" }, origin);
      filter = `&bucket=eq.${encodeURIComponent(body.bucket)}`;
      note = `bucket-purge=${body.bucket}`;
    } else if (body?.purgeAll) {
      if (String(body?.confirm || "") !== "ai_response_cache") return j(400, { error: "confirm_mismatch" }, origin);
      filter = "&cache_key=not.is.null";  // matches everything
      note = "full_cache_purge";
    } else {
      return j(400, { error: "bad_target" }, origin);
    }
  } else {
    // quote_cache
    if (body?.symbol) {
      filter = `&symbol=eq.${encodeURIComponent(body.symbol)}`;
      note = `symbol=${body.symbol}`;
    } else if (body?.purgeAll) {
      if (String(body?.confirm || "") !== "quote_cache") return j(400, { error: "confirm_mismatch" }, origin);
      filter = "&symbol=not.is.null";
      note = "full_quote_cache_purge";
    } else {
      return j(400, { error: "bad_target" }, origin);
    }
  }

  const result = await auditWrap(req, {
    action: "cache_invalidate", targetKind: cacheTable, targetId: null, reason, note,
  }, async () => {
    const r = await sbAdminFetch(`/rest/v1/${cacheTable}?${filter.slice(1)}`, {
      method: "DELETE",
      headers: { "Prefer": "return=minimal" },
    });
    return { beforeState: { filter, table: cacheTable }, afterState: { status: r.status, ok: r.ok }, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "invalidate_failed" }, origin);
  return j(200, { ok: true }, origin);
}

async function opAdminBackfillHistory(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const todayOnly = !!body?.todayOnly;

  const result = await auditWrap(req, {
    action: "backfill_history", targetKind: "system", targetId: todayOnly ? "today" : "full", reason,
  }, async () => {
    const r = await sbAdminFetch(`/rest/v1/rpc/admin_portfolio_backfill`, {
      method: "POST",
      body: JSON.stringify({ p_today_only: todayOnly }),
    });
    const rpcBody = r.ok ? await r.json() : await r.text();
    return { beforeState: { mode: todayOnly ? "today" : "full" }, afterState: rpcBody, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "backfill_failed", detail: result.afterState }, origin);
  return j(200, { ok: true, result: result.afterState }, origin);
}

// =============================================================================
// SUPABASE GOD MODE — SQL editor, table browser, RPC runner, schema, stats
// Everything you'd normally do in Supabase Studio, via service-role key.
// =============================================================================

// Execute arbitrary SQL via the admin_exec_sql(text) RPC we created.
async function execSql(sql) {
  const r = await sbAdminFetch(`/rest/v1/rpc/admin_exec_sql`, {
    method: "POST",
    body: JSON.stringify({ p_sql: sql }),
  });
  if (!r.ok) return { error: `rpc_http_${r.status}`, detail: await r.text() };
  const result = await r.json();
  if (result?.error) return { error: result.error, sqlstate: result.sqlstate };
  return { rows: result?.rows || [], count: result?.count || 0 };
}

// List every table in `public` schema with size + row-count estimate.
async function opAdminDbTables(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const sql = `
    select
      schemaname, relname as table_name,
      n_live_tup as approx_row_count,
      pg_size_pretty(pg_total_relation_size(('"'||schemaname||'"."'||relname||'"')::regclass)) as total_size,
      pg_total_relation_size(('"'||schemaname||'"."'||relname||'"')::regclass) as total_size_bytes
    from pg_stat_user_tables
    where schemaname = 'public'
    order by pg_total_relation_size(('"'||schemaname||'"."'||relname||'"')::regclass) desc
  `;
  const result = await execSql(sql);
  if (result.error) return j(502, result, origin);
  return j(200, { tables: result.rows }, origin);
}

// Paginated browse of arbitrary table.
// GET ?table=X&limit=&offset=&orderBy=&orderDir=&filter=col.eq.val
async function opAdminDbBrowse(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const table = String(url.searchParams.get("table") || "").trim();
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(table)) return j(400, { error: "bad_table" }, origin);
  const limit = Math.max(1, Math.min(1000, parseInt(url.searchParams.get("limit") || "100", 10)));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
  const orderBy = String(url.searchParams.get("orderBy") || "").trim();
  const orderDir = url.searchParams.get("orderDir") === "asc" ? "asc" : "desc";
  const filter = url.searchParams.get("filter") || "";

  let path = `/rest/v1/${table}?select=*&limit=${limit}&offset=${offset}`;
  if (orderBy && /^[a-z_][a-z0-9_]{0,40}$/.test(orderBy)) path += `&order=${orderBy}.${orderDir}`;
  if (filter) path += `&${filter}`;

  try {
    const r = await sbAdminFetch(path, {
      headers: { "Prefer": "count=exact", "Range-Unit": "items", "Range": `${offset}-${offset + limit - 1}` },
    });
    const rows = r.ok ? await r.json() : [];
    const cr = r.headers.get("content-range") || "";
    const m = cr.match(/\/(\d+)$/);
    const total = m ? parseInt(m[1], 10) : rows.length;
    return j(200, { rows, total, offset, limit }, origin);
  } catch (e) {
    return j(502, { error: "query_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// Update a single row in arbitrary table. Requires { table, filter, patch, reason }.
async function opAdminDbRowPatch(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const table = String(body?.table || "").trim();
  const filter = String(body?.filter || "").trim();
  const patch = body?.patch;
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(table)) return j(400, { error: "bad_table" }, origin);
  if (!filter) return j(400, { error: "missing_filter" }, origin);
  if (!patch || typeof patch !== "object") return j(400, { error: "missing_patch" }, origin);

  const result = await auditWrap(req, {
    action: "db_row_patch", targetKind: table, targetId: filter, reason,
    note: `fields=${Object.keys(patch).join(",")}`,
  }, async () => {
    const before = await sbAdminFetch(`/rest/v1/${table}?${filter}&select=*`);
    const beforeRows = before.ok ? await before.json() : [];
    const r = await sbAdminFetch(`/rest/v1/${table}?${filter}`, {
      method: "PATCH",
      headers: { "Prefer": "return=representation" },
      body: JSON.stringify(patch),
    });
    const afterRows = r.ok ? await r.json() : [];
    return { beforeState: beforeRows, afterState: afterRows, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "patch_failed" }, origin);
  return j(200, { ok: true, rows: result.afterState }, origin);
}

async function opAdminDbRowDelete(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const table = String(body?.table || "").trim();
  const filter = String(body?.filter || "").trim();
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(table)) return j(400, { error: "bad_table" }, origin);
  if (!filter) return j(400, { error: "missing_filter" }, origin);

  const result = await auditWrap(req, {
    action: "db_row_delete", targetKind: table, targetId: filter, reason,
  }, async () => {
    const before = await sbAdminFetch(`/rest/v1/${table}?${filter}&select=*`);
    const beforeRows = before.ok ? await before.json() : [];
    const r = await sbAdminFetch(`/rest/v1/${table}?${filter}`, {
      method: "DELETE",
      headers: { "Prefer": "return=minimal" },
    });
    return { beforeState: beforeRows, afterState: { deleted: beforeRows.length }, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "delete_failed" }, origin);
  return j(200, { ok: true }, origin);
}

async function opAdminDbRowInsert(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const table = String(body?.table || "").trim();
  const row = body?.row;
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(table)) return j(400, { error: "bad_table" }, origin);
  if (!row || typeof row !== "object") return j(400, { error: "missing_row" }, origin);

  const result = await auditWrap(req, {
    action: "db_row_insert", targetKind: table, targetId: null, reason,
    note: `cols=${Object.keys(row).join(",")}`,
  }, async () => {
    const r = await sbAdminFetch(`/rest/v1/${table}`, {
      method: "POST",
      headers: { "Prefer": "return=representation" },
      body: JSON.stringify(row),
    });
    const afterRows = r.ok ? await r.json() : [];
    return { beforeState: null, afterState: afterRows, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "insert_failed" }, origin);
  return j(200, { ok: true, rows: result.afterState }, origin);
}

// Execute arbitrary SQL via admin_exec_sql RPC. This IS a footgun; the
// frontend should double-confirm on any mutating query.
async function opAdminDbSql(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const sql = String(body?.sql || "").trim();
  if (!sql) return j(400, { error: "missing_sql" }, origin);
  if (sql.length > 50000) return j(413, { error: "sql_too_long" }, origin);

  const result = await auditWrap(req, {
    action: "db_sql_exec", targetKind: "sql", targetId: sql.slice(0, 80), reason,
    note: `sql_len=${sql.length}`,
  }, async () => {
    const r = await execSql(sql);
    return { beforeState: { sql: sql.slice(0, 500) }, afterState: r, ok: !r.error };
  });
  if (result.afterState?.error) return j(400, result.afterState, origin);
  return j(200, result.afterState, origin);
}

// Invoke an arbitrary Supabase RPC. { rpcName, params, reason }.
async function opAdminDbRpc(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const rpcName = String(body?.rpcName || "").trim();
  const params = body?.params && typeof body.params === "object" ? body.params : {};
  if (!/^[a-z_][a-z0-9_]{0,60}$/.test(rpcName)) return j(400, { error: "bad_rpc_name" }, origin);

  const result = await auditWrap(req, {
    action: "db_rpc_call", targetKind: "rpc", targetId: rpcName, reason,
    note: `params_keys=${Object.keys(params).join(",")}`,
  }, async () => {
    const r = await sbAdminFetch(`/rest/v1/rpc/${rpcName}`, {
      method: "POST",
      body: JSON.stringify(params),
    });
    const rpcBody = r.ok ? await r.json() : await r.text();
    return { beforeState: { rpcName, params }, afterState: rpcBody, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "rpc_failed", detail: result.afterState }, origin);
  return j(200, { ok: true, result: result.afterState }, origin);
}

// Schema introspection — tables, columns, policies, indexes, RPC signatures.
async function opAdminDbSchema(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);

  const [columnsRes, policiesRes, indexesRes, functionsRes] = await Promise.all([
    execSql(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position`),
    execSql(`select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check from pg_policies where schemaname = 'public' order by tablename, policyname`),
    execSql(`select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by tablename, indexname`),
    execSql(`select routine_name, routine_type, data_type as return_type from information_schema.routines where specific_schema = 'public' and routine_type = 'FUNCTION' order by routine_name`),
  ]);

  return j(200, {
    columns: columnsRes.rows || [],
    policies: policiesRes.rows || [],
    indexes: indexesRes.rows || [],
    functions: functionsRes.rows || [],
  }, origin);
}

// DB size + connection stats.
async function opAdminDbStats(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const [sizeRes, connsRes, hitRes] = await Promise.all([
    execSql(`select pg_size_pretty(pg_database_size(current_database())) as size, pg_database_size(current_database()) as bytes`),
    execSql(`select state, count(*)::int from pg_stat_activity where datname = current_database() group by state`),
    execSql(`select sum(blks_hit)::bigint as hits, sum(blks_read)::bigint as reads, (sum(blks_hit)::float / nullif(sum(blks_hit) + sum(blks_read), 0)::float) as hit_ratio from pg_stat_database where datname = current_database()`),
  ]);
  return j(200, {
    size: sizeRes.rows?.[0] || null,
    connections: connsRes.rows || [],
    cacheHitRatio: hitRes.rows?.[0] || null,
  }, origin);
}

// =============================================================================
// SUPABASE AUTH ADMIN — auth.users CRUD via /auth/v1/admin/*
// All use SUPABASE_SERVICE_ROLE_KEY on the Supabase Auth Admin API.
// =============================================================================

// Shared helper for Supabase Admin API calls.
async function supabaseAuthAdmin(path, opts = {}) {
  const env = globalThis.process?.env || {};
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("supabase_not_configured");
  return fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}${path}`, {
    ...opts,
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

async function opAdminAuthUsers(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const perPage = Math.max(1, Math.min(1000, parseInt(url.searchParams.get("perPage") || "200", 10)));
  try {
    const r = await supabaseAuthAdmin(`/auth/v1/admin/users?page=${page}&per_page=${perPage}`);
    if (!r.ok) return j(502, { error: `auth_http_${r.status}`, detail: await r.text() }, origin);
    const body = await r.json();
    // Supabase returns { users: [...], aud, nextPage, ... } or just an array.
    const users = Array.isArray(body?.users) ? body.users : Array.isArray(body) ? body : [];
    return j(200, {
      users: users.map(u => ({
        id: u.id,
        email: u.email,
        phone: u.phone,
        emailConfirmedAt: u.email_confirmed_at,
        phoneConfirmedAt: u.phone_confirmed_at,
        lastSignInAt: u.last_sign_in_at,
        bannedUntil: u.banned_until,
        invitedAt: u.invited_at,
        createdAt: u.created_at,
        updatedAt: u.updated_at,
        rawUserMetaData: u.raw_user_meta_data,
        rawAppMetaData: u.raw_app_meta_data,
        role: u.role,
        aud: u.aud,
        isAnonymous: u.is_anonymous,
      })),
      page, perPage, count: users.length,
    }, origin);
  } catch (e) {
    return j(502, { error: "auth_query_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

async function opAdminAuthReset(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const email = String(body?.email || "").trim().toLowerCase();
  if (!email) return j(400, { error: "missing_email" }, origin);

  const result = await auditWrap(req, {
    action: "auth_reset_password", targetKind: "auth_user", targetId: email, reason,
  }, async () => {
    const r = await supabaseAuthAdmin(`/auth/v1/recover`, {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    return { beforeState: { email }, afterState: { sent: r.ok, status: r.status }, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "reset_send_failed" }, origin);
  return j(200, { ok: true }, origin);
}

async function opAdminAuthMagicLink(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const email = String(body?.email || "").trim().toLowerCase();
  if (!email) return j(400, { error: "missing_email" }, origin);

  const result = await auditWrap(req, {
    action: "auth_magic_link", targetKind: "auth_user", targetId: email, reason,
  }, async () => {
    // Generate a magic link via the admin API.
    const r = await supabaseAuthAdmin(`/auth/v1/admin/generate_link`, {
      method: "POST",
      body: JSON.stringify({ type: "magiclink", email }),
    });
    const rb = r.ok ? await r.json() : await r.text();
    return { beforeState: { email }, afterState: rb, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "magic_link_failed", detail: result.afterState }, origin);
  return j(200, { ok: true, link: result.afterState?.action_link || null }, origin);
}

async function opAdminAuthUpdateEmail(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const userId = String(body?.userId || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  if (!userId || !email) return j(400, { error: "missing_fields" }, origin);

  const result = await auditWrap(req, {
    action: "auth_update_email", targetKind: "auth_user", targetUserId: userId, targetId: userId, reason,
    note: `new_email=${email}`,
  }, async () => {
    const r = await supabaseAuthAdmin(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "PUT",
      body: JSON.stringify({ email }),
    });
    const rb = r.ok ? await r.json() : await r.text();
    return { beforeState: { userId }, afterState: rb, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "update_failed" }, origin);
  return j(200, { ok: true }, origin);
}

// Admin: set a new password for a user. Bypasses email — admin just types
// a new password in the admin panel and the user can log in with it. Use
// case: user can't/won't use the password-reset email flow.
// Supabase stores passwords as bcrypt one-way hashes, so this is the ONLY
// way to issue a working known password (even raw DB access can't decrypt).
async function opAdminAuthSetPassword(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const userId = String(body?.userId || "").trim();
  const password = String(body?.password || "");
  if (!userId) return j(400, { error: "missing_userId" }, origin);
  if (password.length < 8) return j(400, { error: "password_too_short" }, origin);
  if (password.length > 128) return j(400, { error: "password_too_long" }, origin);

  const result = await auditWrap(req, {
    action: "auth_set_password", targetKind: "auth_user", targetUserId: userId, targetId: userId, reason,
    note: `password_length=${password.length}`,   // don't log the plaintext password
  }, async () => {
    const r = await supabaseAuthAdmin(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "PUT",
      body: JSON.stringify({ password }),
    });
    const rb = r.ok ? await r.json() : await r.text();
    return { beforeState: { userId }, afterState: { updated: r.ok, status: r.status }, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "password_set_failed" }, origin);
  return j(200, { ok: true }, origin);
}

// Public: resolve a username to an email address for the login flow. Runs
// with service_role to bypass RLS (anon users can't SELECT the email column
// on profiles they don't own, which is what's been breaking username logins
// with "No account with that username"). Intentionally only returns the
// email — never username/display_name/age/etc. Any attacker can already
// enumerate usernames from leaderboards, so leaking email-existence for a
// username isn't a new attack surface.
async function opAuthResolveUsername(req, origin) {
  let body;
  try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const username = String(body?.username || "").trim().toLowerCase().replace(/^@/, "");
  if (!username) return j(400, { error: "missing_username" }, origin);
  if (!/^[a-z0-9_.-]{1,40}$/.test(username)) return j(400, { error: "bad_username" }, origin);
  try {
    const r = await sbAdminFetch(
      `/rest/v1/profiles?select=email&username=ilike.${encodeURIComponent(username)}&limit=1`
    );
    if (!r.ok) return j(502, { error: "lookup_failed" }, origin);
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length || !rows[0].email) {
      return j(404, { error: "not_found" }, origin);
    }
    return j(200, { email: rows[0].email }, origin);
  } catch (e) {
    return j(502, { error: "resolve_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

async function opAdminAuthForceConfirm(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const userId = String(body?.userId || "").trim();
  if (!userId) return j(400, { error: "missing_userId" }, origin);

  const result = await auditWrap(req, {
    action: "auth_force_confirm", targetKind: "auth_user", targetUserId: userId, targetId: userId, reason,
  }, async () => {
    const r = await supabaseAuthAdmin(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "PUT",
      body: JSON.stringify({ email_confirm: true }),
    });
    return { beforeState: { userId }, afterState: { confirmed: r.ok }, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "confirm_failed" }, origin);
  return j(200, { ok: true }, origin);
}

// =============================================================================
// VERCEL PROXY — deployments, logs, envs, redeploy, rollback, domains
// Requires VERCEL_TOKEN + VERCEL_TEAM_ID (optional) + VERCEL_PROJECT_ID.
// https://vercel.com/docs/rest-api
// =============================================================================

const VERCEL_BASE = "https://api.vercel.com";

async function vercelFetch(path, opts = {}) {
  const env = globalThis.process?.env || {};
  if (!env.VERCEL_TOKEN) throw new Error("vercel_not_configured");
  const teamId = env.VERCEL_TEAM_ID;
  const sep = path.includes("?") ? "&" : "?";
  const pathWithTeam = teamId ? `${path}${sep}teamId=${encodeURIComponent(teamId)}` : path;
  return fetch(`${VERCEL_BASE}${pathWithTeam}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${env.VERCEL_TOKEN}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

async function opAdminVercelDeployments(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const env = globalThis.process?.env || {};
  if (!env.VERCEL_TOKEN) return j(501, { error: "vercel_not_configured" }, origin);
  const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "30", 10)));
  const target = url.searchParams.get("target") || ""; // 'production' or ''
  let path = `/v6/deployments?projectId=${encodeURIComponent(env.VERCEL_PROJECT_ID || "")}&limit=${limit}`;
  if (target === "production") path += "&target=production";
  try {
    const r = await vercelFetch(path);
    if (!r.ok) return j(502, { error: `vercel_http_${r.status}`, detail: await r.text() }, origin);
    const body = await r.json();
    return j(200, body, origin);
  } catch (e) {
    return j(502, { error: "vercel_fetch_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

async function opAdminVercelDeployment(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const id = String(url.searchParams.get("id") || "").trim();
  if (!id) return j(400, { error: "missing_id" }, origin);
  try {
    const r = await vercelFetch(`/v13/deployments/${encodeURIComponent(id)}`);
    if (!r.ok) return j(502, { error: `vercel_http_${r.status}`, detail: await r.text() }, origin);
    return j(200, await r.json(), origin);
  } catch (e) {
    return j(502, { error: "vercel_fetch_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

async function opAdminVercelLogs(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const id = String(url.searchParams.get("id") || "").trim();
  if (!id) return j(400, { error: "missing_id" }, origin);
  try {
    const r = await vercelFetch(`/v3/deployments/${encodeURIComponent(id)}/events?builds=1&direction=forward&limit=500`);
    if (!r.ok) return j(502, { error: `vercel_http_${r.status}`, detail: await r.text() }, origin);
    return j(200, { events: await r.json() }, origin);
  } catch (e) {
    return j(502, { error: "vercel_fetch_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

async function opAdminVercelEnvs(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const env = globalThis.process?.env || {};
  if (!env.VERCEL_PROJECT_ID) return j(501, { error: "vercel_project_id_missing" }, origin);
  try {
    const r = await vercelFetch(`/v10/projects/${encodeURIComponent(env.VERCEL_PROJECT_ID)}/env`);
    if (!r.ok) return j(502, { error: `vercel_http_${r.status}`, detail: await r.text() }, origin);
    const body = await r.json();
    const envs = Array.isArray(body?.envs) ? body.envs : [];
    // Mask values: show last 4 chars + length only.
    const masked = envs.map(e => ({
      id: e.id,
      key: e.key,
      type: e.type,
      target: e.target,
      gitBranch: e.gitBranch,
      comment: e.comment,
      maskedValue: e.value ? `${"•".repeat(Math.max(0, Math.min(12, e.value.length - 4)))}${e.value.slice(-4)}` : null,
      valueLength: e.value ? e.value.length : 0,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }));
    return j(200, { envs: masked }, origin);
  } catch (e) {
    return j(502, { error: "vercel_fetch_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

async function opAdminVercelEnvPatch(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const env = globalThis.process?.env || {};
  if (!env.VERCEL_PROJECT_ID) return j(501, { error: "vercel_project_id_missing" }, origin);

  // Three modes: create, update, delete
  const action = body?.action;  // 'create' | 'update' | 'delete'
  const key = String(body?.key || "").trim();
  const confirm = String(body?.confirm || "").trim();
  if (!key) return j(400, { error: "missing_key" }, origin);
  // Destructive-tier: require confirm=key echo for any env var change
  if (confirm !== key) return j(400, { error: "confirm_mismatch", expected: "confirm must equal the env var name" }, origin);

  const result = await auditWrap(req, {
    action: `vercel_env_${action}`, targetKind: "env_var", targetId: key, reason,
  }, async () => {
    const projId = encodeURIComponent(env.VERCEL_PROJECT_ID);
    let r;
    if (action === "create") {
      r = await vercelFetch(`/v10/projects/${projId}/env`, {
        method: "POST",
        body: JSON.stringify({
          key, value: body?.value || "",
          type: body?.type || "encrypted",
          target: body?.target || ["production", "preview", "development"],
        }),
      });
    } else if (action === "update") {
      const envId = String(body?.envId || "").trim();
      if (!envId) return { beforeState: null, afterState: { error: "missing_envId" }, ok: false };
      r = await vercelFetch(`/v9/projects/${projId}/env/${encodeURIComponent(envId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          value: body?.value,
          target: body?.target || undefined,
        }),
      });
    } else if (action === "delete") {
      const envId = String(body?.envId || "").trim();
      if (!envId) return { beforeState: null, afterState: { error: "missing_envId" }, ok: false };
      r = await vercelFetch(`/v9/projects/${projId}/env/${encodeURIComponent(envId)}`, {
        method: "DELETE",
      });
    } else {
      return { beforeState: null, afterState: { error: "bad_action" }, ok: false };
    }
    const rb = r.ok ? await r.json().catch(() => ({})) : await r.text();
    // Never log the value — audit log redacts.
    return { beforeState: { key, action }, afterState: { ok: r.ok, status: r.status }, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "env_patch_failed", detail: result.afterState }, origin);
  return j(200, { ok: true }, origin);
}

async function opAdminVercelRedeploy(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const id = String(body?.deploymentId || "").trim();
  if (!id) return j(400, { error: "missing_deploymentId" }, origin);

  const result = await auditWrap(req, {
    action: "vercel_redeploy", targetKind: "deployment", targetId: id, reason,
  }, async () => {
    // Vercel's "redeploy" endpoint takes the source deployment and produces a new one.
    const r = await vercelFetch(`/v13/deployments`, {
      method: "POST",
      body: JSON.stringify({
        name: "stocksaathi-redeploy",
        deploymentId: id,
      }),
    });
    const rb = r.ok ? await r.json() : await r.text();
    return { beforeState: { sourceId: id }, afterState: rb, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "redeploy_failed", detail: result.afterState }, origin);
  return j(200, { ok: true, new_deployment: result.afterState }, origin);
}

async function opAdminVercelRollback(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const id = String(body?.deploymentId || "").trim();
  const confirm = String(body?.confirm || "").trim();
  if (!id) return j(400, { error: "missing_deploymentId" }, origin);
  if (confirm !== id.slice(-8)) return j(400, { error: "confirm_mismatch", expected: "confirm must equal last 8 chars of deployment id" }, origin);

  const result = await auditWrap(req, {
    action: "vercel_rollback", targetKind: "deployment", targetId: id, reason,
  }, async () => {
    // Vercel "promote" / rollback uses the alias API to point production
    // alias at an old deployment.
    const env = globalThis.process?.env || {};
    const r = await vercelFetch(`/v9/projects/${encodeURIComponent(env.VERCEL_PROJECT_ID || "")}/promote/${encodeURIComponent(id)}`, {
      method: "POST",
    });
    return { beforeState: { target_deployment: id }, afterState: { ok: r.ok, status: r.status }, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "rollback_failed" }, origin);
  return j(200, { ok: true }, origin);
}

async function opAdminVercelDomains(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const env = globalThis.process?.env || {};
  if (!env.VERCEL_PROJECT_ID) return j(501, { error: "vercel_project_id_missing" }, origin);
  try {
    const r = await vercelFetch(`/v9/projects/${encodeURIComponent(env.VERCEL_PROJECT_ID)}/domains`);
    if (!r.ok) return j(502, { error: `vercel_http_${r.status}`, detail: await r.text() }, origin);
    return j(200, await r.json(), origin);
  } catch (e) {
    return j(502, { error: "vercel_fetch_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// =============================================================================
// GITHUB PROXY — commits, PRs, issues, Actions, workflow dispatch.
// Requires GITHUB_TOKEN + GITHUB_REPO (literal 'owner/repo').
// https://docs.github.com/en/rest
// =============================================================================

const GH_BASE = "https://api.github.com";

async function ghFetch(path, opts = {}) {
  const env = globalThis.process?.env || {};
  if (!env.GITHUB_TOKEN) throw new Error("github_not_configured");
  return fetch(`${GH_BASE}${path}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
}

function ghRepo() {
  const env = globalThis.process?.env || {};
  return env.GITHUB_REPO || "aliarbab2009/StockSaathi";
}

async function opAdminGhCommits(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const branch = url.searchParams.get("branch") || "main";
  const per = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "30", 10)));
  try {
    const r = await ghFetch(`/repos/${ghRepo()}/commits?sha=${encodeURIComponent(branch)}&per_page=${per}`);
    if (!r.ok) return j(502, { error: `gh_http_${r.status}`, detail: await r.text() }, origin);
    const rows = await r.json();
    return j(200, {
      commits: rows.map(c => ({
        sha: c.sha,
        shortSha: c.sha.slice(0, 7),
        message: (c.commit?.message || "").split("\n")[0],
        fullMessage: c.commit?.message,
        author: c.commit?.author?.name,
        authorEmail: c.commit?.author?.email,
        authorLogin: c.author?.login,
        date: c.commit?.author?.date,
        url: c.html_url,
      })),
    }, origin);
  } catch (e) {
    return j(502, { error: "gh_fetch_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

async function opAdminGhPrs(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const state = url.searchParams.get("state") || "open";
  const per = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "30", 10)));
  try {
    const r = await ghFetch(`/repos/${ghRepo()}/pulls?state=${encodeURIComponent(state)}&per_page=${per}`);
    if (!r.ok) return j(502, { error: `gh_http_${r.status}`, detail: await r.text() }, origin);
    return j(200, { prs: await r.json() }, origin);
  } catch (e) {
    return j(502, { error: "gh_fetch_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

async function opAdminGhPr(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const id = String(url.searchParams.get("id") || "").trim();
  if (!id) return j(400, { error: "missing_id" }, origin);
  try {
    const r = await ghFetch(`/repos/${ghRepo()}/pulls/${encodeURIComponent(id)}`);
    if (!r.ok) return j(502, { error: `gh_http_${r.status}`, detail: await r.text() }, origin);
    return j(200, await r.json(), origin);
  } catch (e) {
    return j(502, { error: "gh_fetch_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

async function opAdminGhIssues(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const state = url.searchParams.get("state") || "open";
  const per = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "30", 10)));
  try {
    const r = await ghFetch(`/repos/${ghRepo()}/issues?state=${encodeURIComponent(state)}&per_page=${per}&filter=all`);
    if (!r.ok) return j(502, { error: `gh_http_${r.status}`, detail: await r.text() }, origin);
    // GitHub includes PRs in /issues — filter out ones with pull_request set.
    const rows = (await r.json()).filter(i => !i.pull_request);
    return j(200, { issues: rows }, origin);
  } catch (e) {
    return j(502, { error: "gh_fetch_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

async function opAdminGhActionsRuns(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const per = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "30", 10)));
  try {
    const r = await ghFetch(`/repos/${ghRepo()}/actions/runs?per_page=${per}`);
    if (!r.ok) return j(502, { error: `gh_http_${r.status}`, detail: await r.text() }, origin);
    return j(200, await r.json(), origin);
  } catch (e) {
    return j(502, { error: "gh_fetch_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

async function opAdminGhBranches(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  try {
    const r = await ghFetch(`/repos/${ghRepo()}/branches?per_page=100`);
    if (!r.ok) return j(502, { error: `gh_http_${r.status}`, detail: await r.text() }, origin);
    return j(200, { branches: await r.json() }, origin);
  } catch (e) {
    return j(502, { error: "gh_fetch_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

async function opAdminGhContributors(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  try {
    const r = await ghFetch(`/repos/${ghRepo()}/contributors?per_page=100`);
    if (!r.ok) return j(502, { error: `gh_http_${r.status}`, detail: await r.text() }, origin);
    return j(200, { contributors: await r.json() }, origin);
  } catch (e) {
    return j(502, { error: "gh_fetch_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

async function opAdminGhIssueClose(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const id = String(body?.issueId || "").trim();
  if (!id) return j(400, { error: "missing_issueId" }, origin);

  const result = await auditWrap(req, {
    action: "gh_issue_close", targetKind: "issue", targetId: id, reason,
  }, async () => {
    const r = await ghFetch(`/repos/${ghRepo()}/issues/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    });
    return { beforeState: { issueId: id, state: "open" }, afterState: { ok: r.ok }, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "close_failed" }, origin);
  return j(200, { ok: true }, origin);
}

async function opAdminGhPrMerge(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const id = String(body?.prId || "").trim();
  const confirm = String(body?.confirm || "").trim();
  if (!id) return j(400, { error: "missing_prId" }, origin);
  // Destructive-tier: confirm must equal pr number
  if (confirm !== id) return j(400, { error: "confirm_mismatch", expected: "confirm must equal the PR number" }, origin);

  const result = await auditWrap(req, {
    action: "gh_pr_merge", targetKind: "pull_request", targetId: id, reason,
  }, async () => {
    const r = await ghFetch(`/repos/${ghRepo()}/pulls/${encodeURIComponent(id)}/merge`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        merge_method: body?.mergeMethod || "squash",
        commit_title: body?.commitTitle,
        commit_message: body?.commitMessage,
      }),
    });
    const rb = r.ok ? await r.json() : await r.text();
    return { beforeState: { prId: id }, afterState: rb, ok: r.ok };
  });
  if (!result.ok) return j(502, { error: "merge_failed", detail: result.afterState }, origin);
  return j(200, { ok: true, merged: result.afterState }, origin);
}

async function opAdminGhWorkflowTrigger(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const parsed = await parseWriteBody(req);
  if (parsed.err) return j(400, { error: parsed.err }, origin);
  const { body, reason } = parsed;
  const workflow = String(body?.workflow || "").trim();
  const ref = body?.ref || "main";
  const inputs = body?.inputs || {};
  if (!workflow) return j(400, { error: "missing_workflow" }, origin);

  const result = await auditWrap(req, {
    action: "gh_workflow_trigger", targetKind: "workflow", targetId: workflow, reason,
    note: `ref=${ref}`,
  }, async () => {
    const r = await ghFetch(`/repos/${ghRepo()}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref, inputs }),
    });
    // 204 is success per GH docs.
    return { beforeState: { workflow, ref }, afterState: { ok: r.ok, status: r.status }, ok: r.status === 204 || r.ok };
  });
  if (!result.ok) return j(502, { error: "dispatch_failed" }, origin);
  return j(200, { ok: true }, origin);
}

// =============================================================================
// SSE LIVE TAIL — unified event stream of trades / coach / transfers / orders
// / signups / admin-actions, emitted as Server-Sent Events.
//
// Why poll-based, not Supabase-realtime-proxied:
// A clean SSE from realtime would require a persistent server connection and
// Vercel Edge runtime has short-lived request limits. Instead, this endpoint
// is a long-polling SSE that wakes up every 2 seconds, asks Supabase for any
// rows newer than the last seen watermark across every relevant table, and
// emits them as SSE events. Connection auto-closes after 4 minutes; client
// reconnects (EventSource does this for free) with the last-seen watermark.
//
// Client must connect with ?token=<ADMIN_TOKEN> (query arg; EventSource
// doesn't let you set headers). Treated with same constant-time compare as
// the bearer path.
// =============================================================================

function checkAdminQuery(url) {
  const env = globalThis.process?.env || {};
  const expected = (env.ADMIN_TOKEN || "").trim();
  const token = String(url.searchParams.get("token") || "").trim();
  if (!expected || !token) return { ok: false, reason: "missing_token" };
  if (token.length !== expected.length) return { ok: false, reason: "bad_token" };
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, reason: "bad_token" };
}

async function opAdminTail(req, origin) {
  const url = new URL(req.url);
  const gate = checkAdminQuery(url);
  if (!gate.ok) return new Response("not_authorised", { status: 401 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Watermark: where each table left off. Start from "now" unless the
      // client sent a ?since=<iso> to resume from a specific timestamp.
      let since = url.searchParams.get("since") || new Date().toISOString();
      const endAt = Date.now() + 4 * 60 * 1000;

      function send(event, data) {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {}
      }

      send("open", { since, ts: new Date().toISOString() });

      const tables = [
        { name: "transactions",   kind: "trade",   timeCol: "created_at" },
        { name: "coach_messages", kind: "coach",   timeCol: "created_at" },
        { name: "transfers",      kind: "transfer",timeCol: "created_at" },
        { name: "limit_orders",   kind: "order",   timeCol: "created_at" },
        { name: "profiles",       kind: "signup",  timeCol: "created_at" },
        { name: "admin_audit_log",kind: "admin",   timeCol: "ts" },
      ];

      while (Date.now() < endAt) {
        try {
          const results = await Promise.all(tables.map(async t => {
            try {
              const path = `/rest/v1/${t.name}?select=*&${t.timeCol}=gt.${encodeURIComponent(since)}&order=${t.timeCol}.asc&limit=100`;
              const r = await sbAdminFetch(path);
              if (!r.ok) return [];
              const rows = await r.json();
              return rows.map(row => ({ kind: t.kind, table: t.name, ts: row[t.timeCol], row }));
            } catch { return []; }
          }));
          const events = results.flat().sort((a, b) => (a.ts < b.ts ? -1 : 1));
          if (events.length) {
            for (const ev of events) send(ev.kind, ev);
            since = events[events.length - 1].ts;
          }
        } catch {}
        // Heartbeat every iteration so clients know we're alive.
        send("hb", { ts: new Date().toISOString(), since });
        await new Promise(r => setTimeout(r, 2000));
      }
      send("close", { reason: "duration_exceeded", since });
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": allowed(origin) || "*",
    },
  });
}

// -----------------------------------------------------------------------------
// op: admin-audit-log — recent admin actions
// -----------------------------------------------------------------------------
async function opAdminAuditLog(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const limit = Math.max(1, Math.min(1000, parseInt(url.searchParams.get("limit") || "200", 10)));
  const targetUserId = url.searchParams.get("targetUserId") || null;
  const action = url.searchParams.get("action") || null;
  let q = `/rest/v1/admin_audit_log?select=*&order=ts.desc&limit=${limit}`;
  if (targetUserId) q += `&target_user_id=eq.${encodeURIComponent(targetUserId)}`;
  if (action)       q += `&action=eq.${encodeURIComponent(action)}`;
  try {
    const r = await sbAdminFetch(q);
    const rows = r.ok ? await r.json() : [];
    return j(200, { rows, count: rows.length }, origin);
  } catch (e) {
    return j(502, { error: "query_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// -----------------------------------------------------------------------------
// op: signup-count — how many new profiles landed today (IST), this week, all-time.
// Uses SUPABASE_SERVICE_ROLE_KEY to bypass RLS on profiles. Public-read
// numeric count only — no PII leaked.
// -----------------------------------------------------------------------------
async function opSignupCount(req, origin) {
  const env = globalThis.process?.env || {};
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return j(501, { error: "supabase_not_configured" }, origin);
  }

  const url = new URL(req.url);
  const detailed = url.searchParams.get("detailed") === "1";
  const days = Math.max(1, Math.min(60, parseInt(url.searchParams.get("days") || "14", 10)));

  // IST day-start for "today" in UTC
  const nowIst = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  const istDayStartIso = `${nowIst.year}-${nowIst.month}-${nowIst.day}T00:00:00+05:30`;
  const weekAgoIso = new Date(Date.now() - 7 * 86400000).toISOString();
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

  async function sbFetch(path) {
    return fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}${path}`, {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
  }

  async function count(filter) {
    const r = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/profiles?select=id${filter ? "&" + filter : ""}`, {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Prefer": "count=exact",
        "Range-Unit": "items",
        "Range": "0-0",
      },
    });
    const cr = r.headers.get("content-range") || "";
    const m = cr.match(/\/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  }

  try {
    const [today, week, total] = await Promise.all([
      count(`created_at=gte.${encodeURIComponent(istDayStartIso)}`),
      count(`created_at=gte.${encodeURIComponent(weekAgoIso)}`),
      count(""),
    ]);

    // Day-by-day breakdown (last N days, IST-bucketed)
    const recentRes = await sbFetch(`/rest/v1/profiles?select=id,created_at&created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.desc&limit=2000`);
    const recentRows = recentRes.ok ? await recentRes.json() : [];
    const byDay = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
      byDay[`${parts.year}-${parts.month}-${parts.day}`] = 0;
    }
    for (const row of recentRows) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date(row.created_at)).reduce((a, p) => (a[p.type] = p.value, a), {});
      const k = `${parts.year}-${parts.month}-${parts.day}`;
      if (k in byDay) byDay[k]++;
    }
    const byDayArr = Object.entries(byDay)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, count]) => ({ day, count }));

    const base = { today, week, total, byDay: byDayArr, asOf: new Date().toISOString() };
    if (!detailed) return j(200, base, origin);

    // Detailed mode — include the actual user rows (capped) + aggregate
    // stats per user. Server-role only; anyone hitting ?detailed=1 gets
    // real PII, so consider gating with a shared admin token before you
    // expose this beyond your own dashboard.
    const profilesRes = await sbFetch(`/rest/v1/profiles?select=id,username,display_name,email,age,school,city,risk_profile,onboarded,created_at&order=created_at.desc&limit=200`);
    const profiles = profilesRes.ok ? await profilesRes.json() : [];

    const portRes = await sbFetch(`/rest/v1/portfolios?select=user_id,cash_paise,starting_cash_paise,updated_at&limit=2000`);
    const ports = portRes.ok ? await portRes.json() : [];
    const portByUser = {};
    for (const p of ports) portByUser[p.user_id] = p;

    const txRes = await sbFetch(`/rest/v1/transactions?select=user_id&limit=5000`);
    const txs = txRes.ok ? await txRes.json() : [];
    const tradeCountByUser = {};
    for (const t of txs) tradeCountByUser[t.user_id] = (tradeCountByUser[t.user_id] || 0) + 1;

    const users = profiles.map(p => ({
      id: p.id,
      username: p.username,
      displayName: p.display_name,
      email: p.email,
      age: p.age,
      school: p.school,
      city: p.city,
      riskProfile: p.risk_profile,
      onboarded: p.onboarded,
      createdAt: p.created_at,
      cashRupees: portByUser[p.id] ? Math.round((portByUser[p.id].cash_paise || 0) / 100) : null,
      startingCashRupees: portByUser[p.id] ? Math.round((portByUser[p.id].starting_cash_paise || 100000) / 100) : 100000,
      tradeCount: tradeCountByUser[p.id] || 0,
      lastActive: portByUser[p.id]?.updated_at || p.created_at,
    }));

    return j(200, { ...base, users }, origin);
  } catch (e) {
    return j(502, { error: "query_failed", detail: String(e.message).slice(0, 100) }, origin);
  }
}
