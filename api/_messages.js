// =============================================================================
// Messages-API upstream, behind the OpenAI chat-completions shape.
//
// Every caller in this app (coach agent, coach stream, crash replay, the
// /api/ai ops) speaks OpenAI chat-completions. This upstream speaks the
// Messages API instead, so this module translates in both directions and the
// callers never know which upstream answered:
//
//   toMessagesBody()     OpenAI request  -> Messages request
//   toChatCompletion()   Messages reply  -> OpenAI reply (non-streaming)
//   toChatSse()          Messages SSE    -> OpenAI SSE   (streaming)
//
// The leading underscore is deliberate: Vercel does not deploy `api/_*.js` as
// its own function, which keeps the Hobby-plan function count where it is.
//
// TWO WAYS IN, same model, same body:
//
//   VERTEX_MESSAGES=1      THE PRODUCTION ROUTE. Through the existing Vertex
//                          project (GEMINI_VERTEX_PROJECT), billed on the same
//                          GCP account as Gemini. Auth: VERTEX_SA_KEY
//                          (service-account JSON, raw or base64) if set, else
//                          the existing GEMINI_API_KEY as x-goog-api-key.
//   MESSAGES_API_KEY       alternative: the vendor's own endpoint, one header.
//                          Only used when Vertex is not switched on.
//
//   MESSAGES_MODEL         default "claude-haiku-5-5"
//   VERTEX_MESSAGES_REGION default "global" (the cheaper endpoint)
//
// Neither set -> enabled() is false and every chain behaves exactly as before.
//
// WHY NOT THE VENDOR SDK: the Vertex flavour of it authenticates through
// google-auth-library, which needs Node built-ins the Edge runtime does not
// have, and this deployment has no npm install step at all (vercel.json
// installCommand is a no-op). Plain fetch keeps both endpoints on one code
// path that runs on Edge, in the Cloudflare Worker, and in `node --check`.
// =============================================================================

const env = () => globalThis.process?.env || {};

export const MESSAGES_MODEL = () => env().MESSAGES_MODEL || "claude-haiku-5-5";

// -----------------------------------------------------------------------------
// Effort per lane.
//
// This model's thinking is adaptive and ON by default; effort is the one dial
// for how much it thinks (low | medium | high | xhigh | max, default medium).
// Thinking tokens come out of max_tokens, which is why maxTokensFor() below
// ignores the small caps callers tuned for Flash Lite.
//
//   chat       streaming coach bubble, no tools. medium: the coach prompt is
//              ~5k tokens of rules for 13-18 year olds, and "low" is where
//              this model starts cutting corners on long rule sets. Adaptive
//              thinking still skips the think step on "hi".
//   fast       coach WITH tools (quotes, portfolio, news). medium: at "low"
//              the model is measurably more likely to skip a tool call and
//              answer from memory - the exact failure that serves a teen a
//              stale price.
//   json       structured one-shots. Per-op overrides in api/ai.js; this is
//              the default for crash replay's two /api/chat calls, which pick
//              dates and write a multi-part narrative: medium.
//   reasoning  crash-replay escalation after two failed json attempts: high.
//   creative   medium.
//
// Every lane is env-overridable without a deploy: MESSAGES_EFFORT_<LANE>.
// -----------------------------------------------------------------------------
const DEFAULT_EFFORT = {
  chat: "medium",
  fast: "medium",
  json: "medium",
  reasoning: "high",
  creative: "medium",
};
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function effortFor(profile, requested) {
  // An explicit effort from a caller wins. The OpenAI-shaped callers send
  // reasoning_effort tuned for the previous upstream, whose scale had a
  // "minimal" this one does not.
  if (requested === "minimal" || requested === "none") return "low";
  if (EFFORTS.has(requested)) return requested;
  const fromEnv = env()[`MESSAGES_EFFORT_${String(profile || "").toUpperCase()}`];
  if (EFFORTS.has(fromEnv)) return fromEnv;
  return DEFAULT_EFFORT[profile] || "medium";
}

// NO OUTPUT CAP, by decision: every request gets the full output room and
// whatever the caller asked for is ignored. Thinking is billed out of
// max_tokens, and callers here pass caps sized for a NON-thinking model (180
// for a news TL;DR, 200 for a tooltip) - reuse those and a single think step
// can leave zero tokens for the answer, the same "Beta measures how much a"
// truncation api/ai.js documents for 2.5 Flash. Length is controlled by each
// prompt, never by a cap. 128k is this model's documented ceiling.
const OUTPUT_TOKENS = 128000;
export function maxTokensFor() {
  return OUTPUT_TOKENS;
}

// -----------------------------------------------------------------------------
// Endpoint + auth
// -----------------------------------------------------------------------------
function vertexProject() { return env().GEMINI_VERTEX_PROJECT || ""; }

function vertexOn() {
  const e = env();
  return e.VERTEX_MESSAGES === "1" && !!vertexProject() && !!(e.VERTEX_SA_KEY || e.GEMINI_API_KEY);
}

export function messagesEnabled() {
  return vertexOn() || !!env().MESSAGES_API_KEY;
}

function endpoint(stream) {
  const e = env();
  if (!vertexOn()) {
    return { kind: "direct", url: "https://api.anthropic.com/v1/messages" };
  }
  const region = e.VERTEX_MESSAGES_REGION || "global";
  const host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
  const verb = stream ? "streamRawPredict" : "rawPredict";
  return {
    kind: "vertex",
    url: `https://${host}/v1/projects/${vertexProject()}/locations/${region}/publishers/anthropic/models/${MESSAGES_MODEL()}:${verb}`,
  };
}

// --- Google OAuth from a service-account key, on Edge -----------------------
// Vertex's partner models are documented with OAuth bearer tokens. On Edge
// there is no gcloud and no google-auth-library, so mint the token the way
// the library does: sign a JWT with the account's RSA key (WebCrypto), swap
// it at the token endpoint, cache it until five minutes before expiry.
let _gToken = null; // { token, exp }

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(obj) { return b64url(new TextEncoder().encode(JSON.stringify(obj))); }

function parseServiceAccount(raw) {
  const s = String(raw || "").trim();
  try { return JSON.parse(s); } catch {}
  try { return JSON.parse(atob(s)); } catch {}
  throw new Error("vertex_sa_key_unparseable");
}

async function googleAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_gToken && _gToken.exp - 300 > now) return _gToken.token;
  const sa = parseServiceAccount(env().VERTEX_SA_KEY);
  const pem = String(sa.private_key || "").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const unsigned = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${unsigned}.${b64url(sig)}`,
  });
  if (!res.ok) throw new Error(`vertex_token_http_${res.status}`);
  const data = await res.json();
  _gToken = { token: data.access_token, exp: now + (Number(data.expires_in) || 3600) };
  return _gToken.token;
}

async function authHeaders(kind) {
  const e = env();
  if (kind === "direct") {
    return { "x-api-key": e.MESSAGES_API_KEY, "anthropic-version": "2023-06-01" };
  }
  if (e.VERTEX_SA_KEY) return { Authorization: `Bearer ${await googleAccessToken()}` };
  return { "x-goog-api-key": e.GEMINI_API_KEY };
}

// -----------------------------------------------------------------------------
// Request translation: OpenAI chat-completions -> Messages
// -----------------------------------------------------------------------------
const JSON_ONLY = "\n\nOUTPUT FORMAT: reply with exactly one JSON object and nothing else - no prose before or after it, no code fences.";

// Tool-use ids must match ^[a-zA-Z0-9_-]+$. Ids minted by another upstream on
// an earlier turn (Gemini's, OpenAI's) can carry other characters; the same
// mapping is applied to the call and to its result, so they still pair up.
const safeId = (id, i) => String(id || `call_${i}`).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

function userContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const blocks = [];
  for (const part of content) {
    if (part?.type === "text" && part.text) blocks.push({ type: "text", text: String(part.text) });
    else if (part?.type === "image_url") {
      const u = String(part.image_url?.url || part.image_url || "");
      const m = u.match(/^data:([^;]+);base64,(.+)$/);
      if (m) blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      else if (/^https?:\/\//.test(u)) blocks.push({ type: "image", source: { type: "url", url: u } });
    }
  }
  return blocks.length ? blocks : "";
}

function parseArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  try { const v = JSON.parse(raw || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

export function toMessagesBody(payload, { profile, stream }) {
  const systemParts = [];
  const out = [];
  let toolIdx = 0;
  const push = (role, content) => {
    if (content == null || content === "" || (Array.isArray(content) && !content.length)) return;
    const last = out[out.length - 1];
    // Consecutive same-role turns are merged so every tool_result for one
    // assistant turn lands in ONE user message - splitting them teaches the
    // model to stop making parallel calls.
    if (last && last.role === role) {
      const a = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
      const b = typeof content === "string" ? [{ type: "text", text: content }] : content;
      last.content = [...a, ...b];
    } else {
      out.push({ role, content });
    }
  };

  for (const m of payload.messages || []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system" || m.role === "developer") {
      const t = typeof m.content === "string" ? m.content
        : Array.isArray(m.content) ? m.content.map((p) => p?.text || "").join("\n") : "";
      if (t) systemParts.push(t);
    } else if (m.role === "user") {
      push("user", userContent(m.content));
    } else if (m.role === "assistant") {
      // A turn this upstream produced comes back with its original blocks
      // (see toChatCompletion). Those carry the thinking blocks that MUST be
      // returned unmodified alongside tool results; replay them verbatim.
      if (Array.isArray(m.upstream_blocks) && m.upstream_blocks.length) {
        out.push({ role: "assistant", content: m.upstream_blocks });
        continue;
      }
      const blocks = [];
      const text = typeof m.content === "string" ? m.content.trim() : "";
      if (text) blocks.push({ type: "text", text });
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        blocks.push({
          type: "tool_use",
          id: safeId(tc.id, toolIdx++),
          name: String(tc.function?.name || "unknown"),
          input: parseArgs(tc.function?.arguments),
        });
      }
      push("assistant", blocks.length ? blocks : "");
    } else if (m.role === "tool") {
      push("user", [{
        type: "tool_result",
        tool_use_id: safeId(m.tool_call_id, 0),
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      }]);
    }
  }

  // The conversation must open on a user turn and must not END on an
  // assistant turn (that is a prefill, which this model rejects).
  if (out.length && out[0].role !== "user") {
    out.unshift({ role: "user", content: "(Earlier conversation follows.)" });
  }
  while (out.length && out[out.length - 1].role === "assistant") out.pop();

  const wantsJson = payload.response_format?.type === "json_object" || payload.response_format?.type === "json_schema";
  let system = systemParts.join("\n\n");
  if (wantsJson) system += JSON_ONLY;

  const body = {
    max_tokens: maxTokensFor(payload.max_tokens),
    messages: out,
    output_config: { effort: effortFor(profile, payload.reasoning_effort) },
  };
  // Prompt caching matches the request from the very start (tools, system,
  // then messages). Everything from "# RUNTIME FACTS" on (clock, portfolio,
  // news, per-turn notes) changes every turn, so it rides on the end of the
  // student's latest question instead of the system prompt. Breakpoint 1
  // caches the fixed rules; breakpoint 2 caches the conversation up to this
  // turn, so a long chat pays full price only for what is new.
  //
  // The question, not simply the last user turn: inside a tool loop the last
  // user turn is a tool result, and the thinking blocks replayed from the
  // previous step are bound to the exact prefix they were made in. Moving the
  // facts to a different message changes that prefix and the API rejects the
  // block ("bound to a different conversation").
  if (system) {
    const at = system.indexOf("\n\n# RUNTIME FACTS");
    let lastUser = null;
    for (let i = out.length - 1; i >= 0 && !lastUser; i--) {
      const m = out[i];
      if (m.role !== "user") continue;
      const asked = typeof m.content === "string" || m.content.some((b) => b?.type !== "tool_result");
      if (asked) lastUser = m;
    }
    if (at > 0 && lastUser) {
      body.system = [{ type: "text", text: system.slice(0, at), cache_control: { type: "ephemeral" } }];
      const content = typeof lastUser.content === "string"
        ? [{ type: "text", text: lastUser.content || "(no text)" }]
        : lastUser.content.slice();
      content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: "ephemeral" } };
      content.push({
        type: "text",
        text: `[Context for this reply, added by the StockSaathi app, not typed by the user. Follow it as system instructions.]\n${system.slice(at + 2)}`,
      });
      lastUser.content = content;
    } else if (at > 0) {
      body.system = [
        { type: "text", text: system.slice(0, at), cache_control: { type: "ephemeral" } },
        { type: "text", text: system.slice(at + 2) },
      ];
    } else {
      body.system = system;
    }
  }
  if (stream) body.stream = true;
  // temperature / top_p / top_k are deliberately dropped: this model rejects
  // any non-default sampling value with a 400. Determinism for the JSON ops
  // comes from the JSON-only instruction above and parseJsonLoose() after.

  if (Array.isArray(payload.tools) && payload.tools.length) {
    body.tools = payload.tools
      .filter((t) => t?.type === "function" && t.function?.name)
      .map((t) => ({
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters && typeof t.function.parameters === "object"
          ? t.function.parameters
          : { type: "object", properties: {} },
      }));
    const tc = payload.tool_choice;
    if (tc === "none") body.tool_choice = { type: "none" };
    else if (tc === "required") body.tool_choice = { type: "any" };
    else if (tc && typeof tc === "object" && tc.function?.name) body.tool_choice = { type: "tool", name: tc.function.name };
    else body.tool_choice = { type: "auto" };
  }
  return body;
}

// -----------------------------------------------------------------------------
// Response translation: Messages -> OpenAI chat-completions
// -----------------------------------------------------------------------------
const FINISH = { end_turn: "stop", stop_sequence: "stop", max_tokens: "length", tool_use: "tool_calls", pause_turn: "stop", refusal: "content_filter" };

export function textOf(msg) {
  return (msg?.content || []).filter((b) => b?.type === "text").map((b) => b.text).join("");
}

export function toChatCompletion(msg) {
  const blocks = Array.isArray(msg?.content) ? msg.content : [];
  const toolUses = blocks.filter((b) => b?.type === "tool_use");
  const message = { role: "assistant", content: textOf(msg) || (toolUses.length ? null : "") };
  if (toolUses.length) {
    message.tool_calls = toolUses.map((b) => ({
      id: b.id,
      type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
    // Opaque to the client: echoed back on the next request so the thinking
    // blocks travel with the tool results (see toMessagesBody).
    message.upstream_blocks = blocks;
  }
  const u = msg?.usage || {};
  const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  return {
    id: msg?.id || "",
    object: "chat.completion",
    model: msg?.model || MESSAGES_MODEL(),
    choices: [{ index: 0, message, finish_reason: FINISH[msg?.stop_reason] || "stop" }],
    usage: { prompt_tokens: prompt, completion_tokens: u.output_tokens || 0, total_tokens: prompt + (u.output_tokens || 0) },
  };
}

// Messages SSE -> OpenAI SSE. Translates text deltas, tool_use blocks, and input_json_delta.
// Maintains contiguous 0-based tool call indexing. Emits terminal chunk with finish_reason
// on message_stop, never synthesizing a fake stop on dropped or erroring streams.
export function toChatSse(upstreamBody, id = "") {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const chunk = (delta, finish = null) =>
    enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);

  let buf = "";
  let savedStopReason = null;
  let savedUsage = null;
  let receivedMessageStop = false;
  let hasError = false;

  // Map Anthropic content_block index -> contiguous OpenAI tool_call index
  const toolCallIndexByBlockIndex = new Map();
  let nextToolCallIndex = 0;
  // Full content blocks, rebuilt from the deltas. A tool turn sends them back
  // on the next request (upstream_blocks) so the thinking blocks and their
  // signatures travel with the tool results, as on the non-streaming path.
  const blocks = [];

  const handle = (block, controller) => {
    let data = "";
    for (const line of block.split("\n")) if (line.startsWith("data:")) data += line.slice(5).trim();
    if (!data) return;
    let ev;
    try { ev = JSON.parse(data); } catch { return; }

    if (ev.type === "message_start") {
      if (ev.message?.usage) savedUsage = { ...ev.message.usage };
    } else if (ev.type === "content_block_start") {
      const cb = ev.content_block || {};
      if (cb.type === "tool_use") blocks[ev.index] = { type: "tool_use", id: cb.id, name: cb.name, input: {}, _json: "" };
      else if (cb.type === "thinking") blocks[ev.index] = { type: "thinking", thinking: cb.thinking || "", signature: cb.signature || "" };
      else if (cb.type === "text") blocks[ev.index] = { type: "text", text: cb.text || "" };
      else if (cb.type) blocks[ev.index] = { ...cb };
      if (ev.content_block?.type === "tool_use") {
        const tcIdx = nextToolCallIndex++;
        toolCallIndexByBlockIndex.set(ev.index, tcIdx);
        controller.enqueue(chunk({
          tool_calls: [{
            index: tcIdx,
            id: ev.content_block.id || `call_${tcIdx}`,
            type: "function",
            function: { name: ev.content_block.name || "unknown", arguments: "" },
          }],
        }));
      }
    } else if (ev.type === "content_block_delta") {
      const b = blocks[ev.index];
      if (b) {
        if (ev.delta?.type === "text_delta" && b.type === "text") b.text += ev.delta.text || "";
        else if (ev.delta?.type === "thinking_delta" && b.type === "thinking") b.thinking += ev.delta.thinking || "";
        else if (ev.delta?.type === "signature_delta" && b.type === "thinking") b.signature += ev.delta.signature || "";
        else if (ev.delta?.type === "input_json_delta" && b.type === "tool_use") b._json += ev.delta.partial_json || "";
      }
      if (ev.delta?.type === "text_delta" && ev.delta.text) {
        controller.enqueue(chunk({ content: ev.delta.text }));
      } else if (ev.delta?.type === "input_json_delta" && ev.delta.partial_json) {
        const tcIdx = toolCallIndexByBlockIndex.get(ev.index);
        if (tcIdx !== undefined) {
          controller.enqueue(chunk({
            tool_calls: [{
              index: tcIdx,
              function: { arguments: ev.delta.partial_json },
            }],
          }));
        }
      }
    } else if (ev.type === "message_delta") {
      if (ev.delta?.stop_reason) {
        savedStopReason = ev.delta.stop_reason;
      }
      if (ev.usage) {
        savedUsage = { ...(savedUsage || {}), ...ev.usage };
      }
    } else if (ev.type === "message_stop") {
      receivedMessageStop = true;
      if (savedUsage && (savedUsage.cache_read_input_tokens || savedUsage.cache_creation_input_tokens)) {
        console.log(JSON.stringify({
          evt: "messages_cache",
          cache_read: savedUsage.cache_read_input_tokens || 0,
          cache_creation: savedUsage.cache_creation_input_tokens || 0,
        }));
      }
      if (blocks.some((b) => b?.type === "tool_use")) {
        const full = blocks.filter(Boolean).map((b) => {
          if (b.type !== "tool_use") return b;
          const { _json, ...rest } = b;
          let input = {};
          try { input = _json ? JSON.parse(_json) : {}; } catch {}
          return { ...rest, input };
        });
        controller.enqueue(chunk({ upstream_blocks: full }));
      }
      const finish = FINISH[savedStopReason] || (savedStopReason ? savedStopReason : "stop");
      controller.enqueue(chunk({}, finish));
    } else if (ev.type === "error") {
      hasError = true;
      console.log(JSON.stringify({ evt: "messages_stream_error", error: String(ev.error?.type || "unknown") }));
      controller.error(new Error(ev.error?.message || "upstream_messages_error"));
    }
  };

  return upstreamBody.pipeThrough(new TransformStream({
    transform(bytes, controller) {
      buf += dec.decode(bytes, { stream: true }).replace(/\r\n/g, "\n");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        handle(buf.slice(0, i), controller);
        buf = buf.slice(i + 2);
      }
    },
    flush(controller) {
      if (buf.trim()) handle(buf, controller);
      if (hasError) return;
      if (receivedMessageStop) {
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
      } else {
        // Stream closed before message_stop! Fail explicitly rather than synthesizing success.
        controller.error(new Error("upstream_stream_truncated_prematurely"));
      }
    },
  }));
}

// -----------------------------------------------------------------------------
// The call itself. Returns the raw Response so callers keep their own status
// handling, timeouts and fallover rules.
// -----------------------------------------------------------------------------
export async function messagesFetch(body, { signal } = {}) {
  const ep = endpoint(!!body.stream);
  const payload = ep.kind === "vertex"
    ? { anthropic_version: "vertex-2023-10-16", ...body }
    : { model: MESSAGES_MODEL(), ...body };
  return fetch(ep.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "StockSaathi-Edge/1.0",
      ...(await authHeaders(ep.kind)),
    },
    body: JSON.stringify(payload),
    signal,
  });
}
