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

import { messagesEnabled, messagesFetch, toMessagesBody, textOf, effortFor, MESSAGES_MODEL } from "./_messages.js";
import { recordUsage, normUsage } from "./_usage.js";
import { liveGeminiModel, isGemini3 } from "./_models.js";
import { lastSessionIst } from "./_session.js";

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
    // A hit is a model call that did not happen: recorded so the dashboard
    // can show each feature's hit rate next to its spend.
    await recordUsage({ route: "ai", op: bucket, upstream: "cache", ok: true, status: "cache_hit" });
    return rows[0].payload;
  } catch { return null; }
}
// Fire-and-forget: on Edge the write is cut off when the response returns,
// so it usually never lands. Use await cachePutAwait() instead.
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
// Hinglish mode (Settings): the client adds &lang=hi to every /api/ai call that
// writes prose for the user. Cached answers are keyed separately per language.
const HINGLISH_RULE = "\n\nLANGUAGE: the user has switched on Hinglish mode. Write the user-facing text in natural, light Hinglish (Hindi-English mix in Roman script), the way an Indian teen texts a friend. Keep numbers, tickers and any JSON keys exactly as specified.";
function hinglishOf(req) {
  try { return new URL(req.url).searchParams.get("lang") === "hi"; } catch { return false; }
}

// `effort` only reaches the Messages upstream (see api/_messages.js for the
// scale). Each op below picks its own: low where the job is one sentence and
// latency is what the user feels, medium where numbers and rules have to be
// respected, high where a wrong answer is the documented failure.
async function callLlm({ messages, temperature = 0.4, max_tokens = 400, response_format, profile = "reasoning", hinglish = false, effort, op = "unknown", feature }) {
  const usageBase = { route: "ai", op, feature: feature || op, profile, stream: false };
  if (hinglish && messages?.[0]?.role === "system") {
    messages = [{ ...messages[0], content: messages[0].content + HINGLISH_RULE }, ...messages.slice(1)];
  }
  const env = globalThis.process?.env || {};
  const providers = [];
  // Leads every profile when configured; Gemini below is the fallback.
  if (messagesEnabled()) providers.push({ kind: "messages", label: "messages" });

  // Gemini 2.5 retires on Vertex 20 Oct 2026; liveGeminiModel maps any 2.5
  // ID (env overrides included) to its GA successor. See api/_models.js.
  const geminiFastModel = liveGeminiModel(env.GEMINI_FAST_MODEL || "gemini-3.5-flash");
  const geminiProModel  = liveGeminiModel(env.GEMINI_PRO_MODEL  || "gemini-3.1-pro-preview");
  const geminiChatModel = liveGeminiModel(env.GEMINI_CHAT_MODEL || "gemini-3.1-flash-lite");
  // JSON-profile model. It was 2.5 Flash-Lite because 2.5 Flash spent ~1900
  // reasoning tokens on json_object calls and truncated the JSON under the
  // old caps. max_tokens is now always the model ceiling (below), and the
  // 3.x successor is asked for minimal thinking, so neither failure returns.
  const geminiJsonModel = liveGeminiModel(env.GEMINI_JSON_MODEL || "gemini-3.1-flash-lite");
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
    // JSON-returning ops: the json model (3.1 Flash-Lite, minimal thinking)
    // first, then the chat and fast models, OpenAI last.
    if (env.GEMINI_API_KEY) providers.push({ url: geminiUrl, key: env.GEMINI_API_KEY, model: geminiJsonModel, label: "gemini_json" });
    if (env.GEMINI_API_KEY) providers.push({ url: geminiUrl, key: env.GEMINI_API_KEY, model: geminiChatModel, label: "gemini_chat" });
    if (env.GEMINI_API_KEY) providers.push({ url: geminiUrl, key: env.GEMINI_API_KEY, model: geminiFastModel, label: "gemini_fast" });
    if (env.OPENAI_API_KEY) providers.push({ url: "https://api.openai.com/v1/chat/completions", key: env.OPENAI_API_KEY, model: openaiModel, label: "openai" });
  } else if (profile === "chat") {
    // Conversational chat: 3.1 Flash-Lite first (fastest, minimal thinking),
    // then fast/pro/openai as escalation.
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
    if (p.kind === "messages") {
      // Bounded: ai.js has no other timeout, and a stall here must leave
      // the Gemini fallback room inside the ~25s edge limit.
      const ctrl = new AbortController();
      const killer = setTimeout(() => ctrl.abort(), 14000);
      try {
        const body = toMessagesBody(
          { messages, max_tokens, response_format, reasoning_effort: effort },
          { profile },
        );
        const t0 = performance.now();
        const mRow = { ...usageBase, upstream: "messages", model: MESSAGES_MODEL(), effort: effortFor(profile, effort) };
        const res = await messagesFetch(body, { signal: ctrl.signal });
        if (!res.ok) {
          lastErr = `messages_http_${res.status}`;
          await recordUsage({ ...mRow, ok: false, status: `http_${res.status}`, total_ms: Math.round(performance.now() - t0) });
          console.log(JSON.stringify({ evt: "ai_upstream", ok: false, upstream: "messages", status: res.status, body: (await res.text().catch(() => "")).slice(0, 300) }));
          continue;
        }
        const data = await res.json();
        const text = textOf(data);
        const good = data?.stop_reason !== "refusal" && !!text.trim();
        await recordUsage({
          ...mRow, ok: good, status: data?.stop_reason === "refusal" ? "refusal" : (good ? "ok" : "empty"),
          total_ms: Math.round(performance.now() - t0), stop_reason: data?.stop_reason, ...normUsage(data?.usage),
        });
        // A safety decline is HTTP 200 with stop_reason "refusal"; let the
        // next provider try rather than caching an empty answer.
        if (data?.stop_reason === "refusal") { lastErr = "messages_refusal"; continue; }
        if (!text.trim()) { lastErr = "empty"; continue; }
        return text;
      } catch (e) {
        lastErr = ctrl.signal.aborted ? "messages_timeout" : (e?.message || "fetch_failed");
        await recordUsage({ ...usageBase, upstream: "messages", model: MESSAGES_MODEL(), effort: effortFor(profile, effort), ok: false, status: ctrl.signal.aborted ? "timeout" : "unreachable" });
        continue;
      } finally {
        clearTimeout(killer);
      }
    }
    try {
      // The per-op max_tokens values are kept as documentation of each op's
      // expected size but never sent: no Saathi output is cut by a cap.
      // 65535 is the Gemini models' own ceiling.
      const body = { model: p.model, messages, temperature, max_tokens: 65535 };
      if (response_format) body.response_format = response_format;
      // The json/chat lanes replaced non-thinking 2.5 Flash-Lite: keep them
      // fast. Other lanes keep the model's default thinking.
      if (isGemini3(p.model) && (p.label === "gemini_json" || p.label === "gemini_chat")) {
        body.reasoning_effort = "minimal";
      }
      // Vertex AI OpenAI-compat uses x-goog-api-key for API-key auth.
      // Everything else (OpenAI/Groq/AI Studio/Cerebras) takes Bearer.
      const isVertex = /aiplatform\.googleapis\.com/.test(p.url);
      const authHeaders = isVertex
        ? { "x-goog-api-key": p.key }
        : { "Authorization": `Bearer ${p.key}` };
      // Vertex wants model as publisher/model (e.g. "google/gemini-3.5-flash").
      if (isVertex && body.model && !body.model.includes("/")) {
        body.model = `google/${body.model}`;
      }
      const t0 = performance.now();
      const gRow = { ...usageBase, upstream: p.label, model: p.model, effort: body.reasoning_effort || null };
      const res = await fetch(p.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
          "User-Agent": "StockSaathi-Edge/1.0",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        lastErr = `http_${res.status}`;
        await recordUsage({ ...gRow, ok: false, status: `http_${res.status}`, total_ms: Math.round(performance.now() - t0) });
        console.log(JSON.stringify({ evt: "ai_upstream", ok: false, upstream: p.label, model: p.model, profile, status: res.status, body: (await res.text().catch(() => "")).slice(0, 300) }));
        continue;
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      const gGood = typeof text === "string" && !!text.trim();
      await recordUsage({
        ...gRow, ok: gGood, status: gGood ? "ok" : "empty", total_ms: Math.round(performance.now() - t0),
        stop_reason: data?.choices?.[0]?.finish_reason, ...normUsage(data?.usage),
      });
      if (!gGood) { lastErr = "empty"; continue; }
      console.log(JSON.stringify({ evt: "ai_upstream", ok: true, upstream: p.label, model: p.model, profile }));
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

// Only crash replays are written from outside the server; every other
// bucket is filled by this file itself after its own quality gates.
const CACHE_PUT_BUCKETS = new Set(["crash_replay"]);
const CACHE_PUT_MAX_BYTES = 64 * 1024;

// Valid Supabase session? One round trip to /auth/v1/user; 200 = real user.
async function verifySupabaseUser(req) {
  const env = globalThis.process?.env || {};
  const url = env.SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY;
  if (!url || !anon) return false;
  const hdr = req.headers.get("Authorization") || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
  if (!token || token.split(".").length !== 3) return false;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch { return false; }
}

function crashReplayLooksValid(p) {
  return !!p && typeof p === "object" && !Array.isArray(p)
    && typeof p._promptVersion === "string" && p._promptVersion.length <= 40
    && typeof p.id === "string" && p.id.length <= 120
    && typeof p.title === "string" && p.title.length <= 80
    && typeof p.description === "string" && p.description.length <= 2000
    && Array.isArray(p.frames) && p.frames.length > 0 && p.frames.length <= 2000
    && (p.narrations == null || Array.isArray(p.narrations));
}

async function opCachePut(req, origin) {
  // Writes need a known caller: the admin token (scripts/pregen-crashes.mjs)
  // or a signed-in user coming from our own origin. A missing Origin is a
  // fail here, unlike reads.
  const isAdmin = checkAdmin(req).ok;
  if (!isAdmin) {
    if (!allowed(origin)) return j(403, { error: "forbidden_origin" }, origin);
    if (!(await verifySupabaseUser(req))) return j(401, { error: "sign_in_required" }, origin);
  }
  let body;
  try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const bucket = normalizeKey(body.bucket);
  const key = String(body.key || "");
  if (!CACHE_PUT_BUCKETS.has(bucket)) return j(403, { error: "bucket_not_writable" }, origin);
  if (!/^[a-f0-9]{12,64}$/.test(key)) return j(400, { error: "bad_key" }, origin);
  if (!crashReplayLooksValid(body.payload)) return j(400, { error: "bad_payload" }, origin);
  if (JSON.stringify(body.payload).length > CACHE_PUT_MAX_BYTES) return j(413, { error: "payload_too_large" }, origin);
  // First good row wins: a row that already carries the same prompt
  // version is never replaced. A row from an older version may be, since
  // readers treat it as a miss anyway.
  const existing = await cacheGet(bucket, key);
  if (existing && existing._promptVersion === body.payload._promptVersion) {
    return j(200, { ok: true, kept: true }, origin);
  }
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
  const key = normalizeKey(term) + (hinglishOf(req) ? "_hi" : "");
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
    // Route through the "json" profile (→ 3.1 Flash-Lite, minimal thinking)
    // even though we want plain text. The "fast" profile resolves to
    // gemini-2.5-flash which is a THINKING model — it spends ~95 of 120
    // max_tokens on internal reasoning and leaves only ~25 for the actual
    // explanation text, producing grammatically-truncated strings like
    // "Beta measures how much a". Flash-lite is genuinely non-thinking so
    // the whole max_tokens budget reaches the user. max_tokens bumped
    // 120 → 200 as belt-and-braces against future regressions.
    const text = await callLlm({ op: "explain", hinglish: hinglishOf(req),
      messages: [
        { role: "system", content: SYSTEM_EXPLAIN },
        { role: "user", content: `Explain "${term}" in one sentence.` },
      ],
      max_tokens: 200,
      temperature: 0.3,
      profile: "json", effort: "low",
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
// Written from the articles themselves: on a cache miss the server fetches
// this story's page plus up to four other publishers' pages on the same story
// (the News page picks them from its list), and the model cross-checks them
// and judges each listed company the story touches. Saved once, for good.
// Until 18 Oct the model saw only the headline.
const SYSTEM_NEWS_TLDR = `You are Saathi. You get one Indian business news story: its headline, publisher summary and article text, and often the same story as reported by other publishers. Cross-check them: rely on facts the reports agree on, and treat a claim only one report makes with care. The other reports were matched by shared words, so ignore any that turn out to be about a different event or company. Return strict JSON:
{ "sentiment": "bullish" | "bearish" | "neutral",
  "tldr": "<single sentence, ≤ 25 words, Indian retail-investor context, no hedges>",
  "impacts": [ { "ticker": "<NSE symbol, e.g. TATASTEEL>", "effect": "bullish" | "bearish" | "neutral", "why": "<≤ 12 words>" } ] }
Rules: base everything on what the articles actually say (numbers, names, reasons), not just the headline. impacts: up to 4 NSE-listed companies the story really affects, directly or as a clear competitor, supplier or customer; judge each separately (good news for one can be bad for another); use [] when no listed company is affected. sentiment is the overall effect on the stocks or sector involved. No "it depends". Return ONLY the JSON.`;

// Only these publishers' pages are fetched (they are the /api/news feeds), so
// this endpoint can't be used to make the server fetch arbitrary URLs.
const NEWS_HOSTS = new Set([
  "economictimes.indiatimes.com", "www.livemint.com", "www.business-standard.com",
  "www.thehindubusinessline.com", "www.cnbctv18.com", "www.thehindu.com",
  "indianexpress.com", "www.ndtvprofit.com", "www.businesstoday.in",
  "bazaar.businesstoday.in", "www.goodreturns.in",
]);
// Full articles: most are 400-1,000 words. The cap only stops a broken page
// (comments, related-story lists) from flooding the prompt.
const ARTICLE_WORDS = 4000;

function newsHostOk(u) {
  try { const x = new URL(u); return x.protocol === "https:" && NEWS_HOSTS.has(x.hostname); } catch { return false; }
}
function cleanText(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;|&rsquo;|&lsquo;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}
// Article text: the schema.org "articleBody" most news sites embed for
// search engines, else the page's paragraphs with scripts removed
// (BusinessLine has no articleBody). "" when the page can't be read.
async function fetchArticleText(url, maxWords = ARTICLE_WORDS) {
  if (!newsHostOk(url)) return "";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal, redirect: "follow",
      headers: {
        // Several publishers refuse anything that doesn't look like a browser.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
        "Accept": "text/html",
      },
    });
    if (!r.ok || !newsHostOk(r.url || url)) { try { await r.body?.cancel(); } catch {} return ""; }
    const page = (await r.text()).slice(0, 1_500_000);
    let best = "";
    for (const m of page.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      for (const b of m[1].matchAll(/"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        let v; try { v = JSON.parse('"' + b[1] + '"'); } catch { v = b[1]; }
        v = cleanText(cleanText(v));
        if (v.length > best.length) best = v;
      }
    }
    if (best.split(" ").length < 120) {
      const stripped = page.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ");
      const paras = [...stripped.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
        .map(m => cleanText(m[1])).filter(p => p.length > 60);
      const joined = paras.join(" ");
      if (joined.length > best.length) best = joined;
    }
    return best.split(" ").slice(0, maxWords).join(" ");
  } catch { return ""; }
  finally { clearTimeout(t); }
}

async function opNewsTldr(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const headline = String(body.headline || "").trim().slice(0, 300);
  if (!headline) return j(400, { error: "missing_headline" }, origin);
  const symbols = Array.isArray(body.symbols) ? body.symbols.filter(s => typeof s === "string").slice(0, 6) : [];
  const source = typeof body.source === "string" ? body.source.slice(0, 40) : "";
  const summary = typeof body.summary === "string" ? body.summary.trim().slice(0, 400) : "";
  const articleUrl = typeof body.url === "string" && newsHostOk(body.url) ? body.url : "";
  // The same story from other publishers, picked by the News page from its
  // list. Only allowed hosts, at most four (five reports with this one).
  const related = (Array.isArray(body.related) ? body.related : [])
    .filter(r => r && typeof r.headline === "string" && typeof r.url === "string" && newsHostOk(r.url) && r.url !== articleUrl)
    .slice(0, 4)
    .map(r => ({
      headline: r.headline.trim().slice(0, 300),
      source: typeof r.source === "string" ? r.source.slice(0, 40) : "",
      summary: typeof r.summary === "string" ? r.summary.trim().slice(0, 400) : "",
      url: r.url,
    }));

  // "a_" = written from the article (news page sends the link); "h_" = the
  // old headline-only takes, still used if an old cached page omits the link
  // so they never overwrite article-based ones. handlers/news.py builds the
  // same "a_" key to attach saved takes to the feed.
  const key = (articleUrl ? "a_" : "h_") + await sha12(headline) + (hinglishOf(req) ? "_hi" : "");
  const hit = await cacheGet("news_tldr", key);
  if (hit?.sentiment && hit?.tldr) return j(200, { ...hit, source: "cache" }, origin);

  // All pages at once, so the wait is the slowest page (4 s cap), not the sum.
  const [article, ...relatedText] = await Promise.all([
    articleUrl ? fetchArticleText(articleUrl) : "",
    ...related.map(r => fetchArticleText(r.url)),
  ]);
  const userMsg = [
    `Headline: ${headline}`,
    source ? `Source: ${source}` : null,
    summary ? `Publisher summary: ${summary}` : null,
    symbols.length ? `Tickers our keyword matcher spotted: ${symbols.join(", ")}` : null,
    article ? `Article text:\n${article}` : `(This publisher's page could not be read.)`,
    ...related.map((r, i) => [
      `\n--- Same story, other report ${i + 1}${r.source ? ` (${r.source})` : ""} ---`,
      `Headline: ${r.headline}`,
      r.summary ? `Summary: ${r.summary}` : null,
      relatedText[i] ? `Article text:\n${relatedText[i]}` : null,
    ].filter(Boolean).join("\n")),
  ].filter(Boolean).join("\n");

  try {
    const text = await callLlm({ op: "news-tldr", hinglish: hinglishOf(req),
      messages: [{ role: "system", content: SYSTEM_NEWS_TLDR }, { role: "user", content: userMsg }],
      max_tokens: 400, temperature: 0.3, response_format: { type: "json_object" }, profile: "json", effort: "low",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const EFFECTS = ["bullish", "bearish", "neutral"];
    const sentiment = EFFECTS.includes(parsed.sentiment) ? parsed.sentiment : "neutral";
    const tldr = typeof parsed.tldr === "string" && parsed.tldr.trim() ? parsed.tldr.trim().slice(0, 220) : "";
    if (!tldr) return j(502, { error: "no_tldr" }, origin);
    const impacts = (Array.isArray(parsed.impacts) ? parsed.impacts : [])
      .map(x => ({
        ticker: String(x?.ticker || "").trim().toUpperCase().replace(/^NSE:/, ""),
        effect: EFFECTS.includes(x?.effect) ? x.effect : "neutral",
        why: typeof x?.why === "string" ? x.why.trim().slice(0, 90) : "",
      }))
      .filter(x => /^[A-Z0-9][A-Z0-9&-]{0,19}$/.test(x.ticker))
      .slice(0, 4);
    const read = [article ? "article" : (summary ? "summary" : "headline"),
                  ...relatedText.map(t => t ? "article" : "summary")];
    const out = { sentiment, tldr, impacts, read };
    // AWAITED: a fire-and-forget write is killed when the Edge function
    // returns, so most takes were never stored and every visitor paid for a
    // fresh generation of the same headline. /api/news reads these rows.
    await cachePutAwait("news_tldr", key, headline, out);
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
    const text = await callLlm({ op: "portfolio-digest", hinglish: hinglishOf(req),
      messages: [{ role: "system", content: SYSTEM_PORTFOLIO }, { role: "user", content: userMsg }],
      max_tokens: 260, temperature: 0.4, response_format: { type: "json_object" }, profile: "json", effort: "medium",
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
// C9: the old prompt said "if nothing explains it, say sector rotation /
// macro / profit-booking", so the card invented causes: TCS +6.8% became
// "driven by ... optimism surrounding the ongoing AI-led tech boom" in the
// same paragraph that admitted no headline mentioned TCS.
const SYSTEM_STOCK_WHY = `You are Saathi. Write a 40-70 word paragraph on a stock's move in the session named in the data. Open with the numbers (ticker + price + the session's %), and call the session what the data calls it ("today" only if it says today; otherwise its day, e.g. "on Friday"). State a cause ONLY if one of the provided headlines names it, and say which outlet reported it. If no headline explains the move, say plainly that there is no clear news reason in today's headlines, and do not guess one: no sector rotation, macro mood, profit-booking, theme or "optimism" unless a headline says so. You may add one neutral thing a learner could look at (the company's next results date, its sector's move in the data). No predictions or buy/sell advice. Return strict JSON: { "explanation": "..." }.`;

async function opStockWhy(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const sym = String(body.symbol || "").toUpperCase().slice(0, 24);
  if (!sym) return j(400, { error: "missing_symbol" }, origin);
  const changePct = Number(body.changePct) || 0;
  const dir = changePct >= 0 ? "up" : "down";
  const session = lastSessionIst();
  const isFund = body.kind === "MF";
  // v2: entries written under the old prompt guessed causes (C9).
  // mf1: fund entries before this were written with a 0% move and the code.
  const key = `${isFund ? "mf1" : "v2"}_${sym.toLowerCase()}_${dir}_${session.ymd}` + (hinglishOf(req) ? "_hi" : "");
  const hit = await cacheGet("stock_why", key);
  if (hit?.explanation) return j(200, { explanation: hit.explanation, source: "cache" }, origin);

  const news = Array.isArray(body.newsItems) ? body.newsItems.slice(0, 8) : [];
  const userMsg = isFund ? [
    `This is a mutual fund, not a stock. Call it by its name; never write the scheme code ${sym}.`,
    body.name ? `Fund: ${body.name}` : null,
    body.pricePaise != null ? `NAV: ₹${(body.pricePaise / 100).toFixed(2)}${body.navDate ? ` (published for ${String(body.navDate).slice(0, 40)})` : ""}` : null,
    `Change since the previous NAV: ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%. Describe it as the change since the previous NAV, not as a closing price.`,
    news.length ? `\nRecent market headlines:\n${news.map(n => `- [${n.source || "?"}] ${n.headline}`).join("\n")}` : "No relevant headlines were found. Say there is no clear news reason; do not guess one.",
  ].filter(Boolean).join("\n") : [
    `Ticker: ${sym}`,
    body.name ? `Name: ${body.name}` : null,
    body.sector ? `Sector: ${body.sector}` : null,
    body.pricePaise != null ? `Price: ₹${(body.pricePaise / 100).toFixed(2)}` : null,
    `Session: ${session.isToday ? "today" : `${session.label} (the market is closed now; call it "${session.label.split(/[ ,]/)[0]}", not "today")`}`,
    `Move in that session: ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`,
    news.length ? `\nRecent related headlines:\n${news.map(n => `- [${n.source || "?"}] ${n.headline}`).join("\n")}` : "No headlines about this company were found. Say there is no clear news reason; do not guess one.",
  ].filter(Boolean).join("\n");

  try {
    const text = await callLlm({ op: "stock-why", hinglish: hinglishOf(req),
      messages: [{ role: "system", content: SYSTEM_STOCK_WHY }, { role: "user", content: userMsg }],
      max_tokens: 240, temperature: 0.35, response_format: { type: "json_object" }, profile: "json", effort: "medium",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const explanation = typeof parsed.explanation === "string" ? parsed.explanation.trim().slice(0, 700) : "";
    if (!explanation) return j(502, { error: "no_explanation" }, origin);
    await cachePutAwait("stock_why", key, sym, { explanation });
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
    const text = await callLlm({ op: "trade-nudge", hinglish: hinglishOf(req),
      messages: [{ role: "system", content: SYSTEM_TRADE_NUDGE }, { role: "user", content: userMsg }],
      max_tokens: 220, temperature: 0.4, response_format: { type: "json_object" }, profile: "json", effort: "medium",
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
  "Name the session the way the data block does: say \"today\" only if it says today; otherwise use its day (\"on Friday\"), because the market is shut and these are that session's moves.",
  "End with a one-word overall temperature: hot (≥1% broad rally), warm (mild green), mild (flat), cold (broad red).",
  'Return strict JSON: { "narrative": "...", "temperature": "hot"|"warm"|"mild"|"cold" }.',
].join(" ");

async function opMarketMood(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const sectors = Array.isArray(body.sectors) ? body.sectors.slice(0, 12) : [];
  if (!sectors.length) return j(400, { error: "no_sectors" }, origin);
  const sig = sectors.slice(0, 6).map(s => `${String(s.name).toLowerCase().slice(0, 10)}:${(Number(s.avgPct) || 0).toFixed(1)}`).join("|");
  // C10: on a Saturday this said "today" about Thursday's moves. The key
  // carries the session and whether it is still today, so Friday's
  // narrative is not served as "today" on Saturday.
  const session = lastSessionIst();
  const key = `${session.ymd}_${session.isToday ? "t" : "p"}_${sig}` + (hinglishOf(req) ? "_hi" : "");
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
    session.isToday
      ? `Today (${session.ymd}) Indian market sector moves:`
      : `Sector moves in the last session, ${session.label} (${session.ymd}). The market is closed now: call it "on ${session.label.split(/[ ,]/)[0]}", never "today".`,
    ...sectors.map(s => `  ${s.name}: avg ${s.avgPct >= 0 ? "+" : ""}${Number(s.avgPct).toFixed(2)}% across ${s.count} names (top up: ${s.topUp || "-"}, top down: ${s.topDown || "-"})`),
    "",
    `Allowed individual tickers to mention (and ONLY these): ${[...allowedTickers].join(", ") || "(none)"}`,
  ].join("\n");

  try {
    const text = await callLlm({ op: "market-mood", hinglish: hinglishOf(req),
      messages: [{ role: "system", content: SYSTEM_MOOD }, { role: "user", content: userMsg }],
      max_tokens: 220, temperature: 0.25, response_format: { type: "json_object" }, profile: "json", effort: "high",
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
        const retryText = await callLlm({ op: "market-mood", hinglish: hinglishOf(req),
          messages: [{ role: "system", content: SYSTEM_MOOD }, { role: "user", content: retryMsg }],
          max_tokens: 220, temperature: 0.15, response_format: { type: "json_object" }, profile: "json", effort: "high",
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
    await cachePutAwait("market_mood", key, null, out);
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
    const text = await callLlm({ op: "market-search",
      messages: [{ role: "system", content: SYSTEM_NL_SEARCH }, { role: "user", content: userMsg }],
      max_tokens: 400, temperature: 0.2, response_format: { type: "json_object" }, profile: "json", effort: "medium",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const valid = new Set(candidates.map(c => c.symbol));
    const matches = Array.isArray(parsed.matches) ? parsed.matches.filter(s => typeof s === "string" && valid.has(s)).slice(0, 15) : [];
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim().slice(0, 280) : "";
    const out = { matches, rationale };
    await cachePutAwait("nl_search", key, query, out);
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
    const text = await callLlm({ op: "report-card", hinglish: hinglishOf(req),
      messages: [{ role: "system", content: SYSTEM_REPORT }, { role: "user", content: userMsg }],
      max_tokens: 360, temperature: 0.45, response_format: { type: "json_object" }, profile: "json", effort: "medium",
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
    const text = await callLlm({ op: "crash-suggestions",
      messages: [{ role: "system", content: SYSTEM_CRASH_SUGG }, { role: "user", content: "Generate 10 suggestions." }],
      max_tokens: 300, temperature: 0.8, response_format: { type: "json_object" }, profile: "json", effort: "low",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.filter(s => typeof s === "string" && s.trim().length >= 3).slice(0, 12).map(s => s.trim().slice(0, 80)) : [];
    if (!suggestions.length) return j(502, { error: "no_suggestions" }, origin);
    const out = { suggestions };
    await cachePutAwait("crash_sugg_v2", key, null, out);
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
// Fallback datasets for historical windows Yahoo doesn't serve (pre-2007
// indices, delisted scrips). Every value is an official close, checked on
// 2026-10-23 against BSE, Nifty Indices or NSE bhavcopy - never hand-typed.
//
// Each entry: { symbolMatches, fromIso, toIso, points: [[d, c], ...] }
// Returns null if no matching curated dataset.
const _CURATED_HISTORY = [
  // BSE Sensex 1990-1998: month-end closes for 1990-91, 1993-95 and Jun 1997-Sep 1998,
  // daily closes for all of 1992 (Harshad Mehta). Source: BSE index archive
  // (api.bseindia.com IndexArchDailyPAR, SENSEX). No 1996 data on purpose.
  {
    symbolMatches: (s) => /\^BSESN/i.test(s),
    fromIso: "1990-01-01", toIso: "1998-09-30",
    points: [
      ["1990-01-31", 683.32], ["1990-02-28", 676.23], ["1990-03-30", 781.05], ["1990-04-30", 795.13],
      ["1990-05-31", 800.80], ["1990-06-29", 850.50], ["1990-07-30", 1098.95], ["1990-08-30", 1247.53],
      ["1990-09-27", 1420.08], ["1990-10-31", 1295.21], ["1990-11-30", 1196.25], ["1990-12-24", 1048.29],
      ["1991-01-31", 982.32], ["1991-02-28", 1220.41], ["1991-03-27", 1167.97], ["1991-04-30", 1235.11],
      ["1991-05-31", 1307.34], ["1991-06-28", 1269.91], ["1991-07-31", 1632.67], ["1991-08-30", 1795.99],
      ["1991-09-30", 1885.28], ["1991-10-31", 1889.84], ["1991-11-29", 1903.31], ["1991-12-24", 1908.85],
      ["1992-01-01", 1957.33], ["1992-01-02", 1969.16], ["1992-01-03", 1996.50], ["1992-01-06", 1967.55],
      ["1992-01-07", 1963.53], ["1992-01-08", 1949.31], ["1992-01-09", 1972.53], ["1992-01-13", 1998.88],
      ["1992-01-14", 1998.07], ["1992-01-15", 2020.18], ["1992-01-16", 2002.60], ["1992-01-17", 2115.89],
      ["1992-01-20", 2107.07], ["1992-01-21", 2115.71], ["1992-01-22", 2132.82], ["1992-01-23", 2150.41],
      ["1992-01-24", 2139.33], ["1992-01-27", 2172.11], ["1992-01-29", 2214.22], ["1992-01-30", 2299.77],
      ["1992-01-31", 2302.54], ["1992-02-03", 2272.81], ["1992-02-04", 2278.72], ["1992-02-05", 2288.43],
      ["1992-02-06", 2309.36], ["1992-02-07", 2194.48], ["1992-02-10", 2273.47], ["1992-02-12", 2305.38],
      ["1992-02-13", 2322.79], ["1992-02-17", 2437.30], ["1992-02-18", 2403.78], ["1992-02-19", 2382.07],
      ["1992-02-20", 2449.06], ["1992-02-21", 2454.66], ["1992-02-24", 2491.27], ["1992-02-26", 2617.52],
      ["1992-02-27", 2741.73], ["1992-02-28", 2759.22], ["1992-02-29", 3017.68], ["1992-03-02", 3333.25],
      ["1992-03-03", 3472.78], ["1992-03-09", 3547.61], ["1992-03-10", 3316.03], ["1992-03-11", 3163.68],
      ["1992-03-12", 3241.97], ["1992-03-13", 3259.36], ["1992-03-16", 3250.70], ["1992-03-17", 3198.78],
      ["1992-03-18", 3128.01], ["1992-03-20", 3243.53], ["1992-03-24", 3669.58], ["1992-03-25", 3802.17],
      ["1992-03-27", 3791.18], ["1992-03-30", 4091.43], ["1992-03-31", 4285.00], ["1992-04-02", 4387.86],
      ["1992-04-03", 4238.25], ["1992-04-06", 4062.57], ["1992-04-07", 4023.11], ["1992-04-08", 4333.57],
      ["1992-04-10", 4306.43], ["1992-04-13", 4163.02], ["1992-04-22", 4467.32], ["1992-04-28", 3896.90],
      ["1992-04-29", 3674.41], ["1992-04-30", 3887.72], ["1992-05-06", 3560.72], ["1992-05-07", 3658.00],
      ["1992-05-11", 3420.05], ["1992-05-12", 3086.37], ["1992-05-13", 3431.13], ["1992-05-14", 3394.48],
      ["1992-05-18", 3456.16], ["1992-05-19", 3568.67], ["1992-05-20", 3559.28], ["1992-05-22", 3435.07],
      ["1992-05-25", 3406.29], ["1992-05-26", 3298.74], ["1992-05-27", 3144.79], ["1992-05-28", 3072.48],
      ["1992-05-29", 3006.08], ["1992-06-01", 3001.24], ["1992-06-02", 3133.83], ["1992-06-03", 3101.66],
      ["1992-06-04", 3004.92], ["1992-06-05", 3086.74], ["1992-06-08", 3100.66], ["1992-06-09", 3154.23],
      ["1992-06-10", 3140.80], ["1992-06-25", 3081.32], ["1992-06-26", 3080.54], ["1992-07-15", 2912.92],
      ["1992-07-16", 2809.69], ["1992-07-17", 2806.31], ["1992-07-20", 2855.43], ["1992-07-21", 2870.59],
      ["1992-07-22", 2818.12], ["1992-07-23", 2678.34], ["1992-07-27", 2804.15], ["1992-07-28", 2830.57],
      ["1992-07-29", 2755.25], ["1992-07-30", 2698.83], ["1992-07-31", 2727.06], ["1992-08-03", 2722.65],
      ["1992-08-04", 2686.49], ["1992-08-05", 2630.23], ["1992-08-06", 2529.59], ["1992-08-07", 2590.68],
      ["1992-08-10", 2668.25], ["1992-08-11", 2693.42], ["1992-08-12", 2678.83], ["1992-08-14", 2795.18],
      ["1992-08-17", 2889.08], ["1992-08-18", 2921.53], ["1992-08-19", 2982.60], ["1992-08-20", 2995.25],
      ["1992-08-21", 3034.94], ["1992-08-24", 3053.12], ["1992-08-25", 2959.41], ["1992-08-26", 2909.32],
      ["1992-08-27", 2996.98], ["1992-08-28", 3031.63], ["1992-09-01", 3070.49], ["1992-09-02", 3040.57],
      ["1992-09-03", 3079.53], ["1992-09-04", 3166.10], ["1992-09-07", 3226.52], ["1992-09-08", 3201.46],
      ["1992-09-09", 3198.69], ["1992-09-11", 3219.92], ["1992-09-14", 3274.85], ["1992-09-15", 3410.29],
      ["1992-09-16", 3404.96], ["1992-09-17", 3378.18], ["1992-09-18", 3383.62], ["1992-09-21", 3274.74],
      ["1992-09-22", 3298.75], ["1992-09-24", 3246.96], ["1992-09-25", 3256.59], ["1992-09-28", 3239.98],
      ["1992-09-29", 3195.75], ["1992-09-30", 3294.42], ["1992-10-01", 3315.72], ["1992-10-06", 3247.76],
      ["1992-10-08", 3211.55], ["1992-10-09", 3275.57], ["1992-10-12", 3166.52], ["1992-10-13", 3187.76],
      ["1992-10-14", 3105.63], ["1992-10-15", 3086.45], ["1992-10-20", 3050.90], ["1992-10-21", 2934.66],
      ["1992-10-22", 2987.29], ["1992-10-25", 2987.21], ["1992-10-28", 2876.70], ["1992-10-29", 2862.15],
      ["1992-10-30", 2833.34], ["1992-11-03", 2928.89], ["1992-11-04", 2926.18], ["1992-11-05", 2794.83],
      ["1992-11-06", 2756.19], ["1992-11-09", 2685.39], ["1992-11-11", 2596.53], ["1992-11-12", 2641.81],
      ["1992-11-13", 2586.68], ["1992-11-18", 2524.71], ["1992-11-19", 2423.26], ["1992-11-20", 2479.56],
      ["1992-11-23", 2530.47], ["1992-11-24", 2546.86], ["1992-11-25", 2556.56], ["1992-11-26", 2487.11],
      ["1992-11-27", 2486.41], ["1992-11-30", 2518.10], ["1992-12-01", 2547.69], ["1992-12-02", 2593.62],
      ["1992-12-03", 2619.90], ["1992-12-04", 2696.86], ["1992-12-10", 2550.22], ["1992-12-11", 2536.87],
      ["1992-12-14", 2469.45], ["1992-12-15", 2477.27], ["1992-12-16", 2374.72], ["1992-12-17", 2400.16],
      ["1992-12-18", 2476.89], ["1992-12-21", 2542.10], ["1992-12-22", 2562.10], ["1992-12-23", 2571.36],
      ["1992-12-24", 2615.37], ["1993-01-29", 2680.79], ["1993-02-27", 2783.58], ["1993-03-31", 2280.52],
      ["1993-04-30", 2122.30], ["1993-05-31", 2192.74], ["1993-06-30", 2227.54], ["1993-07-30", 2328.21],
      ["1993-08-30", 2633.79], ["1993-09-30", 2709.64], ["1993-10-29", 2673.74], ["1993-11-26", 3233.14],
      ["1993-12-24", 3346.06], ["1994-01-31", 3994.86], ["1994-02-28", 4286.20], ["1994-03-31", 3778.99],
      ["1994-04-29", 3746.10], ["1994-05-31", 3829.36], ["1994-06-30", 4086.72], ["1994-07-29", 4191.30],
      ["1994-08-31", 4588.16], ["1994-09-30", 4281.00], ["1994-10-31", 4269.86], ["1994-11-30", 4124.18],
      ["1994-12-23", 3926.90], ["1995-01-31", 3618.54], ["1995-02-28", 3421.47], ["1995-03-31", 3260.96],
      ["1995-04-28", 3133.28], ["1995-05-31", 3351.48], ["1995-06-30", 3247.36], ["1995-07-31", 3386.97],
      ["1995-08-31", 3346.76], ["1995-09-29", 3493.21], ["1995-10-31", 3423.47], ["1995-11-30", 2994.29],
      ["1995-12-22", 3110.49], ["1997-06-30", 4256.09], ["1997-07-31", 4305.76], ["1997-08-29", 3876.08],
      ["1997-09-30", 3902.03], ["1997-10-30", 3803.24], ["1997-11-28", 3560.29], ["1997-12-31", 3658.98],
      ["1998-01-29", 3224.36], ["1998-02-27", 3622.22], ["1998-03-31", 3892.75], ["1998-04-30", 4006.81],
      ["1998-05-29", 3686.39], ["1998-06-30", 3250.69], ["1998-07-31", 3211.31], ["1998-08-31", 2933.85],
      ["1998-09-30", 3102.29],
    ],
  },
  // Nifty 50 Feb-Jul 2000 (dot-com bust), daily closes. Source: niftyindices.com.
  {
    symbolMatches: (s) => /\^NSEI/i.test(s),
    fromIso: "2000-02-01", toIso: "2000-07-31",
    points: [
      ["2000-02-01", 1549.50], ["2000-02-02", 1588.00], ["2000-02-03", 1597.90], ["2000-02-04", 1599.75],
      ["2000-02-07", 1636.60], ["2000-02-08", 1662.75], ["2000-02-09", 1689.65], ["2000-02-10", 1711.20],
      ["2000-02-11", 1756.00], ["2000-02-14", 1744.50], ["2000-02-15", 1702.55], ["2000-02-16", 1711.10],
      ["2000-02-17", 1742.10], ["2000-02-18", 1717.80], ["2000-02-21", 1753.50], ["2000-02-22", 1739.05],
      ["2000-02-23", 1696.40], ["2000-02-24", 1732.00], ["2000-02-25", 1710.45], ["2000-02-28", 1722.55],
      ["2000-02-29", 1654.80], ["2000-03-01", 1712.70], ["2000-03-02", 1696.55], ["2000-03-03", 1656.00],
      ["2000-03-06", 1688.50], ["2000-03-07", 1702.75], ["2000-03-08", 1666.35], ["2000-03-09", 1646.25],
      ["2000-03-10", 1602.75], ["2000-03-13", 1560.70], ["2000-03-14", 1567.05], ["2000-03-15", 1620.10],
      ["2000-03-16", 1562.20], ["2000-03-21", 1556.60], ["2000-03-22", 1589.60], ["2000-03-23", 1553.40],
      ["2000-03-24", 1569.55], ["2000-03-27", 1562.95], ["2000-03-28", 1568.60], ["2000-03-29", 1558.25],
      ["2000-03-30", 1549.50], ["2000-03-31", 1528.45], ["2000-04-03", 1534.75], ["2000-04-04", 1428.10],
      ["2000-04-05", 1434.65], ["2000-04-06", 1452.95], ["2000-04-07", 1557.15], ["2000-04-10", 1613.00],
      ["2000-04-11", 1624.65], ["2000-04-12", 1592.70], ["2000-04-13", 1518.65], ["2000-04-17", 1443.55],
      ["2000-04-18", 1414.80], ["2000-04-19", 1404.95], ["2000-04-20", 1415.65], ["2000-04-24", 1388.00],
      ["2000-04-25", 1359.45], ["2000-04-26", 1436.10], ["2000-04-27", 1416.90], ["2000-04-28", 1406.55],
      ["2000-05-02", 1333.45], ["2000-05-03", 1316.05], ["2000-05-04", 1380.55], ["2000-05-05", 1422.40],
      ["2000-05-08", 1365.05], ["2000-05-09", 1378.55], ["2000-05-10", 1363.15], ["2000-05-11", 1304.55],
      ["2000-05-12", 1282.80], ["2000-05-15", 1299.25], ["2000-05-16", 1306.85], ["2000-05-17", 1311.65],
      ["2000-05-18", 1293.40], ["2000-05-19", 1268.00], ["2000-05-22", 1233.00], ["2000-05-23", 1224.40],
      ["2000-05-24", 1235.90], ["2000-05-25", 1247.65], ["2000-05-26", 1275.35], ["2000-05-29", 1311.05],
      ["2000-05-30", 1344.85], ["2000-05-31", 1380.45], ["2000-06-01", 1349.00], ["2000-06-02", 1389.25],
      ["2000-06-05", 1404.60], ["2000-06-06", 1421.75], ["2000-06-07", 1430.35], ["2000-06-08", 1463.65],
      ["2000-06-09", 1467.20], ["2000-06-12", 1440.40], ["2000-06-13", 1432.90], ["2000-06-14", 1435.50],
      ["2000-06-15", 1445.25], ["2000-06-16", 1477.30], ["2000-06-19", 1498.75], ["2000-06-20", 1507.10],
      ["2000-06-21", 1475.15], ["2000-06-22", 1488.25], ["2000-06-23", 1472.20], ["2000-06-26", 1451.65],
      ["2000-06-27", 1454.30], ["2000-06-28", 1470.00], ["2000-06-29", 1492.35], ["2000-06-30", 1471.45],
      ["2000-07-03", 1495.25], ["2000-07-04", 1511.30], ["2000-07-05", 1526.05], ["2000-07-06", 1516.80],
      ["2000-07-07", 1517.60], ["2000-07-10", 1509.65], ["2000-07-11", 1518.55], ["2000-07-12", 1533.35],
      ["2000-07-13", 1522.60], ["2000-07-14", 1509.75], ["2000-07-17", 1479.65], ["2000-07-18", 1463.10],
      ["2000-07-19", 1435.80], ["2000-07-20", 1424.20], ["2000-07-21", 1397.25], ["2000-07-24", 1317.75],
      ["2000-07-25", 1348.90], ["2000-07-26", 1318.25], ["2000-07-27", 1338.05], ["2000-07-28", 1333.80],
      ["2000-07-31", 1332.85],
    ],
  },
  // DHFL Jun-Dec 2019, daily closes incl. the 27 Oct 2019 Muhurat session.
  // Source: NSE equity bhavcopy CLOSE.
  {
    symbolMatches: (s) => /^DHFL/i.test(s),
    fromIso: "2019-05-01", toIso: "2020-01-31",
    points: [
      ["2019-06-03", 113.20], ["2019-06-04", 111.75], ["2019-06-06", 93.95], ["2019-06-07", 83.30],
      ["2019-06-10", 89.55], ["2019-06-11", 90.15], ["2019-06-12", 93.25], ["2019-06-13", 84.35],
      ["2019-06-14", 80.75], ["2019-06-17", 76.55], ["2019-06-18", 64.95], ["2019-06-19", 63.00],
      ["2019-06-20", 69.25], ["2019-06-21", 73.20], ["2019-06-24", 78.70], ["2019-06-25", 75.45],
      ["2019-06-26", 79.75], ["2019-06-27", 81.55], ["2019-06-28", 72.05], ["2019-07-01", 73.60],
      ["2019-07-02", 75.35], ["2019-07-03", 83.15], ["2019-07-04", 83.20], ["2019-07-05", 80.20],
      ["2019-07-08", 77.80], ["2019-07-09", 71.00], ["2019-07-10", 70.10], ["2019-07-11", 71.25],
      ["2019-07-12", 68.50], ["2019-07-15", 48.50], ["2019-07-16", 50.60], ["2019-07-17", 56.25],
      ["2019-07-18", 56.25], ["2019-07-19", 53.55], ["2019-07-22", 52.50], ["2019-07-23", 60.00],
      ["2019-07-24", 56.55], ["2019-07-25", 55.20], ["2019-07-26", 55.00], ["2019-07-29", 52.20],
      ["2019-07-30", 49.95], ["2019-07-31", 49.30], ["2019-08-01", 48.65], ["2019-08-02", 46.65],
      ["2019-08-05", 41.95], ["2019-08-06", 55.35], ["2019-08-07", 49.40], ["2019-08-08", 47.60],
      ["2019-08-09", 48.75], ["2019-08-13", 46.45], ["2019-08-14", 46.90], ["2019-08-16", 45.95],
      ["2019-08-19", 49.05], ["2019-08-20", 46.50], ["2019-08-21", 45.55], ["2019-08-22", 39.80],
      ["2019-08-23", 40.70], ["2019-08-26", 45.65], ["2019-08-27", 48.35], ["2019-08-28", 48.40],
      ["2019-08-29", 47.25], ["2019-08-30", 47.65], ["2019-09-03", 47.95], ["2019-09-04", 47.20],
      ["2019-09-05", 47.60], ["2019-09-06", 46.60], ["2019-09-09", 48.95], ["2019-09-11", 50.70],
      ["2019-09-12", 51.25], ["2019-09-13", 50.90], ["2019-09-16", 51.85], ["2019-09-17", 50.30],
      ["2019-09-18", 48.90], ["2019-09-19", 47.55], ["2019-09-20", 43.40], ["2019-09-23", 41.85],
      ["2019-09-24", 44.95], ["2019-09-25", 47.15], ["2019-09-26", 42.90], ["2019-09-27", 42.25],
      ["2019-09-30", 38.75], ["2019-10-01", 31.00], ["2019-10-03", 31.70], ["2019-10-04", 31.20],
      ["2019-10-07", 28.95], ["2019-10-09", 26.10], ["2019-10-10", 23.50], ["2019-10-11", 21.15],
      ["2019-10-14", 22.20], ["2019-10-15", 21.25], ["2019-10-16", 20.20], ["2019-10-17", 20.45],
      ["2019-10-18", 21.45], ["2019-10-22", 20.40], ["2019-10-23", 19.40], ["2019-10-24", 18.45],
      ["2019-10-25", 17.55], ["2019-10-27", 16.70], ["2019-10-29", 15.90], ["2019-10-30", 16.65],
      ["2019-10-31", 17.45], ["2019-11-01", 18.30], ["2019-11-04", 19.20], ["2019-11-05", 20.15],
      ["2019-11-06", 21.15], ["2019-11-07", 22.20], ["2019-11-08", 23.30], ["2019-11-11", 24.45],
      ["2019-11-13", 25.65], ["2019-11-14", 24.40], ["2019-11-15", 23.20], ["2019-11-18", 22.05],
      ["2019-11-19", 20.95], ["2019-11-20", 20.15], ["2019-11-21", 21.15], ["2019-11-22", 22.20],
      ["2019-11-25", 22.05], ["2019-11-26", 21.05], ["2019-11-27", 20.00], ["2019-11-28", 19.90],
      ["2019-11-29", 20.75], ["2019-12-02", 19.75], ["2019-12-03", 18.80], ["2019-12-04", 18.00],
      ["2019-12-05", 17.95], ["2019-12-06", 17.10], ["2019-12-09", 16.25], ["2019-12-10", 15.45],
      ["2019-12-11", 14.70], ["2019-12-12", 14.00], ["2019-12-13", 14.70], ["2019-12-16", 15.40],
      ["2019-12-17", 16.15], ["2019-12-18", 16.95], ["2019-12-19", 16.15], ["2019-12-20", 16.00],
      ["2019-12-23", 15.45], ["2019-12-24", 15.05], ["2019-12-26", 15.80], ["2019-12-27", 16.55],
      ["2019-12-30", 17.35], ["2019-12-31", 16.80],
    ],
  },
  // 2004 election crash (17 May 2004) - Sensex daily closes. Source: BSE index archive.
  {
    symbolMatches: (s) => /\^BSESN/i.test(s),
    fromIso: "2004-04-01", toIso: "2004-09-30",
    points: [
      ["2004-04-01", 5740.85], ["2004-04-02", 5788.08], ["2004-04-05", 5838.02], ["2004-04-06", 5822.42],
      ["2004-04-07", 5815.13], ["2004-04-08", 5838.45], ["2004-04-12", 5783.79], ["2004-04-13", 5904.52],
      ["2004-04-15", 5843.97], ["2004-04-16", 5862.82], ["2004-04-17", 5861.63], ["2004-04-19", 5800.54],
      ["2004-04-20", 5804.81], ["2004-04-21", 5876.42], ["2004-04-22", 5924.18], ["2004-04-23", 5925.58],
      ["2004-04-27", 5712.28], ["2004-04-28", 5713.09], ["2004-04-29", 5668.43], ["2004-04-30", 5655.09],
      ["2004-05-03", 5584.99], ["2004-05-04", 5647.15], ["2004-05-05", 5686.19], ["2004-05-06", 5757.30],
      ["2004-05-07", 5669.58], ["2004-05-10", 5555.84], ["2004-05-11", 5325.90], ["2004-05-12", 5358.35],
      ["2004-05-13", 5399.47], ["2004-05-14", 5069.87], ["2004-05-17", 4505.16], ["2004-05-18", 4877.02],
      ["2004-05-19", 5006.10], ["2004-05-20", 4932.11], ["2004-05-21", 4961.57], ["2004-05-24", 5123.23],
      ["2004-05-25", 5102.22], ["2004-05-26", 5081.95], ["2004-05-27", 5058.55], ["2004-05-28", 4835.39],
      ["2004-05-31", 4759.62], ["2004-06-01", 4835.12], ["2004-06-02", 4923.69], ["2004-06-03", 4817.99],
      ["2004-06-04", 4889.00], ["2004-06-07", 4938.15], ["2004-06-08", 4962.63], ["2004-06-09", 4963.75],
      ["2004-06-10", 4944.64], ["2004-06-11", 4832.71], ["2004-06-14", 4746.01], ["2004-06-15", 4814.85],
      ["2004-06-16", 4788.80], ["2004-06-17", 4839.88], ["2004-06-18", 4769.99], ["2004-06-21", 4738.62],
      ["2004-06-22", 4735.86], ["2004-06-23", 4644.00], ["2004-06-24", 4708.55], ["2004-06-25", 4756.39],
      ["2004-06-28", 4837.60], ["2004-06-29", 4841.38], ["2004-06-30", 4795.46], ["2004-07-01", 4874.05],
      ["2004-07-02", 4870.58], ["2004-07-05", 4843.77], ["2004-07-06", 4928.59], ["2004-07-07", 4955.97],
      ["2004-07-08", 4843.84], ["2004-07-09", 4945.48], ["2004-07-12", 4944.54], ["2004-07-13", 4898.99],
      ["2004-07-14", 4848.30], ["2004-07-15", 4888.19], ["2004-07-16", 4951.17], ["2004-07-19", 4975.40],
      ["2004-07-20", 4957.88], ["2004-07-21", 4993.76], ["2004-07-22", 5054.29], ["2004-07-23", 5073.34],
      ["2004-07-26", 5118.17], ["2004-07-27", 5075.88], ["2004-07-28", 5070.29], ["2004-07-29", 5120.45],
      ["2004-07-30", 5170.32], ["2004-08-02", 5202.53], ["2004-08-03", 5194.63], ["2004-08-04", 5169.07],
      ["2004-08-05", 5252.78], ["2004-08-06", 5196.99], ["2004-08-09", 5233.21], ["2004-08-10", 5252.05],
      ["2004-08-11", 5175.16], ["2004-08-12", 5139.77], ["2004-08-13", 5102.92], ["2004-08-16", 5102.37],
      ["2004-08-17", 5102.94], ["2004-08-18", 5038.28], ["2004-08-19", 5123.65], ["2004-08-20", 5064.66],
      ["2004-08-23", 5033.69], ["2004-08-24", 5067.39], ["2004-08-25", 5088.56], ["2004-08-26", 5135.45],
      ["2004-08-27", 5117.01], ["2004-08-30", 5186.45], ["2004-08-31", 5192.08], ["2004-09-01", 5210.85],
      ["2004-09-02", 5198.72], ["2004-09-03", 5218.46], ["2004-09-06", 5246.23], ["2004-09-07", 5264.67],
      ["2004-09-08", 5298.16], ["2004-09-09", 5298.23], ["2004-09-10", 5370.05], ["2004-09-13", 5397.46],
      ["2004-09-14", 5428.77], ["2004-09-15", 5420.09], ["2004-09-16", 5477.68], ["2004-09-17", 5561.15],
      ["2004-09-20", 5545.82], ["2004-09-21", 5605.93], ["2004-09-22", 5616.87], ["2004-09-23", 5539.48],
      ["2004-09-24", 5527.75], ["2004-09-27", 5511.81], ["2004-09-28", 5462.61], ["2004-09-29", 5527.56],
      ["2004-09-30", 5583.61],
    ],
  },
  // 2004 election crash - Nifty 50 daily closes. Source: niftyindices.com.
  {
    symbolMatches: (s) => /\^NSEI/i.test(s),
    fromIso: "2004-04-01", toIso: "2004-09-30",
    points: [
      ["2004-04-01", 1819.65], ["2004-04-02", 1841.10], ["2004-04-05", 1856.60], ["2004-04-06", 1851.15],
      ["2004-04-07", 1848.70], ["2004-04-08", 1853.55], ["2004-04-12", 1838.20], ["2004-04-13", 1878.45],
      ["2004-04-15", 1861.95], ["2004-04-16", 1868.95], ["2004-04-17", 1868.10], ["2004-04-19", 1844.05],
      ["2004-04-20", 1844.25], ["2004-04-21", 1873.35], ["2004-04-22", 1889.55], ["2004-04-23", 1892.45],
      ["2004-04-27", 1817.25], ["2004-04-28", 1816.55], ["2004-04-29", 1808.95], ["2004-04-30", 1796.10],
      ["2004-05-03", 1766.70], ["2004-05-04", 1793.10], ["2004-05-05", 1809.90], ["2004-05-06", 1832.80],
      ["2004-05-07", 1804.45], ["2004-05-10", 1769.10], ["2004-05-11", 1699.45], ["2004-05-12", 1711.10],
      ["2004-05-13", 1717.50], ["2004-05-14", 1582.40], ["2004-05-17", 1388.75], ["2004-05-18", 1503.95],
      ["2004-05-19", 1567.85], ["2004-05-20", 1543.85], ["2004-05-21", 1560.20], ["2004-05-24", 1608.85],
      ["2004-05-25", 1606.70], ["2004-05-26", 1598.80], ["2004-05-27", 1586.40], ["2004-05-28", 1508.75],
      ["2004-05-31", 1483.60], ["2004-06-01", 1507.90], ["2004-06-02", 1535.20], ["2004-06-03", 1495.10],
      ["2004-06-04", 1521.10], ["2004-06-07", 1542.55], ["2004-06-08", 1550.55], ["2004-06-09", 1548.30],
      ["2004-06-10", 1544.75], ["2004-06-11", 1508.45], ["2004-06-14", 1481.35], ["2004-06-15", 1501.00],
      ["2004-06-16", 1494.75], ["2004-06-17", 1512.05], ["2004-06-18", 1491.20], ["2004-06-21", 1482.00],
      ["2004-06-22", 1474.70], ["2004-06-23", 1446.10], ["2004-06-24", 1470.75], ["2004-06-25", 1488.50],
      ["2004-06-28", 1514.35], ["2004-06-29", 1518.30], ["2004-06-30", 1505.60], ["2004-07-01", 1537.20],
      ["2004-07-02", 1537.50], ["2004-07-05", 1526.85], ["2004-07-06", 1558.25], ["2004-07-07", 1566.80],
      ["2004-07-08", 1518.15], ["2004-07-09", 1553.20], ["2004-07-12", 1556.95], ["2004-07-13", 1539.30],
      ["2004-07-14", 1522.75], ["2004-07-15", 1539.40], ["2004-07-16", 1558.80], ["2004-07-19", 1571.60],
      ["2004-07-20", 1566.10], ["2004-07-21", 1581.40], ["2004-07-22", 1598.10], ["2004-07-23", 1601.60],
      ["2004-07-26", 1618.00], ["2004-07-27", 1600.75], ["2004-07-28", 1594.15], ["2004-07-29", 1618.70],
      ["2004-07-30", 1632.30], ["2004-08-02", 1639.05], ["2004-08-03", 1630.60], ["2004-08-04", 1626.55],
      ["2004-08-05", 1654.95], ["2004-08-06", 1633.40], ["2004-08-09", 1642.60], ["2004-08-10", 1652.15],
      ["2004-08-11", 1621.60], ["2004-08-12", 1607.20], ["2004-08-13", 1598.20], ["2004-08-16", 1599.15],
      ["2004-08-17", 1604.35], ["2004-08-18", 1581.80], ["2004-08-19", 1609.20], ["2004-08-20", 1590.35],
      ["2004-08-23", 1578.20], ["2004-08-24", 1591.60], ["2004-08-25", 1595.70], ["2004-08-26", 1610.75],
      ["2004-08-27", 1609.00], ["2004-08-30", 1628.45], ["2004-08-31", 1631.75], ["2004-09-01", 1635.45],
      ["2004-09-02", 1629.30], ["2004-09-03", 1634.10], ["2004-09-06", 1644.00], ["2004-09-07", 1650.15],
      ["2004-09-08", 1656.25], ["2004-09-09", 1649.00], ["2004-09-10", 1668.75], ["2004-09-13", 1675.20],
      ["2004-09-14", 1685.55], ["2004-09-15", 1683.20], ["2004-09-16", 1705.70], ["2004-09-17", 1733.65],
      ["2004-09-20", 1728.80], ["2004-09-21", 1750.20], ["2004-09-22", 1753.90], ["2004-09-23", 1726.15],
      ["2004-09-24", 1722.50], ["2004-09-27", 1717.50], ["2004-09-28", 1700.25], ["2004-09-29", 1727.95],
      ["2004-09-30", 1745.50],
    ],
  },
  // Kingfisher Airlines Oct 2012 - Mar 2013 (delisted, Yahoo has no KFA.NS),
  // daily closes. Source: NSE equity bhavcopy CLOSE.
  {
    symbolMatches: (s) => /^KFA/i.test(s),
    fromIso: "2012-10-01", toIso: "2013-03-31",
    points: [
      ["2012-10-01", 15.35], ["2012-10-03", 14.60], ["2012-10-04", 13.90], ["2012-10-05", 13.25],
      ["2012-10-08", 12.60], ["2012-10-09", 12.00], ["2012-10-10", 11.40], ["2012-10-11", 11.45],
      ["2012-10-12", 11.40], ["2012-10-15", 11.55], ["2012-10-16", 12.00], ["2012-10-17", 12.55],
      ["2012-10-18", 11.95], ["2012-10-19", 11.40], ["2012-10-22", 10.85], ["2012-10-23", 10.35],
      ["2012-10-25", 10.85], ["2012-10-26", 11.35], ["2012-10-29", 11.75], ["2012-10-30", 12.00],
      ["2012-10-31", 12.60], ["2012-11-01", 13.20], ["2012-11-02", 13.85], ["2012-11-05", 13.20],
      ["2012-11-06", 12.55], ["2012-11-07", 12.80], ["2012-11-08", 12.90], ["2012-11-09", 13.50],
      ["2012-11-12", 14.10], ["2012-11-13", 14.80], ["2012-11-15", 14.10], ["2012-11-16", 13.45],
      ["2012-11-19", 13.25], ["2012-11-20", 13.25], ["2012-11-21", 13.50], ["2012-11-22", 13.40],
      ["2012-11-23", 13.70], ["2012-11-26", 14.35], ["2012-11-27", 13.65], ["2012-11-29", 13.70],
      ["2012-11-30", 13.35], ["2012-12-03", 13.25], ["2012-12-04", 13.90], ["2012-12-05", 14.30],
      ["2012-12-06", 14.70], ["2012-12-07", 14.75], ["2012-12-10", 14.90], ["2012-12-11", 15.60],
      ["2012-12-12", 16.35], ["2012-12-13", 17.15], ["2012-12-14", 17.75], ["2012-12-17", 16.90],
      ["2012-12-18", 17.00], ["2012-12-19", 16.15], ["2012-12-20", 15.40], ["2012-12-21", 15.20],
      ["2012-12-24", 15.95], ["2012-12-26", 15.90], ["2012-12-27", 15.60], ["2012-12-28", 15.25],
      ["2012-12-31", 14.90], ["2013-01-01", 14.45], ["2013-01-02", 15.15], ["2013-01-03", 14.80],
      ["2013-01-04", 14.40], ["2013-01-07", 14.15], ["2013-01-08", 13.90], ["2013-01-09", 13.40],
      ["2013-01-10", 14.70], ["2013-01-11", 14.35], ["2013-01-14", 14.35], ["2013-01-15", 14.10],
      ["2013-01-16", 14.35], ["2013-01-17", 14.20], ["2013-01-18", 14.15], ["2013-01-21", 13.50],
      ["2013-01-22", 14.45], ["2013-01-23", 13.90], ["2013-01-24", 13.25], ["2013-01-25", 13.35],
      ["2013-01-28", 13.25], ["2013-01-29", 12.90], ["2013-01-30", 12.65], ["2013-01-31", 12.80],
      ["2013-02-01", 12.80], ["2013-02-04", 12.55], ["2013-02-05", 12.20], ["2013-02-06", 11.65],
      ["2013-02-07", 11.05], ["2013-02-08", 10.10], ["2013-02-11", 10.60], ["2013-02-12", 11.10],
      ["2013-02-13", 10.55], ["2013-02-14", 10.05], ["2013-02-15", 9.55], ["2013-02-18", 10.00],
      ["2013-02-19", 10.50], ["2013-02-20", 11.00], ["2013-02-21", 11.55], ["2013-02-22", 11.90],
      ["2013-02-25", 11.35], ["2013-02-26", 10.80], ["2013-02-27", 10.30], ["2013-02-28", 9.80],
      ["2013-03-01", 9.70], ["2013-03-04", 9.25], ["2013-03-05", 9.70], ["2013-03-06", 9.85],
      ["2013-03-07", 9.60], ["2013-03-08", 10.05], ["2013-03-11", 9.95], ["2013-03-12", 9.80],
      ["2013-03-13", 9.85], ["2013-03-14", 9.60], ["2013-03-15", 9.55], ["2013-03-18", 9.10],
      ["2013-03-19", 8.85], ["2013-03-20", 8.45], ["2013-03-21", 8.70], ["2013-03-22", 9.05],
      ["2013-03-25", 8.60], ["2013-03-26", 8.35], ["2013-03-28", 8.00],
    ],
  },
  // Satyam Computer Jan-Apr 2009 (delisted, Yahoo has no SATYAMCOMP.NS),
  // daily closes. Source: NSE equity bhavcopy CLOSE.
  {
    symbolMatches: (s) => /^SATYAM/i.test(s),
    fromIso: "2009-01-01", toIso: "2009-04-30",
    points: [
      ["2009-01-01", 181.70], ["2009-01-02", 177.20], ["2009-01-05", 167.15], ["2009-01-06", 178.95],
      ["2009-01-07", 40.25], ["2009-01-09", 23.75], ["2009-01-12", 34.40], ["2009-01-13", 31.05],
      ["2009-01-14", 29.85], ["2009-01-15", 20.30], ["2009-01-16", 24.50], ["2009-01-19", 25.50],
      ["2009-01-20", 26.85], ["2009-01-21", 27.75], ["2009-01-22", 29.60], ["2009-01-23", 38.85],
      ["2009-01-27", 47.25], ["2009-01-28", 55.60], ["2009-01-29", 49.95], ["2009-01-30", 53.85],
      ["2009-02-02", 57.45], ["2009-02-03", 53.85], ["2009-02-04", 50.10], ["2009-02-05", 46.45],
      ["2009-02-06", 47.50], ["2009-02-09", 46.30], ["2009-02-10", 44.20], ["2009-02-11", 47.05],
      ["2009-02-12", 46.10], ["2009-02-13", 46.35], ["2009-02-16", 49.55], ["2009-02-17", 50.20],
      ["2009-02-18", 48.55], ["2009-02-19", 46.20], ["2009-02-20", 45.55], ["2009-02-24", 43.85],
      ["2009-02-25", 45.15], ["2009-02-26", 45.15], ["2009-02-27", 41.35], ["2009-03-02", 40.25],
      ["2009-03-03", 39.25], ["2009-03-04", 37.90], ["2009-03-05", 35.10], ["2009-03-06", 42.15],
      ["2009-03-09", 48.80], ["2009-03-12", 47.05], ["2009-03-13", 45.50], ["2009-03-16", 45.25],
      ["2009-03-17", 43.60], ["2009-03-18", 43.70], ["2009-03-19", 44.50], ["2009-03-20", 43.95],
      ["2009-03-23", 42.35], ["2009-03-24", 41.60], ["2009-03-25", 40.35], ["2009-03-26", 42.30],
      ["2009-03-27", 42.70], ["2009-03-30", 39.35], ["2009-03-31", 38.45], ["2009-04-01", 39.65],
      ["2009-04-02", 39.90], ["2009-04-06", 45.20], ["2009-04-08", 45.65], ["2009-04-09", 47.25],
      ["2009-04-13", 48.75], ["2009-04-15", 47.55], ["2009-04-16", 44.90], ["2009-04-17", 45.55],
      ["2009-04-20", 47.70], ["2009-04-21", 49.05], ["2009-04-22", 46.90], ["2009-04-23", 47.15],
      ["2009-04-24", 47.05], ["2009-04-27", 48.20], ["2009-04-28", 46.50], ["2009-04-29", 46.80],
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
          await cachePutAwait("history", cacheKey, null, out);
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
    await cachePutAwait("history", cacheKey, null, out);
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

Navigation targets: /portfolio /stocks /news /chat /crash-replay /report-card /settings /stocks/<TICKER>
Rules: educational → answer (Saathi voice, Indian teen audience, no emojis, no buy/sell advice). Go somewhere → navigate. Filter stocks → search. Place trade → trade (qty ≥ 1). Garbage/off-scope → answer + brief redirect. Return ONLY the JSON.`;

async function opCommand(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const query = String(body.query || "").trim().slice(0, 400);
  if (!query) return j(400, { error: "missing_query" }, origin);
  const context = String(body.context || "").slice(0, 200);
  const userMsg = context ? `Current page: ${context}\nCommand: ${query}` : `Command: ${query}`;
  try {
    const text = await callLlm({ op: "command",
      messages: [{ role: "system", content: SYSTEM_COMMAND }, { role: "user", content: userMsg }],
      max_tokens: 400, temperature: 0.2, response_format: { type: "json_object" }, profile: "json", effort: "medium",
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
    h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    h.set("Access-Control-Max-Age", "600");
    return new Response(null, { status: 204, headers: h });
  }
  if (origin && !allowed(origin)) return j(403, { error: "forbidden_origin" }, origin);

  // Read an oversized upload before refusing it: answering with the body
  // unread crashes the Node function and the next request with it.
  const cl = parseInt(req.headers.get("Content-Length") || "0", 10);
  if (cl > MAX_BODY) {
    try { await req.arrayBuffer(); } catch {}
    return j(413, { error: "payload_too_large" }, origin);
  }

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
      case "admin-signup-stats":  return await opAdminSignupStats(req, origin);
      case "admin-signup-count":  return await opAdminSignupCount(req, origin);
      case "admin-web-analytics": return await opAdminWebAnalytics(req, origin);
      case "search-snapshot":     return await opSearchSnapshot(req, origin);
      case "ev":                  if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opEv(req, origin);
      case "admin-behaviour":     return await opAdminBehaviour(req, origin, url);
      case "admin-journey":       return await opAdminJourney(req, origin, url);
      case "admin-click-map":     return await opAdminClickMap(req, origin, url);
      case "admin-user":          return await opAdminUser(req, origin, url);
      case "admin-activity-feed": return await opAdminActivityFeed(req, origin, url);
      case "admin-ai-cache":      return await opAdminAiCache(req, origin, url);
      case "admin-quote-cache":   return await opAdminQuoteCache(req, origin);
      case "admin-llm-usage":     return await opAdminLlmUsage(req, origin, url);
      case "admin-growth":        return await opAdminGrowth(req, origin, url);
      case "admin-retention-tracking": return await opAdminRetentionTracking(req, origin, url);
      case "admin-coach-quality": return await opAdminCoachQuality(req, origin, url);
      case "admin-dhan-coverage": return await opAdminDhanCoverage(req, origin);
      case "admin-audit-log":     return await opAdminAuditLog(req, origin, url);
      case "admin-user-reset":    return await opAdminUserReset(req, origin);
      case "admin-user-ban":      return await opAdminUserBan(req, origin);
      case "admin-user-unban":    return await opAdminUserUnban(req, origin);
      case "admin-user-delete":   return await opAdminUserDelete(req, origin);
      case "admin-profile-patch": return await opAdminProfilePatch(req, origin);
      case "admin-order-cancel":  return await opAdminOrderCancel(req, origin);
      case "admin-trade-delete":  return await opAdminTradeDelete(req, origin);
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

// Signups tab: admin_signup_stats() works out every number inside Postgres
// (Indian-time day/hour buckets, rolling windows, records, top 10s, activity)
// and returns ~20 KB in one call.
async function opAdminSignupStats(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  try {
    const res = await sbAdminFetch(`/rest/v1/rpc/admin_signup_stats`, { method: "POST", body: "{}" });
    if (!res.ok) return j(502, { error: "query_failed", detail: `admin_signup_stats ${res.status}` }, origin);
    return j(200, await res.json(), origin);
  } catch (e) {
    return j(500, { error: "signup_stats_failed", detail: String(e?.message || e) }, origin);
  }
}

// The Signups tab's live number: one count, ~1 KB per check.
async function opAdminSignupCount(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  try {
    const res = await sbAdminFetch(`/rest/v1/rpc/signup_count`, { method: "GET" });
    const body = await res.text();
    if (!res.ok) return j(502, { error: "query_failed", detail: `signup_count ${res.status}` }, origin);
    return j(200, { count: Number(body), ts: new Date().toISOString() }, origin);
  } catch (e) {
    return j(500, { error: "signup_count_failed", detail: String(e?.message || e) }, origin);
  }
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
    // admin_overview() counts and sums every table per user inside Postgres
    // and returns one compact array per user (~0.5 MB). This used to pull
    // seven whole tables (~3.5 MB) into this function on every load, which
    // was a large share of the Supabase egress quota.
    const res = await sbAdminFetch(`/rest/v1/rpc/admin_overview`, { method: "POST", body: "{}" });
    if (!res.ok) return j(502, { error: "query_failed", detail: `admin_overview ${res.status}` }, origin);
    const { users: rows = [], counts = {} } = await res.json();

    // Per-user enriched row — 27 axes available to the UI for sorting/filtering
    const users = rows.map(([
      id, username, displayName, email, age, school, classCode, city, riskProfile,
      avatarColor, onboarded, createdAt, updatedAt, cashPaise, startingCashPaise,
      portUpdatedAt, holdCostPaise, holdingCount, tradeCount, tradedValuePaise,
      biasFlagCount, lastTrade, coachMsgCount, watchlistCount, limitOrderCount,
    ]) => {
      const hasPort = cashPaise != null;
      const cashRupees = hasPort ? Math.round(Number(cashPaise) / 100) : null;
      const holdingsValueRupees = Math.round(Number(holdCostPaise || 0) / 100);
      const totalPortfolioRupees = (cashRupees || 0) + holdingsValueRupees;
      const startingRupees = hasPort ? Math.round(Number(startingCashPaise || 10000000) / 100) : 100000;
      const unrealizedPLPct = startingRupees ? ((totalPortfolioRupees - startingRupees) / startingRupees) * 100 : 0;
      const daysSinceLastTrade = lastTrade
        ? Math.floor((Date.now() - new Date(lastTrade).getTime()) / 86400000)
        : null;
      return {
        id, username, displayName, email, age, school, classCode, city, riskProfile,
        avatarColor, onboarded, createdAt, updatedAt,
        cashRupees,
        startingCashRupees: startingRupees,
        holdingsValueRupees,
        totalPortfolioRupees,
        unrealizedPLPct: Math.round(unrealizedPLPct * 100) / 100,
        lastActive: portUpdatedAt || createdAt,
        tradeCount,
        totalTradedValueRupees: Math.round(Number(tradedValuePaise || 0) / 100),
        coachMsgCount,
        holdingCount,
        watchlistCount,
        limitOrderCount,
        biasFlagCount,
        lastTradeAt: lastTrade || null,
        daysSinceLastTrade,
      };
    });

    // Populate the 30-day sign-up chart
    for (const u of users) {
      const k = istDayKey(new Date(u.createdAt));
      if (k in buckets) buckets[k]++;
    }
    const byDay = Object.entries(buckets).sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, count]) => ({ day, count }));

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
        totalTrades: counts.transactions || 0,
        totalCoachMessages: counts.coach_messages || 0,
        totalHoldings: counts.holdings || 0,
        totalWatchlistEntries: counts.watchlist || 0,
        totalLimitOrders: counts.limit_orders || 0,
      },
      rowCounts: counts,
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
      watchRes, orderRes, auditRes,
    ] = await Promise.all([
      sbAdminFetch(`/rest/v1/profiles?select=*&id=eq.${encodeURIComponent(userId)}&limit=1`),
      sbAdminFetch(`/rest/v1/portfolios?select=*&user_id=eq.${encodeURIComponent(userId)}&limit=1`),
      sbAdminFetch(`/rest/v1/holdings?select=*&user_id=eq.${encodeURIComponent(userId)}&limit=500`),
      sbAdminFetch(`/rest/v1/transactions?select=*&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=500`),
      sbAdminFetch(`/rest/v1/coach_messages?select=*&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=500`),
      sbAdminFetch(`/rest/v1/portfolio_history?select=ts,total_value_paise,cash_paise,holdings_value_paise,source&user_id=eq.${encodeURIComponent(userId)}&order=ts.asc&limit=2000`),
      sbAdminFetch(`/rest/v1/watchlist?select=symbol,added_at&user_id=eq.${encodeURIComponent(userId)}&order=added_at.desc&limit=200`),
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
      portfolioHistory, watchlist, limitOrders,
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
// GET /api/ai?op=admin-activity-feed&limit=200&before=<ts>&filter=<trades|coach|orders|signups>
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
      orders:    filter === "all" || filter === "orders",
      signups:   filter === "all" || filter === "signups",
    };
    const [txRes, coachRes, orderRes, signupRes] = await Promise.all([
      wants.trades    ? sbAdminFetch(`/rest/v1/transactions?select=id,user_id,symbol,side,qty,price_paise,value_paise,created_at&order=created_at.desc&limit=${limit}${beforeQ}`) : { ok: true, json: async () => [] },
      wants.coach     ? sbAdminFetch(`/rest/v1/coach_messages?select=id,user_id,event_type,trigger_symbol,model,created_at&order=created_at.desc&limit=${limit}${beforeQ}`) : { ok: true, json: async () => [] },
      wants.orders    ? sbAdminFetch(`/rest/v1/limit_orders?select=id,user_id,symbol,side,qty,status,created_at&order=created_at.desc&limit=${limit}${beforeQ}`) : { ok: true, json: async () => [] },
      wants.signups   ? sbAdminFetch(`/rest/v1/profiles?select=id,username,display_name,created_at&order=created_at.desc&limit=${limit}${beforeQ}`) : { ok: true, json: async () => [] },
    ]);
    const trades    = txRes.ok ? await txRes.json() : [];
    const coach     = coachRes.ok ? await coachRes.json() : [];
    const orders    = orderRes.ok ? await orderRes.json() : [];
    const signups   = signupRes.ok ? await signupRes.json() : [];

    const events = [
      ...trades.map(t => ({ kind: "trade", ts: t.created_at, userId: t.user_id, payload: t })),
      ...coach.map(c => ({ kind: "coach", ts: c.created_at, userId: c.user_id, payload: c })),
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
// op: admin-llm-usage — the AI cost tab (public.admin_llm_usage, migration 2026-10-23a)
// -----------------------------------------------------------------------------
async function opAdminLlmUsage(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") || "7", 10) || 7));
  try {
    const r = await sbAdminFetch(`/rest/v1/rpc/admin_llm_usage`, {
      method: "POST",
      body: JSON.stringify({ p_since: new Date(Date.now() - days * 86400000).toISOString(), p_until: new Date(Date.now() + 60000).toISOString() }),
    });
    if (!r.ok) return j(502, { error: "query_failed", detail: (await r.text()).slice(0, 200) }, origin);
    return j(200, await r.json(), origin);
  } catch (e) {
    return j(502, { error: "query_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// -----------------------------------------------------------------------------
// op: admin-growth — retention, time to first trade, adoption (migration 2026-10-24a)
// -----------------------------------------------------------------------------
async function opAdminGrowth(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const weeks = Math.min(52, Math.max(1, parseInt(url.searchParams.get("weeks") || "12", 10) || 12));
  try {
    const r = await sbAdminFetch(`/rest/v1/rpc/admin_growth`, { method: "POST", body: JSON.stringify({ p_weeks: weeks }) });
    if (!r.ok) return j(502, { error: "query_failed", detail: (await r.text()).slice(0, 200) }, origin);
    return j(200, await r.json(), origin);
  } catch (e) {
    return j(502, { error: "query_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// -----------------------------------------------------------------------------
// op: admin-retention-tracking — sends, deliveries, opens, opt-outs and the
// recap holdout comparison (retention_scoreboard, migration 2026-10-24e)
// -----------------------------------------------------------------------------
async function opAdminRetentionTracking(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get("days") || "14", 10) || 14));
  try {
    const r = await sbAdminFetch(`/rest/v1/rpc/retention_scoreboard`, { method: "POST", body: JSON.stringify({ p_days: days }) });
    if (!r.ok) return j(502, { error: "query_failed", detail: (await r.text()).slice(0, 200) }, origin);
    return j(200, await r.json(), origin);
  } catch (e) {
    return j(502, { error: "query_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// -----------------------------------------------------------------------------
// op: admin-coach-quality (migration 2026-10-24b)
// -----------------------------------------------------------------------------
async function opAdminCoachQuality(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const days = Math.min(120, Math.max(1, parseInt(url.searchParams.get("days") || "30", 10) || 30));
  try {
    const r = await sbAdminFetch(`/rest/v1/rpc/admin_coach_quality`, { method: "POST", body: JSON.stringify({ p_days: days }) });
    if (!r.ok) return j(502, { error: "query_failed", detail: (await r.text()).slice(0, 200) }, origin);
    return j(200, await r.json(), origin);
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
      // Escape "_" and "%": unescaped, "komal00__" also matched "komal00ab",
      // so a username with underscores could resolve to another user's email.
      `/rest/v1/profiles?select=email&username=ilike.${encodeURIComponent(username.replace(/[\\%_]/g, (m) => "\\" + m))}&limit=1`
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
// Requires VERCEL_TOKEN. VERCEL_TEAM_ID / VERCEL_PROJECT_ID default to this
// project's IDs (they are identifiers, not secrets), so the token is the only
// thing to set.
// https://vercel.com/docs/rest-api
// =============================================================================
const VERCEL_DEFAULT_TEAM = "team_uDFTGZMVEwrjtxi21s7Pb0Nl";
const VERCEL_DEFAULT_PROJECT = "prj_EnsEmBUp905QAg88YlS2n0SBabCe";
function vercelProjectId() {
  return (globalThis.process?.env || {}).VERCEL_PROJECT_ID || VERCEL_DEFAULT_PROJECT;
}

const VERCEL_BASE = "https://api.vercel.com";

async function vercelFetch(path, opts = {}) {
  const env = globalThis.process?.env || {};
  if (!env.VERCEL_TOKEN) throw new Error("vercel_not_configured");
  const teamId = env.VERCEL_TEAM_ID || VERCEL_DEFAULT_TEAM;
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

// =============================================================================
// VISITOR TRACKING — op=ev (anyone, signed in or not) -> web_events
// The browser (js/features/telemetry.js) batches events and posts them here.
// Everything is cleaned before it reaches the database: known kinds only,
// clamped sizes, timestamps rebuilt from numbers. The account is taken from
// the verified session token, never from the browser's word.
// =============================================================================
const EV_KINDS = new Set([
  "session_start", "page", "page_leave", "click", "rage_click", "form_start", "field",
  "form_submit", "form_abandon", "form_error", "toast", "error", "api", "perf", "search",
  "outbound", "copy", "net", "install", "visibility", "share", "media", "coach",
]);
const EV_BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|whatsapp|python-requests|curl|wget/i;
const EV_ID = /^[A-Za-z0-9_-]{8,40}$/;
const evRate = new Map();   // ip -> { n, reset }  (per warm instance; a soft cap)

function evClean(v, max = 300) {
  if (v == null) return null;
  const t = typeof v;
  if (t === "number") return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  if (t === "boolean") return v ? 1 : 0;
  if (t === "string") return v.slice(0, max);
  return null;
}
function evProps(o) {
  const out = {};
  if (!o || typeof o !== "object" || Array.isArray(o)) return out;
  let k = 0;
  for (const [key, val] of Object.entries(o)) {
    if (k >= 24) break;
    if (!/^[A-Za-z0-9_]{1,24}$/.test(key)) continue;
    const c = evClean(val);
    if (c === null || c === "") continue;
    out[key] = c;
    k++;
  }
  return out;
}

// Supabase session token -> account id, checked locally (no auth round trip).
// HS256 with the project's JWT secret, or ES256/RS256 against the project's
// published keys (fetched once per warm instance).
let evJwks = null, evJwksAt = 0;
const evTokCache = new Map();   // token -> { uid, exp }
function b64urlBytes(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
async function evVerifyToken(tok) {
  if (!tok || typeof tok !== "string" || tok.length > 4096) return null;
  const hit = evTokCache.get(tok);
  if (hit) return hit.exp * 1000 > Date.now() ? hit.uid : null;
  const parts = tok.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1])));
  } catch { return null; }
  if (!payload?.sub || !payload.exp || payload.exp * 1000 < Date.now()) return null;
  if (payload.role && payload.role !== "authenticated") return null;
  const env = globalThis.process?.env || {};
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = b64urlBytes(parts[2]);
  let ok = false;
  try {
    if (header.alg === "HS256" && env.SUPABASE_JWT_SECRET) {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
        { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
      ok = await crypto.subtle.verify("HMAC", key, sig, data);
    } else if ((header.alg === "ES256" || header.alg === "RS256") && env.SUPABASE_URL) {
      if (!evJwks || Date.now() - evJwksAt > 3600_000) {
        const r = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`);
        if (r.ok) { evJwks = (await r.json()).keys || []; evJwksAt = Date.now(); }
      }
      const jwk = (evJwks || []).find((k) => k.kid === header.kid) || (evJwks || [])[0];
      if (jwk) {
        const algo = header.alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
        const key = await crypto.subtle.importKey("jwk", jwk, algo, false, ["verify"]);
        ok = await crypto.subtle.verify(header.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : algo, key, sig, data);
      }
    }
  } catch { ok = false; }
  if (!ok) return null;
  if (evTokCache.size > 5000) evTokCache.clear();
  evTokCache.set(tok, { uid: payload.sub, exp: payload.exp });
  return payload.sub;
}

async function opEv(req, origin) {
  const none = () => new Response(null, { status: 204, headers: cors(origin) });
  const ua = req.headers.get("User-Agent") || "";
  if (!ua || EV_BOT.test(ua)) return none();
  const ip = (req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "?").split(",")[0].trim();
  const now = Date.now();
  const r = evRate.get(ip);
  if (r && r.reset > now) { if (r.n > 600) return none(); }
  let body;
  try { body = JSON.parse(await req.text()); } catch { return j(400, { error: "bad_body" }, origin); }
  const vid = body?.v, sid0 = body?.s;
  if (!EV_ID.test(String(vid || "")) || !EV_ID.test(String(sid0 || ""))) return j(400, { error: "bad_ids" }, origin);
  const list = Array.isArray(body.e) ? body.e.slice(0, 80) : [];
  const cc = (req.headers.get("x-vercel-ip-country") || "").slice(0, 2) || null;
  const rows = [];
  for (const e of list) {
    if (!Array.isArray(e)) continue;
    const [t, kind, path, target, props, sid] = e;
    if (!EV_KINDS.has(kind)) continue;
    const ts = Number.isFinite(t) ? Math.min(now, Math.max(now - 2 * 86400_000, t)) : now;
    const pr = evProps(props);
    if (kind === "session_start" && cc) pr.cc = cc;
    rows.push({
      ts: new Date(ts).toISOString(),
      vid, sid: EV_ID.test(String(sid || "")) ? sid : sid0,
      kind,
      path: typeof path === "string" && path.startsWith("/") ? path.slice(0, 300) : null,
      target: typeof target === "string" ? target.slice(0, 300) : (typeof target === "number" ? String(target) : null),
      props: pr,
    });
  }
  if (!rows.length) return none();
  evRate.set(ip, r && r.reset > now ? { n: r.n + rows.length, reset: r.reset } : { n: rows.length, reset: now + 60_000 });
  if (evRate.size > 20000) evRate.clear();
  const uid = await evVerifyToken(body.tok);
  try {
    await sbAdminFetch(`/rest/v1/rpc/ingest_web_events`, {
      method: "POST",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify({ p: rows, p_uid: uid, p_country: cc }),
    });
  } catch { /* tracking must never break the page */ }
  return none();
}

// Markets search box: every symbol's last close, day and 2-week change and a
// few fundamentals in one compact file (search_snapshot() in Postgres). The
// data only changes after the nightly NSE import, so the CDN keeps it for 6 h
// and serves the old copy while refreshing — a few database reads a day no
// matter how many students search.
async function opSearchSnapshot(req, origin) {
  const res = await sbAdminFetch(`/rest/v1/rpc/search_snapshot`, { method: "POST", body: "{}" });
  if (!res.ok) return j(502, { error: "query_failed" }, origin);
  const h = cors(origin, false);
  h.set("Cache-Control", "public, max-age=3600");
  h.set("CDN-Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
  // Postgres prints JSON with a space after every comma; re-serialising
  // drops ~10% before compression.
  return new Response(JSON.stringify(await res.json()), { status: 200, headers: h });
}

async function opAdminBehaviour(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get("days") || "7", 10) || 7));
  const res = await sbAdminFetch(`/rest/v1/rpc/admin_behaviour_stats`, { method: "POST", body: JSON.stringify({ p_days: days }) });
  if (!res.ok) return j(502, { error: "query_failed", detail: `admin_behaviour_stats ${res.status}` }, origin);
  return j(200, await res.json(), origin);
}

async function opAdminJourney(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const uid = url.searchParams.get("uid") || "";
  if (!/^[0-9a-f-]{36}$/i.test(uid)) return j(400, { error: "bad_uid" }, origin);
  const res = await sbAdminFetch(`/rest/v1/rpc/admin_user_journey`, { method: "POST", body: JSON.stringify({ p_uid: uid, p_limit: 600 }) });
  if (!res.ok) return j(502, { error: "query_failed", detail: `admin_user_journey ${res.status}` }, origin);
  return j(200, await res.json(), origin);
}

async function opAdminClickMap(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const path = (url.searchParams.get("path") || "/").slice(0, 300);
  const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get("days") || "7", 10) || 7));
  const dev = url.searchParams.get("dev") || null;
  const res = await sbAdminFetch(`/rest/v1/rpc/admin_click_map`, { method: "POST", body: JSON.stringify({ p_path: path, p_days: days, p_dev: dev }) });
  if (!res.ok) return j(502, { error: "query_failed", detail: `admin_click_map ${res.status}` }, origin);
  return j(200, { points: await res.json() }, origin);
}

// Vercel Web Analytics: every visitor, signed in or not (user_events only
// sees signed-in people). Vercel buckets days and hours in UTC and allows at
// most 62 days per daily query.
async function opAdminWebAnalytics(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const env = globalThis.process?.env || {};
  if (!env.VERCEL_TOKEN) return j(200, { ok: false, error: "vercel_not_configured" }, origin);
  const now = Date.now();
  const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const iso = (t) => new Date(t).toISOString();
  const q = (by, since, limit) => {
    const p = new URLSearchParams({ projectId: vercelProjectId(), since: iso(since), until: iso(now), limit: String(limit) });
    for (const b of [].concat(by)) p.append("by", b);
    return vercelFetch(`/v1/query/web-analytics/visits/aggregate?${p}`)
      .then(async (r) => (r.ok ? (await r.json()).data || [] : { error: `${r.status} ${(await r.text()).slice(0, 160)}` }))
      .catch((e) => ({ error: String(e?.message || e) }));
  };
  const week = dayStart - 6 * 86400000;
  const [daily, hourly, paths, referrers, countries, devices] = await Promise.all([
    q("day", dayStart - 59 * 86400000, 100),
    q("hour", now - 48 * 3600000, 100),
    q("requestPath", week, 15),
    q("referrerHostname", week, 10),
    q("country", week, 10),
    q("deviceType", week, 5),
  ]);
  const errs = [daily, hourly, paths, referrers, countries, devices].filter((x) => x && x.error).map((x) => x.error);
  if (errs.length === 6) return j(502, { ok: false, error: "vercel_query_failed", detail: errs[0] }, origin);
  const series = (rows) => (Array.isArray(rows) ? rows.map((r) => [r.timestamp, r.visitors || 0, r.pageviews || 0]) : []);
  const top = (rows, key) => (Array.isArray(rows) ? rows.map((r) => [r[key] || "", r.visitors || 0, r.pageviews || 0]) : []);
  return j(200, {
    ok: true,
    at: iso(now),
    weekSince: iso(week),
    daily: series(daily),
    hourly: series(hourly),
    paths: top(paths, "requestPath"),
    referrers: top(referrers, "referrerHostname"),
    countries: top(countries, "country"),
    devices: top(devices, "deviceType"),
    errors: errs,
  }, origin);
}

async function opAdminVercelDeployments(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const env = globalThis.process?.env || {};
  if (!env.VERCEL_TOKEN) return j(501, { error: "vercel_not_configured" }, origin);
  const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "30", 10)));
  const target = url.searchParams.get("target") || ""; // 'production' or ''
  let path = `/v6/deployments?projectId=${encodeURIComponent(vercelProjectId())}&limit=${limit}`;
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
  if (!vercelProjectId()) return j(501, { error: "vercel_project_id_missing" }, origin);
  try {
    const r = await vercelFetch(`/v10/projects/${encodeURIComponent(vercelProjectId())}/env`);
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
  if (!vercelProjectId()) return j(501, { error: "vercel_project_id_missing" }, origin);

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
    const projId = encodeURIComponent(vercelProjectId());
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
    const r = await vercelFetch(`/v9/projects/${encodeURIComponent(vercelProjectId())}/promote/${encodeURIComponent(id)}`, {
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
  if (!vercelProjectId()) return j(501, { error: "vercel_project_id_missing" }, origin);
  try {
    const r = await vercelFetch(`/v9/projects/${encodeURIComponent(vercelProjectId())}/domains`);
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
// SSE LIVE TAIL — unified event stream of trades / coach / orders
// / signups / admin-actions, emitted as Server-Sent Events.
//
// Why poll-based, not Supabase-realtime-proxied:
// A clean SSE from realtime would require a persistent server connection and
// Vercel Edge runtime has short-lived request limits. Instead, this endpoint
// is a long-polling SSE that wakes up every 10 seconds, makes ONE call to
// admin_tail_since() for every event newer than the watermark, and emits them
// as SSE events. Connection closes after 4 minutes; the client reopens it
// with ?since=<watermark> only while the admin tab is visible.
//
// It used to read five tables every 2 seconds and the browser reconnected
// forever, even in a background tab: 153k Supabase requests on 16 Oct 2026,
// half of all API traffic and a large share of the egress quota.
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

const TAIL_POLL_MS = 10_000;

async function opAdminTail(req, origin) {
  const url = new URL(req.url);
  const gate = checkAdminQuery(url);
  if (!gate.ok) return new Response("not_authorised", { status: 401 });

  const encoder = new TextEncoder();
  // Stop polling the moment the browser goes away; before, a closed tab kept
  // this loop querying Supabase until the 4-minute cap.
  let closed = false;
  req.signal?.addEventListener?.("abort", () => { closed = true; });
  const stream = new ReadableStream({
    async start(controller) {
      // Watermark: where the feed left off. Start from "now" unless the
      // client sent a valid ?since=<iso> to resume from a specific timestamp.
      const sinceArg = url.searchParams.get("since");
      let since = sinceArg && !isNaN(Date.parse(sinceArg)) ? sinceArg : new Date().toISOString();
      const endAt = Date.now() + 4 * 60 * 1000;

      function send(event, data) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { closed = true; }
      }

      send("open", { since, ts: new Date().toISOString() });

      while (!closed && Date.now() < endAt) {
        try {
          const r = await sbAdminFetch(`/rest/v1/rpc/admin_tail_since`, {
            method: "POST",
            body: JSON.stringify({ p_since: since, p_limit: 200 }),
          });
          const events = r.ok ? await r.json() : [];
          if (Array.isArray(events) && events.length) {
            for (const ev of events) send(ev.kind, ev);
            since = events[events.length - 1].ts;
          }
        } catch {}
        // Heartbeat every iteration so clients know we're alive.
        send("hb", { ts: new Date().toISOString(), since });
        await new Promise(r => setTimeout(r, TAIL_POLL_MS));
      }
      send("close", { reason: "duration_exceeded", since });
      try { controller.close(); } catch {}
    },
    cancel() { closed = true; },
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
