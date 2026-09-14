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

export const config = { runtime: "edge" };

const MAX_BODY = 64 * 1024;
export const MAX_OUTPUT_TOKENS = 4000;

// How long any ONE upstream gets to return response headers before we give
// up and try the next in the chain.
//
// Vercel edge functions are killed at ~25s. With no per-attempt bound, the
// first slow provider eats that entire budget and the caller gets a 504 with
// nothing at all — which is strictly worse than a fallback answer. 9s leaves
// room for two full attempts plus overhead inside the limit.
export const UPSTREAM_TIMEOUT_MS = Number(globalThis.process?.env?.UPSTREAM_TIMEOUT_MS) || 9000;

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
//   json      already on a non-thinking model; nothing to trim.
//   reasoning / creative  deliberately left alone. These lanes exist to
//             think, are not on the interactive path, and nobody is watching
//             a cursor blink while they run.
const REASONING_EFFORT = {
  chat: (globalThis.process?.env?.CHAT_REASONING_EFFORT) || "minimal",
  fast: (globalThis.process?.env?.FAST_REASONING_EFFORT) || "low",
};

const OPENAI_MODEL   = (globalThis.process?.env?.OPENAI_MODEL)    || "gpt-5.4";
// Defaults target the Gemini 2.5 production GA models — available in every
// Vertex region including asia-south1. 3.x family is still preview-only and
// not deployed to all regions. Override via env vars if you want a specific
// version or to test the 3.x preview.
const GEMINI_FAST    = (globalThis.process?.env?.GEMINI_FAST_MODEL) || "gemini-3-flash-preview";
const GEMINI_PRO     = (globalThis.process?.env?.GEMINI_PRO_MODEL)  || "gemini-3.1-pro-preview";
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
const GEMINI_CHAT    = (globalThis.process?.env?.GEMINI_CHAT_MODEL) || "gemini-3-flash-preview";
// Dedicated model for JSON-returning ops (command palette, market-search,
// report-card, crash-replay).
//
// DELIBERATELY STAYS ON FLASH LITE — this is the one lane where "smarter"
// is actively worse, and it is not an oversight. 2.5 Flash Lite is the only
// Gemini that is truly non-thinking in response_format:json_object mode.
// 2.5 Flash spends ~1900 reasoning tokens on a strict-JSON request and blows
// the caller's max_tokens with the JSON itself only ~70 tokens long, which
// broke crash replay outright. Lite returns the full crash-replay schema in
// ~3s with no reasoning overhead.
//
// These callers set their own max_tokens (unlike the coach, which no longer
// sends one), so the failure mode is live for them. Do not "upgrade" this
// to a thinking model without first removing those caps and re-testing
// crash replay, the command palette and the report card end to end.
const GEMINI_JSON    = (globalThis.process?.env?.GEMINI_JSON_MODEL) || "gemini-2.5-flash-lite";
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
    case "chat":
      // Live-typing coach chat. Leads with the smartest model (see
      // GEMINI_CHAT above) and degrades to Flash then OpenAI, so a slow or
      // unavailable Pro costs one fallback hop rather than hanging the
      // coach. gemini_pro is not repeated here — it is already the lead.
      return ["gemini_chat", "gemini_fast", "openai", "cerebras"];
    case "json":
      // JSON-returning ops (command palette, market-search, report-card,
      // crash-replay). Leads with 2.5 Flash (non-thinking, GA everywhere),
      // falling back to Chat / Fast / OpenAI. Explicitly NO thinking models
      // first — 3.x previews truncate structured JSON via reasoning tokens.
      return ["gemini_json", "gemini_chat", "gemini_fast", "openai"];
    case "fast":
      return ["gemini_fast", "cerebras", "gemini_pro", "openai"];
    case "creative":
      return ["openai", "gemini_pro", "gemini_fast"];
    case "reasoning":
    default:
      return ["gemini_pro", "openai", "gemini_fast", "cerebras"];
  }
}

export async function callUpstream(desc, payload) {
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
      body: JSON.stringify({ ...payload, model: modelForApi }),
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

export default async function handler(req) {
  const origin = req.headers.get("Origin") || "";

  if (req.method === "OPTIONS") {
    const h = corsHeaders(origin);
    h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type");
    h.set("Access-Control-Max-Age", "600");
    return new Response(null, { status: 204, headers: h });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" }, origin);
  }

  if (origin && !allowOrigin(origin)) {
    return jsonResponse(403, { error: "forbidden_origin" }, origin);
  }

  // Body-size cap
  const cl = parseInt(req.headers.get("Content-Length") || "0", 10);
  if (cl > MAX_BODY) {
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
  const mt = Number.isFinite(payload.max_tokens)
    ? Math.min(payload.max_tokens, MAX_OUTPUT_TOKENS)
    : MAX_OUTPUT_TOKENS;
  payload.max_tokens = mt;

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
  const wantsStream = payload.stream === true && !Array.isArray(payload.tools);

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
  for (const desc of order) {
    try {
      const r = await callUpstream(desc, payload);
      // Pass any 2xx through immediately. Streaming responses get their body
      // piped; non-streaming ones get their body read + forwarded as JSON.
      if (r.status >= 200 && r.status < 300) {
        attempts.push(`${desc.label}:ok:${r.ttftMs}ms`);
        // Server-side timing log. The Server-Timing header below is sent to the
        // browser and then discarded, which is why no latency distribution for
        // this endpoint has ever existed — Vercel's runtime logs carry status
        // but no duration. One line here makes p50/p90 answerable from logs.
        console.log(JSON.stringify({
          evt: "chat_upstream", profile, ok: true, upstream: desc.label,
          ttft_ms: r.ttftMs, stream: wantsStream,
          tools: Array.isArray(payload.tools) ? payload.tools.length : 0,
          attempts: trail(),
        }));
        const outHeaders = new Headers({
          ...Object.fromEntries(corsHeaders(origin)),
          "X-Chat-Upstream": desc.label,
          "X-Chat-Attempts": trail(),
        });
        // Same-origin clients can read Server-Timing without exposure
        // headers, but Vercel preview deployments and any future split-
        // origin setup need this — make it explicit so devtools always
        // sees the LLM timings.
        outHeaders.set("Access-Control-Expose-Headers", "Server-Timing, X-Chat-Upstream, X-Chat-Attempts");
        if (wantsStream) {
          // Streaming path — TTFT is the only number we know yet; total
          // generation time isn't available until the stream ends, which
          // is past our return point. Emit ttft only.
          outHeaders.set("Content-Type", "text/event-stream");
          outHeaders.set("Cache-Control", "no-store");
          outHeaders.set("X-Accel-Buffering", "no");  // disable proxy buffering
          outHeaders.set("Server-Timing", `ttft;dur=${r.ttftMs};desc="${desc.label}"`);
          return new Response(r.res.body, { status: r.status, headers: outHeaders });
        }
        outHeaders.set("Content-Type", "application/json");
        const text = await r.res.text();
        const llmMs = Math.round(performance.now() - r.t0);
        // Best-effort: extract completion_tokens from upstream usage so the
        // client can correlate generation time with output size.
        let tokOut = null;
        try {
          const parsed = JSON.parse(text);
          const u = parsed?.usage?.completion_tokens;
          if (Number.isFinite(u)) tokOut = u;
        } catch {}
        const stParts = [
          `ttft;dur=${r.ttftMs};desc="${desc.label}"`,
          `llm;dur=${llmMs};desc="${desc.label}"`,
        ];
        if (tokOut != null) stParts.push(`tokens-out;dur=0;desc="${tokOut}"`);
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
      const isFallover = r.status === 429
                      || r.status >= 500
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
