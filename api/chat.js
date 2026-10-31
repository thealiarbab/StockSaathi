// =============================================================================
// /api/chat  —  Edge-runtime LLM proxy, multi-provider.
//
// Accepts an OpenAI-compatible chat-completion body. Routes to the right
// upstream based on an optional `profile` field in the body:
//   profile: "reasoning"  (default) → OpenAI GPT (smartest + warmest)
//   profile: "fast"                 → Gemini Flash (instant feel)
//   profile: "creative"             → OpenAI GPT (humor + prose)
//   profile: "json"                 → whichever primary is configured, JSON mode
//
// For each profile there is a primary, a fallback, and a free-tier floor.
// If primary 5xx/429s, we silently try fallback. If fallback fails too,
// we try Groq/Llama (free). The client never sees which upstream answered.
//
// Env vars (all optional; missing ones are skipped in the fallback chain):
//   OPENAI_API_KEY       — primary for reasoning + creative
//   OPENAI_MODEL         — default "gpt-5.4" (override to stay on a pinned version)
//   GEMINI_API_KEY       — primary for fast, fallback for reasoning
//   GEMINI_FAST_MODEL    — default "gemini-3.1-flash"
//   GEMINI_PRO_MODEL     — default "gemini-3.1-pro"
//   CEREBRAS_API_KEY     — optional blazing-fast backup serving Llama
//   CEREBRAS_MODEL       — default "llama3.3-70b"
//   GROQ_API_KEY         — free-tier floor, always tried last
//   GROQ_MODEL           — default "llama-3.3-70b-versatile"
//
// Safety posture mirrored from the Python endpoint this replaces:
//   - Origin allowlist (rejects cross-site abuse).
//   - Body size cap.
//   - max_tokens cap server-side (client can't upgrade to expensive generations).
//   - Error bodies redact bearer tokens + API-key-shaped strings.
//
// NOT a safety property, despite what this list said until 2026-09-14:
// `tools` / `tool_choice` are NOT stripped. They are passed through, because
// the coach agent needs function-calling (see the max_tokens block below).
// Nothing in this file removes them; the only runtime reference to `tools` is
// the wantsStream check. The claim sat here for months and is exactly the kind
// of thing the next person builds on — a client CAN send arbitrary tool
// definitions. That is low-severity today because tools are only ever
// EXECUTED client-side, so a forged definition costs the caller tokens and
// nothing else. Do not rely on this endpoint to sanitise them.
// =============================================================================

import { liveGeminiModel } from "./_models.js";
import { recordUsage, featureOf, normUsage, tapOpenAiSse } from "./_usage.js";
import { callerHashes, isBlocked, inLockdown, hasHumanPass } from "./_guard.js";
import {
  messagesEnabled, messagesFetch, toMessagesBody, toChatCompletion, toChatSse, MESSAGES_MODEL, effortFor,
} from "./_messages.js";

export const config = { runtime: "edge" };

// 1 MB: a long chat with its full history, tool results and reasoning
// blocks (upstream_blocks) is a few hundred KB. Anything bigger is not a
// student's chat, and this endpoint pays for every token it forwards.
const MAX_BODY = 1_000_000;

// Best-effort flood guard, per instance and per IP. Edge instances are
// short-lived and regional, so this stops a single burst, not a determined
// attacker; that needs a rate-limit rule in the Vercel firewall.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;   // high on purpose: a whole classroom can share one school IP
const _hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const h = _hits.get(ip);
  if (!h || now - h.start > RATE_WINDOW_MS) {
    _hits.set(ip, { start: now, n: 1 });
    if (_hits.size > 5000) for (const [k, v] of _hits) if (now - v.start > RATE_WINDOW_MS) _hits.delete(k);
    return false;
  }
  return ++h.n > RATE_MAX;
}
// The Gemini models' own output ceiling. Not a budget: see the max_tokens
// block in the handler.
export const MAX_OUTPUT_TOKENS = 65535;

// How long any ONE upstream gets to return response headers before we give
// up and try the next in the chain.
//
// Vercel edge functions are killed at ~25s. With no per-attempt bound, the
// first slow provider eats that entire budget and the caller gets a 504 with
// nothing at all — which is strictly worse than a fallback answer. 9s leaves
// room for two full attempts plus overhead inside the limit.
export const UPSTREAM_TIMEOUT_MS = Number(globalThis.process?.env?.UPSTREAM_TIMEOUT_MS) || 9000;
// The Messages upstream leads every chain, and its non-streaming endpoint
// returns headers only once the whole reply (thinking included) is written,
// so a tool turn or a crash-replay date pick needs longer than 9s to show
// headers on a slow day. 14s + one 9s fallback attempt still lands inside
// the ~25s edge limit.
export const MESSAGES_TIMEOUT_MS = Number(globalThis.process?.env?.MESSAGES_TIMEOUT_MS) || 14000;

// Per-profile thinking budget. See the block where this is applied for the
// measurements behind it. Env-overridable so the trade can be retuned
// without a deploy.
//
//   chat      conversational coach — greetings, concepts, explanations.
//             "minimal" is the smallest budget the upstream accepts. The
//             valid set is high | low | max | medium | minimal; "none" is
//             REJECTED with a 400, so do not reach for it. (I shipped
//             "none" once: every request 400'd, and the 0.15s I had
//             "measured" for it was the error coming back fast, not an
//             answer. Measure the body, not just the clock.)
//             This lane has no tools and no data to reason over, so the
//             smallest budget is right: it is Gemini 3 Flash talking, which
//             is a far stronger base than the 2.5 Flash Lite this used to
//             be — it simply is not spending a turn thinking before saying
//             hello.
//   fast      tool-use. Keeps "low" — it has to reason about WHICH tool to
//             call and how to read the result back. The facts come from the
//             tools, so it does not need more than that, and this lane was
//             never the one the user watches a cursor blink on.
//   json      "minimal": the 3.1 Flash-Lite successor of the old
//             non-thinking 2.5 Flash-Lite lane (see GEMINI_JSON).
//   reasoning / creative  deliberately left alone. These lanes exist to
//             think, are not on the interactive path, and nobody is watching
//             a cursor blink while they run.
const REASONING_EFFORT = {
  chat: (globalThis.process?.env?.CHAT_REASONING_EFFORT) || "minimal",
  fast: (globalThis.process?.env?.FAST_REASONING_EFFORT) || "low",
  json: (globalThis.process?.env?.JSON_REASONING_EFFORT) || "minimal",
};

const OPENAI_MODEL   = (globalThis.process?.env?.OPENAI_MODEL)    || "gpt-5.4";
// Defaults target the Gemini 2.5 production GA models — available in every
// Vertex region including asia-south1. 3.x family is still preview-only and
// not deployed to all regions. Override via env vars if you want a specific
// version or to test the 3.x preview.
const GEMINI_FAST    = liveGeminiModel((globalThis.process?.env?.GEMINI_FAST_MODEL) || "gemini-3-flash-preview");
const GEMINI_PRO     = liveGeminiModel((globalThis.process?.env?.GEMINI_PRO_MODEL)  || "gemini-3.1-pro-preview");
// Dedicated model for the live coach chat.
//
// This used to default to 2.5 Flash Lite, chosen because it is the fastest
// Gemini (~400 tok/s) and does no internal thinking — the goal was a
// sub-second streaming feel. GEMINI_CHAT_MODEL is not set in the Vercel
// project, so that default was live: the coach's conversational path ran on
// the least capable model in the fleet while the tool path next door was
// already being served by Gemini 3 Flash.
//
// That is the wrong trade for this surface. The coach IS the product, its
// answers are read by 13-18 year olds who cannot evaluate them, and a
// non-thinking model is exactly the kind that states a confident wrong
// thing.
//
// So: Gemini 3 Flash, which DOES think — the real objection to Lite — and
// not 3.1 Pro. That is a measured call, not a guess. Streaming
// time-to-first-token against production, 2 runs each:
//
//   gemini-3.1-pro-preview   6.43s, 5.43s      <- 6 seconds of blank screen
//   gemini-3-flash-preview   1.94s, 2.81s
//
// Pro reasons before it emits anything, so streaming does not rescue the
// wait — a teenager on a phone sees nothing at all for six seconds and
// concludes it is broken. Flash 3 is a thinking model, is already proven in
// this exact stack on the tool path, and keeps the coach answering in about
// two seconds.
//
// If you want maximum reasoning and will accept that wait, it is one env
// var and no deploy: GEMINI_CHAT_MODEL=gemini-3.1-pro-preview. The chain
// below degrades to OpenAI, so an unavailable model costs a fallback hop
// rather than hanging the coach.
const GEMINI_CHAT    = liveGeminiModel((globalThis.process?.env?.GEMINI_CHAT_MODEL) || "gemini-3-flash-preview");
// Dedicated model for JSON-returning ops (command palette, market-search,
// report-card, crash-replay).
//
// Was 2.5 Flash-Lite, the only non-thinking Gemini in json_object mode: 2.5
// Flash spent ~1900 reasoning tokens and blew the callers' max_tokens, which
// broke crash replay. 2.5 retires on Vertex 20 Oct 2026. The cap that made
// thinking fatal is gone (max_tokens is always MAX_OUTPUT_TOKENS below), so
// the successor, 3.1 Flash-Lite, runs here with reasoning_effort "minimal"
// (REASONING_EFFORT.json) to keep the latency of the old lane.
const GEMINI_JSON    = liveGeminiModel((globalThis.process?.env?.GEMINI_JSON_MODEL) || "gemini-3.1-flash-lite");
const CEREBRAS_MODEL = (globalThis.process?.env?.CEREBRAS_MODEL)  || "llama3.3-70b";
const GROQ_MODEL     = (globalThis.process?.env?.GROQ_MODEL)      || "llama-3.3-70b-versatile";
const PUBLIC_ORIGIN  = ((globalThis.process?.env?.PUBLIC_ORIGIN) || "").replace(/\/$/, "");

// Gemini endpoint resolution. If GEMINI_VERTEX_PROJECT is set, route through
// Vertex AI (consumes Google Cloud credits). Otherwise, use the AI Studio
// OpenAI-compat endpoint (generativelanguage.googleapis.com). Default region
// is asia-south1 (Mumbai) so Indian users get the lowest latency and data
// stays in-region. Override region via GEMINI_VERTEX_REGION.
const GEMINI_VERTEX_PROJECT = globalThis.process?.env?.GEMINI_VERTEX_PROJECT || "";
const GEMINI_VERTEX_REGION  = globalThis.process?.env?.GEMINI_VERTEX_REGION  || "asia-south1";
// "global" location uses the non-prefixed subdomain. Regional locations
// use <region>-aiplatform.googleapis.com. Gemini 3.x preview models have
// "Global" availability — users who want them should set
// GEMINI_VERTEX_REGION=global to hit the right endpoint.
const GEMINI_SUBDOMAIN = GEMINI_VERTEX_REGION === "global" ? "" : `${GEMINI_VERTEX_REGION}-`;
const GEMINI_URL = GEMINI_VERTEX_PROJECT
  ? `https://${GEMINI_SUBDOMAIN}aiplatform.googleapis.com/v1/projects/${GEMINI_VERTEX_PROJECT}/locations/${GEMINI_VERTEX_REGION}/endpoints/openapi/chat/completions`
  : "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const ALLOWED_ORIGINS = new Set([
  PUBLIC_ORIGIN,
  "https://stocksaathi.co.in",
  "https://www.stocksaathi.co.in",
  "http://localhost:7348",
  "http://127.0.0.1:7348",
]);
ALLOWED_ORIGINS.delete("");

function allowOrigin(origin) {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (origin.startsWith("https://") && origin.endsWith(".vercel.app")) return origin;
  return null;
}

const REDACT_BEARER = /(Bearer\s+)[A-Za-z0-9._\-]+/gi;
const REDACT_KEY = /((?:sk-|sk-proj-|gsk_|xai-|re_|AIza)[A-Za-z0-9._\-]{8,})/g;
export const redact = (s) => String(s || "").replace(REDACT_BEARER, "$1<redacted>").replace(REDACT_KEY, "<redacted>");

function corsHeaders(origin) {
  const h = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  const a = allowOrigin(origin);
  if (a) {
    h.set("Access-Control-Allow-Origin", a);
    h.set("Vary", "Origin");
  }
  return h;
}

function jsonResponse(status, body, origin) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(origin) });
}

// ----- provider descriptors ------------------------------------------------
// Each descriptor can `enabled()` (env var present) and `call(body)` returning
// a Response-like { status, bodyText } pair. All upstreams are OpenAI-
// compatible except Gemini which has a native OpenAI-compat endpoint too.
export function providerDescriptors() {
  const env = globalThis.process?.env || {};
  return {
    // Leads every chain when configured. Speaks the Messages API, not
    // OpenAI's, so callUpstream routes it through the _messages.js adapter.
    // Off (enabled() false) until VERTEX_MESSAGES=1 or MESSAGES_API_KEY is
    // set, in which case every chain is exactly what it was before.
    messages: {
      label: "messages",
      kind: "messages",
      enabled: messagesEnabled,
      model: MESSAGES_MODEL(),
    },
    openai: {
      label: "openai",
      enabled: () => !!env.OPENAI_API_KEY,
      url: "https://api.openai.com/v1/chat/completions",
      key: env.OPENAI_API_KEY,
      model: OPENAI_MODEL,
    },
    gemini_chat: {
      label: "gemini_chat",
      enabled: () => !!env.GEMINI_API_KEY,
      url: GEMINI_URL,
      key: env.GEMINI_API_KEY,
      model: GEMINI_CHAT,
    },
    gemini_json: {
      label: "gemini_json",
      enabled: () => !!env.GEMINI_API_KEY,
      url: GEMINI_URL,
      key: env.GEMINI_API_KEY,
      model: GEMINI_JSON,
    },
    gemini_fast: {
      label: "gemini_fast",
      enabled: () => !!env.GEMINI_API_KEY,
      url: GEMINI_URL,
      key: env.GEMINI_API_KEY,
      model: GEMINI_FAST,
    },
    gemini_pro: {
      label: "gemini_pro",
      enabled: () => !!env.GEMINI_API_KEY,
      url: GEMINI_URL,
      key: env.GEMINI_API_KEY,
      model: GEMINI_PRO,
    },
    cerebras: {
      label: "cerebras",
      enabled: () => !!env.CEREBRAS_API_KEY,
      url: "https://api.cerebras.ai/v1/chat/completions",
      key: env.CEREBRAS_API_KEY,
      model: CEREBRAS_MODEL,
    },
    // Groq removed from the descriptor list by request — user explicitly
    // does not want Groq/Llama ever serving responses, even as a last-resort
    // fallback. If every Gemini/OpenAI/Cerebras upstream fails, the chat
    // returns a clean error rather than quietly downgrading to Llama.
  };
}

// Fallback chain per profile. Each order is tried top-down; the first
// descriptor whose env var is set gets the call. If it returns a 5xx or
// 429, we drop to the next. Any 2xx or 4xx (non-throttle) returns to
// the client as-is.
//
// Reasoning profile leads with Gemini Pro because it trades marginal IQ
// for meaningfully faster streaming throughput vs GPT Pro — on a
// user-facing chat, "smart in 1 s" beats "slightly smarter in 4 s".
// GPT sits behind it as the escalation for anything Pro can't handle.
export function chainFor(profile) {
  switch (profile) {
    // "messages" leads every lane (see providerDescriptors). The Gemini
    // entries behind it are now the outage fallback, not the primary.
    case "chat":
      // Live-typing coach chat. Leads with the smartest model (see
      // GEMINI_CHAT above) and degrades to Flash then OpenAI, so a slow or
      // unavailable Pro costs one fallback hop rather than hanging the
      // coach. gemini_pro is not repeated here — it is already the lead.
      return ["messages", "gemini_chat", "gemini_fast", "openai", "cerebras"];
    case "json":
      // JSON-returning ops (command palette, market-search, report-card,
      // crash-replay). The Gemini fallback leads with 2.5 Flash Lite
      // (non-thinking) — 3.x previews truncate structured JSON via reasoning
      // tokens. The Messages lead avoids that by sizing max_tokens itself.
      return ["messages", "gemini_json", "gemini_chat", "gemini_fast", "openai"];
    case "fast":
      return ["messages", "gemini_fast", "cerebras", "gemini_pro", "openai"];
    case "creative":
      return ["messages", "openai", "gemini_pro", "gemini_fast"];
    case "reasoning":
    default:
      return ["messages", "gemini_pro", "openai", "gemini_fast", "cerebras"];
  }
}

export async function callUpstream(desc, payload, ctx = {}) {
  if (desc.kind === "messages") return callMessagesUpstream(desc, payload, ctx);
  const providerName = desc.label.startsWith("gemini")
    ? `Google Gemini (${desc.model}) via Google Cloud Vertex AI`
    : `${desc.label} (${desc.model})`;
  const runtimeNote = `\n\n# MODEL RUNTIME\nProvider: ${providerName}.`;

  // `upstream_blocks` rides along on assistant turns the Messages upstream
  // produced (so its thinking blocks survive a tool loop). It is meaningless
  // to OpenAI-shaped upstreams and strict ones reject unknown fields.
  let payloadForAttempt = payload;
  if (Array.isArray(payload.messages)) {
    payloadForAttempt = {
      ...payload,
      messages: payload.messages.map(({ upstream_blocks, ...m }) => {
        if (m && (m.role === "system" || m.role === "developer")) {
          return { ...m, content: (typeof m.content === "string" ? m.content : "") + runtimeNote };
        }
        return m;
      }),
    };
  }
  // Vertex AI's OpenAI-compat endpoint uses x-goog-api-key for API-key auth,
  // NOT Authorization: Bearer (which is reserved for OAuth access tokens on
  // that endpoint). Every other upstream (OpenAI, Groq, Cerebras, AI Studio
  // via generativelanguage.googleapis.com) takes Bearer just fine.
  const isVertex = /aiplatform\.googleapis\.com/.test(desc.url);
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "StockSaathi-Edge/1.0",
  };
  if (isVertex) headers["x-goog-api-key"] = desc.key;
  else headers["Authorization"] = `Bearer ${desc.key}`;
  // Vertex OpenAI-compat requires the model in publisher/model form, e.g.
  // "google/gemini-2.5-flash". AI Studio takes the bare model name.
  const modelForApi = isVertex && !desc.model.includes("/")
    ? `google/${desc.model}`
    : desc.model;
  // PERF — capture TTFT (time-to-first-byte). The fetch promise resolves
  // when response HEADERS arrive, not when the body finishes. So
  // tHeaders - t0 ≈ TTFT for the upstream LLM. Surfaced to the client as
  // a Server-Timing header in the success branch below. See PERF_AUDIT §1.
  const t0 = performance.now();
  // PER-ATTEMPT TIMEOUT. Without one, a single slow upstream consumes the
  // whole edge-function budget and the fallback chain never gets a turn —
  // the caller just receives a 504 FUNCTION_INVOCATION_TIMEOUT at ~25s with
  // no reply at all. Observed in production on 2026-09-13: one ordinary
  // coach question ("whys monday holiday") hung gemini_chat past the limit
  // while three perfectly healthy fallbacks sat unused behind it.
  //
  // The budget below leaves room for at least two attempts inside the edge
  // limit, so a stalled provider costs a few seconds rather than the turn.
  // It only bounds time-to-HEADERS; once a stream starts, the body is piped
  // without further limit.
  const ctrl = new AbortController();
  // Distinguishing "we gave up on this upstream" from "the network broke" is
  // the whole point of the flag. Without it every stall is recorded as a
  // generic failure, which is exactly how a 9s timeout on the tool lane went
  // unnoticed: measured 2026-09-14, ~1 request in 5 on `fast` hung past the
  // budget and fell through to a slower model, and nothing anywhere said so.
  let timedOut = false;
  const killer = setTimeout(() => { timedOut = true; ctrl.abort(); }, UPSTREAM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(desc.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...payloadForAttempt, model: modelForApi }),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (timedOut) {
      const err = new Error("upstream_timeout");
      err.__timeout = true;
      err.__ms = UPSTREAM_TIMEOUT_MS;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(killer);
  }
  const ttftMs = Math.round(performance.now() - t0);
  // Return the Response object unread so the handler can either pipe the
  // body through (streaming) or read it as text (non-streaming). For
  // fallover decisions we only need the status + a peek at error bodies
  // which we read lazily below.
  return { status: res.status, res, upstream: desc.label, t0, ttftMs };
}

// Same contract as callUpstream (unread Response + timings, timeout thrown
// as __timeout), via the Messages adapter. `ctx.callerEffort` is the
// reasoning_effort the CALLER sent, before the handler filled in the Gemini
// lane default — that default is tuned for Gemini's scale, not this model's.
async function callMessagesUpstream(desc, payload, ctx) {
  const isVertex = globalThis.process?.env?.VERTEX_MESSAGES === "1";
  const providerDesc = isVertex
    ? `Anthropic (${desc.model}) via Google Cloud Vertex AI`
    : `Anthropic (${desc.model}) via Anthropic API`;
  const runtimeNote = `\n\n# MODEL RUNTIME\nProvider: ${providerDesc}. Automated fallback: Google Gemini.`;

  let payloadForAttempt = payload;
  if (Array.isArray(payload.messages)) {
    payloadForAttempt = {
      ...payload,
      messages: payload.messages.map((m) => {
        if (m && (m.role === "system" || m.role === "developer")) {
          return { ...m, content: (typeof m.content === "string" ? m.content : "") + runtimeNote };
        }
        return m;
      }),
    };
  }

  const body = toMessagesBody(
    { ...payloadForAttempt, reasoning_effort: ctx.callerEffort },
    { profile: ctx.profile, stream: !!ctx.stream },
  );
  const t0 = performance.now();
  const ctrl = new AbortController();
  let timedOut = false;
  const killer = setTimeout(() => { timedOut = true; ctrl.abort(); }, MESSAGES_TIMEOUT_MS);
  let res;
  try {
    res = await messagesFetch(body, { signal: ctrl.signal });
  } catch (e) {
    if (timedOut) {
      const err = new Error("upstream_timeout");
      err.__timeout = true;
      err.__ms = MESSAGES_TIMEOUT_MS;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(killer);
  }
  return { status: res.status, res, upstream: desc.label, t0, ttftMs: Math.round(performance.now() - t0) };
}

export default async function handler(req) {
  const origin = req.headers.get("Origin") || "";

  if (req.method === "OPTIONS") {
    const h = corsHeaders(origin);
    h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type, X-Saathi-Feature");
    h.set("Access-Control-Max-Age", "600");
    return new Response(null, { status: 204, headers: h });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" }, origin);
  }

  // Browsers always send Origin on a POST, so a missing one means a script.
  // Local tools (scripts/pregen-crashes.mjs) send the site's own origin.
  if (!allowOrigin(origin)) {
    return jsonResponse(403, { error: "forbidden_origin" }, origin);
  }
  const ip = (req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "?").split(",")[0].trim();
  if (rateLimited(ip)) {
    return jsonResponse(429, { error: "rate_limited" }, origin);
  }
  // Abuse blocklist (filled by the database watcher ops_ai_watch). Fails open.
  const caller = await callerHashes(req);
  if (await isBlocked(caller)) {
    return jsonResponse(429, { error: "rate_limited" }, origin);
  }
  // AI lockdown during a detected attack (see _guard.js). Short, then lapses.
  // A caller that passed the Turnstile check (human pass cookie) is let through.
  if (await inLockdown() && !(await hasHumanPass(req, caller))) {
    return jsonResponse(503, { error: "busy", challenge: true, message: "Saathi is very busy right now. Please try again in a few minutes." }, origin);
  }

  // Body-size cap. Read the upload before refusing it: answering while a
  // large body is still unread crashes the Node function (500
  // FUNCTION_INVOCATION_FAILED) and takes the next request down with it.
  // Vercel itself caps a request body at 4.5 MB, so reading is bounded.
  const cl = parseInt(req.headers.get("Content-Length") || "0", 10);
  if (cl > MAX_BODY) {
    try { await req.arrayBuffer(); } catch {}
    return jsonResponse(413, { error: "payload_too_large" }, origin);
  }

  let raw;
  try {
    raw = await req.text();
  } catch {
    return jsonResponse(400, { error: "read_failed" }, origin);
  }
  if (raw.length > MAX_BODY) {
    return jsonResponse(413, { error: "payload_too_large" }, origin);
  }

  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    return jsonResponse(400, { error: "bad_body" }, origin);
  }

  // Pull + strip the profile hint; upstream providers don't understand it.
  const profile = typeof payload.profile === "string" ? payload.profile : "reasoning";
  delete payload.profile;
  // Opt-in from the coach agent: stream even though tools are attached, so a
  // data answer types out instead of landing as one block. The client
  // reassembles tool_calls from the stream itself.
  const streamTools = payload.stream_tools === true;
  delete payload.stream_tools;
  const feature = featureOf(req);

  // Output budget. Tools are passed through — the coach agent needs
  // function-calling to fetch live quotes, portfolio values and news during
  // a conversation. Body size is already capped so runaway tool-schema
  // bloat can't balloon the payload.
  //
  // The `: 800` default here is why coach replies kept stopping mid-word
  // even after the client stopped sending max_tokens: omitting it did not
  // mean "no cap", it meant 800, and on a thinking model most of that goes
  // to reasoning before a single visible word is produced. An absent
  // max_tokens now means the real ceiling.
  //
  // And now the caller's value is ignored entirely: no Saathi reply may be
  // cut short by a token cap, by decision. Every upstream gets its full
  // output room (the Messages adapter applies its own, larger ceiling).
  payload.max_tokens = MAX_OUTPUT_TOKENS;

  // Thinking budget — by far the biggest lever on time-to-first-token.
  //
  // Measured against production with the coach's real 5,046-token system
  // prompt, streaming, "hello how is u":
  //
  //   default (full thinking)     3.85s, 6.48s
  //   reasoning_effort: "low"     1.22s, 1.32s
  //   reasoning_effort: "none"    0.15s, 0.33s
  //
  // For comparison, shrinking that 5,046-token prompt to 21 tokens only
  // bought ~1s. The prompt was never the problem; the reasoning phase was.
  // A thinking model emits NOTHING until it has finished thinking, so
  // streaming cannot hide it — the user just watches an empty bubble.
  //
  // So: conversational lanes get a small budget, lanes that exist to reason
  // keep theirs. A caller that sets reasoning_effort explicitly always wins.
  //
  // These measurements and defaults are Gemini's. The Messages upstream
  // gets the caller's own value (or none) and applies its own lane default.
  const callerEffort = payload.reasoning_effort;
  if (payload.reasoning_effort === undefined) {
    const effort = REASONING_EFFORT[profile];
    if (effort) payload.reasoning_effort = effort;
  }
  // OUTBOUND SECRET SCRUB.
  //
  // COACH_FIXES §39: a pasted ADMIN_PATH value sat in a user's chat log and
  // reached an LLM provider when the message was answered. It was redacted
  // from our storage afterwards, but the copy that left the building could
  // not be recalled — the entry still says "the value still needs rotating".
  //
  // That was a one-off. The dossier makes the class of accident structural:
  // user content is now attached to every single turn automatically, so
  // anything secret-shaped that lands in a user's data would ride along
  // forever without anyone pasting it again.
  //
  // redact() is the SAME function already used on error bodies (see its
  // definition above): it matches API-key prefixes and bearer tokens only. It
  // cannot match a stock symbol, a rupee figure, a name, or a sentence, so it
  // cannot degrade a coach reply. That is the whole reason it is safe to run
  // on the happy path and not just on errors.
  if (Array.isArray(payload.messages)) {
    for (const m of payload.messages) {
      if (typeof m?.content === "string") m.content = redact(m.content);
    }
  }

  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return jsonResponse(400, { error: "bad_messages" }, origin);
  }

  const descs = providerDescriptors();
  const order = chainFor(profile).map((label) => descs[label]).filter((d) => d && d.enabled());

  if (order.length === 0) {
    return jsonResponse(501, { error: "no_provider_configured" }, origin);
  }

  // Streaming toggle. When true we pipe the upstream ReadableStream straight
  // through as SSE, so the client sees the first token in ~300ms instead of
  // waiting for the full reply. Tool-use path is incompatible with streaming
  // (tool_calls arrive in chunks that are painful to reassemble client-side),
  // so we silently disable streaming if the caller included tools.
  const wantsStream = payload.stream === true && (!Array.isArray(payload.tools) || streamTools);

  let last = null;
  let lastText = null;
  // OBSERVABILITY — the attempt trail.
  //
  // Before this existed a degraded chain was completely invisible: the client
  // saw only X-Chat-Upstream naming whoever finally answered, with no record
  // that two upstreams ahead of it had stalled for 9s each. Measured on
  // 2026-09-14, ~10% of requests fell through and cost 11-18s, and no log
  // anywhere showed it. Every attempt is now recorded with its outcome and
  // duration, returned as a header and written to the Vercel log.
  const attempts = [];
  const tReq = performance.now();
  const trail = () => attempts.join(",") || "none";
  // Usage ledger (api/_usage.js): one row per attempt, tokens on success.
  const toolCount = Array.isArray(payload.tools) ? payload.tools.length : 0;
  const effortSent = (desc) => desc.kind === "messages"
    ? effortFor(profile, callerEffort)
    : (payload.reasoning_effort || null);
  const usageRow = (desc, extra) => ({
    route: "chat", op: profile, feature, profile, upstream: desc.label, model: desc.model,
    effort: effortSent(desc), tools: toolCount, attempt: attempts.length,
    ip_hash: caller.ip_hash, dev_hash: caller.dev_hash, ...extra,
  });
  for (const desc of order) {
    try {
      const isMessages = desc.kind === "messages";
      const streamThis = wantsStream;
      const r = await callUpstream(desc, payload, { profile, stream: streamThis, callerEffort });
      // The Messages upstream answers in its own shape. Translate it here so
      // everything below this point (headers, timing, passthrough) is shared.
      //   - refusal on a non-streaming call: a decline from this model's
      //     safety layer is HTTP 200, but another upstream may well answer,
      //     so it falls over like a 5xx instead of returning an empty bubble.
      //   - 400: treated as fallover too. With a translation layer in the
      //     path, a 400 is far more likely our mapping than a body every
      //     upstream would reject, and the Gemini entries take the original
      //     OpenAI shape natively. The body is logged below either way.
      let translatedText = null;
      if (isMessages && r.status >= 200 && r.status < 300 && !streamThis) {
        const raw = await r.res.text();
        let msg = null;
        try { msg = JSON.parse(raw); } catch {}
        if (!msg || msg.stop_reason === "refusal") {
          attempts.push(`${desc.label}:${msg ? "refusal" : "bad_json"}:${r.ttftMs}ms`);
          console.log(JSON.stringify({
            evt: "chat_upstream", profile, ok: false, upstream: desc.label,
            status: msg ? "refusal" : "bad_json",
            category: msg?.stop_details?.category || null,
            attempts: trail(),
          }));
          await recordUsage(usageRow(desc, {
            ok: false, status: msg ? "refusal" : "bad_json", stream: false, ttft_ms: r.ttftMs,
            total_ms: Math.round(performance.now() - r.t0), stop_reason: msg?.stop_reason, ...normUsage(msg?.usage),
          }));
          last = { status: 502, text: JSON.stringify({ error: "upstream_declined" }), upstream: desc.label };
          lastText = last.text;
          continue;
        }
        translatedText = JSON.stringify(toChatCompletion(msg));
        r.rawUsage = msg.usage;
        r.stop = msg.stop_reason;
      }
      // Pass any 2xx through immediately. Streaming responses get their body
      // piped; non-streaming ones get their body read + forwarded as JSON.
      if (r.status >= 200 && r.status < 300) {
        attempts.push(`${desc.label}:ok:${r.ttftMs}ms`);
        // Server-side timing log. The Server-Timing header below is sent to the
        // browser and then discarded, which is why no latency distribution for
        // this endpoint has ever existed — Vercel's runtime logs carry status
        // but no duration. One line here makes p50/p90 answerable from logs.
        console.log(JSON.stringify({
          evt: "chat_upstream", profile, ok: true, upstream: desc.label, model: desc.model,
          ttft_ms: r.ttftMs, stream: streamThis,
          tools: Array.isArray(payload.tools) ? payload.tools.length : 0,
          attempts: trail(),
        }));
        const outHeaders = new Headers({
          ...Object.fromEntries(corsHeaders(origin)),
          "X-Chat-Upstream": desc.label,
          "X-Chat-Model": desc.model,
          "X-Chat-Attempts": trail(),
        });
        // Same-origin clients can read Server-Timing without exposure
        // headers, but Vercel preview deployments and any future split-
        // origin setup need this — make it explicit so devtools always
        // sees the LLM timings.
        outHeaders.set("Access-Control-Expose-Headers", "Server-Timing, X-Chat-Upstream, X-Chat-Model, X-Chat-Attempts, X-Chat-Finish-Reason");
        if (streamThis) {
          // Streaming path — TTFT is the only number we know yet; total
          // generation time isn't available until the stream ends, which
          // is past our return point. Emit ttft only.
          outHeaders.set("Content-Type", "text/event-stream");
          outHeaders.set("Cache-Control", "no-store");
          outHeaders.set("X-Accel-Buffering", "no");  // disable proxy buffering
          outHeaders.set("Server-Timing", `ttft;dur=${r.ttftMs};desc="${desc.label}"`);
          const tStream = r.t0;
          const done = ({ usage, stop, finish, ok = true }) => recordUsage(usageRow(desc, {
            ok, status: ok ? "ok" : "stream_error", stream: true, ttft_ms: r.ttftMs,
            total_ms: Math.round(performance.now() - tStream), stop_reason: stop || finish, ...normUsage(usage),
          }));
          const streamBody = isMessages ? toChatSse(r.res.body, "", done) : tapOpenAiSse(r.res.body, done);
          return new Response(streamBody, { status: r.status, headers: outHeaders });
        }
        outHeaders.set("Content-Type", "application/json");
        const text = translatedText ?? await r.res.text();
        const llmMs = Math.round(performance.now() - r.t0);
        // Best-effort: extract completion_tokens from upstream usage so the
        // client can correlate generation time with output size.
        let tokOut = null;
        try {
          const parsed = JSON.parse(text);
          const u = parsed?.usage?.completion_tokens;
          if (Number.isFinite(u)) tokOut = u;
          const fin = parsed?.choices?.[0]?.finish_reason;
          if (fin) outHeaders.set("X-Chat-Finish-Reason", String(fin));
        } catch {}
        const stParts = [
          `ttft;dur=${r.ttftMs};desc="${desc.label}"`,
          `llm;dur=${llmMs};desc="${desc.label}"`,
        ];
        if (tokOut != null) stParts.push(`tokens-out;dur=0;desc="${tokOut}"`);
        let rawUsage = r.rawUsage;
        let stop = r.stop;
        if (!rawUsage) {
          try { const p = JSON.parse(text); rawUsage = p?.usage; stop = p?.choices?.[0]?.finish_reason; } catch {}
        }
        await recordUsage(usageRow(desc, {
          ok: true, status: "ok", stream: false, ttft_ms: r.ttftMs, total_ms: llmMs,
          stop_reason: stop, ...normUsage(rawUsage),
        }));
        outHeaders.set("Server-Timing", stParts.join(", "));
        return new Response(text, { status: r.status, headers: outHeaders });
      }
      // Non-2xx: read the error body (text) so we can return it or log it.
      const errText = await r.res.text().catch(() => "");
      last = { status: r.status, text: errText, upstream: desc.label };
      lastText = errText;
      attempts.push(`${desc.label}:${r.status}:${r.ttftMs}ms`);
      // LOG THE UPSTREAM ERROR BODY. It was previously read and thrown away on
      // every fallthrough, so the ~4% of Vertex calls returning HTTP 409 have
      // never been explained — GCP Data Access audit logs are off by default
      // (Logs Explorer returns 0 results over 7 days) and Vercel records the
      // status without the body. redact() strips key-shaped strings first.
      console.log(JSON.stringify({
        evt: "chat_upstream", profile, ok: false, upstream: desc.label,
        status: r.status, ttft_ms: r.ttftMs,
        body: redact(errText).slice(0, 400),
        attempts: trail(),
      }));
      // Fall over on any infrastructure/config failure at the upstream:
      //   - 5xx server-down
      //   - 429 rate limited
      //   - 401/403 auth or permission rejected (bad key, API not enabled)
      //   - 404 model not found (e.g. 3.x preview not in this region)
      //   - 408/409 timeout/conflict
      // These all indicate "THIS upstream can't serve the request right now"
      // but a different upstream might. The NEXT one in the chain gets a shot.
      // Only pure client-shape errors (400 bad body, 413 too large, 415 unsupported
      // content type) get returned directly — those would fail identically on
      // every upstream.
      await recordUsage(usageRow(desc, { ok: false, status: `http_${r.status}`, stream: streamThis, ttft_ms: r.ttftMs }));
      const isFallover = r.status === 429
                      || r.status >= 500
                      || (isMessages && r.status === 400)
                      || r.status === 401
                      || r.status === 403
                      || r.status === 404
                      || r.status === 408
                      || r.status === 409;
      if (isFallover) continue;
      const directHeaders = corsHeaders(origin);
      directHeaders.set("X-Chat-Upstream", desc.label);
      directHeaders.set("X-Chat-Attempts", trail());
      directHeaders.set("Access-Control-Expose-Headers", "Server-Timing, X-Chat-Upstream, X-Chat-Attempts");
      return new Response(errText, {
        status: r.status,
        headers: directHeaders,
      });
    } catch (e) {
      // A timeout is recorded distinctly from an unreachable host. These look
      // identical from the outside but mean opposite things: the first says
      // the upstream is slow (raise the budget or hedge), the second says it
      // is down (fix the chain).
      const timedOut = !!e?.__timeout;
      attempts.push(`${desc.label}:${timedOut ? `timeout:${e.__ms}ms` : "unreachable"}`);
      console.log(JSON.stringify({
        evt: "chat_upstream", profile, ok: false, upstream: desc.label,
        status: timedOut ? "timeout" : "unreachable",
        detail: redact(e?.message).slice(0, 140),
        attempts: trail(),
      }));
      await recordUsage(usageRow(desc, { ok: false, status: timedOut ? "timeout" : "unreachable", stream: wantsStream, total_ms: timedOut ? e.__ms : null }));
      last = { status: 502, text: JSON.stringify({ error: timedOut ? "upstream_timeout" : "upstream_unreachable", detail: redact(e?.message).slice(0, 140) }), upstream: desc.label };
      lastText = last.text;
    }
  }

  // Exhausted the chain — every upstream was throttled or unreachable.
  console.log(JSON.stringify({
    evt: "chat_exhausted", profile, attempts: trail(),
    total_ms: Math.round(performance.now() - tReq),
  }));
  const headers = corsHeaders(origin);
  headers.set("X-Chat-Upstream", last?.upstream || "none");
  headers.set("X-Chat-Attempts", trail());
  headers.set("Access-Control-Expose-Headers", "Server-Timing, X-Chat-Upstream, X-Chat-Attempts");
  return new Response(lastText || JSON.stringify({ error: "all_upstreams_unavailable" }), {
    status: last?.status || 503,
    headers,
  });
}
