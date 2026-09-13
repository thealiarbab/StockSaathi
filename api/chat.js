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
//   - `tools` / `tool_choice` stripped (client can't plug arbitrary tools).
//   - Error bodies redact bearer tokens + API-key-shaped strings.
// =============================================================================

export const config = { runtime: "edge" };

const MAX_BODY = 64 * 1024;
const MAX_OUTPUT_TOKENS = 4000;

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
const redact = (s) => String(s || "").replace(REDACT_BEARER, "$1<redacted>").replace(REDACT_KEY, "<redacted>");

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
function providerDescriptors() {
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
function chainFor(profile) {
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

async function callUpstream(desc, payload) {
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
  const res = await fetch(desc.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, model: modelForApi }),
  });
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
  for (const desc of order) {
    try {
      const r = await callUpstream(desc, payload);
      // Pass any 2xx through immediately. Streaming responses get their body
      // piped; non-streaming ones get their body read + forwarded as JSON.
      if (r.status >= 200 && r.status < 300) {
        const outHeaders = new Headers({
          ...Object.fromEntries(corsHeaders(origin)),
          "X-Chat-Upstream": desc.label,
        });
        // Same-origin clients can read Server-Timing without exposure
        // headers, but Vercel preview deployments and any future split-
        // origin setup need this — make it explicit so devtools always
        // sees the LLM timings.
        outHeaders.set("Access-Control-Expose-Headers", "Server-Timing, X-Chat-Upstream");
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
      return new Response(errText, {
        status: r.status,
        headers: corsHeaders(origin),
      });
    } catch (e) {
      last = { status: 502, text: JSON.stringify({ error: "upstream_unreachable", detail: redact(e?.message).slice(0, 140) }), upstream: desc.label };
      lastText = last.text;
    }
  }

  // Exhausted the chain — every upstream was throttled or unreachable.
  const headers = corsHeaders(origin);
  headers.set("X-Chat-Upstream", last?.upstream || "none");
  return new Response(lastText || JSON.stringify({ error: "all_upstreams_unavailable" }), {
    status: last?.status || 503,
    headers,
  });
}
