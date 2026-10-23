// -----------------------------------------------------------------------------
// LLM usage ledger.
//
// One row per model call (and per AI-cache hit) into public.llm_usage, plus
// the same row as an `llm_usage` line in the Vercel log. Until 2026-10-23
// nothing recorded token counts: the only cost signal was the GCP bill
// (~Rs 250/day) and it could not be split by feature, model or lane.
//
// Never logged: prompt or reply text, user ids, IPs. Token counts and
// timings only - the table is safe to show on the admin dashboard.
//
// Cost is NOT computed here. Rows carry raw tokens; admin_llm_usage() prices
// them from public.llm_prices, so a wrong or changed price is fixed with one
// UPDATE and every past row re-prices.
// -----------------------------------------------------------------------------

const env = () => globalThis.process?.env || {};
const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

// Normalises the three usage shapes in play:
//   Messages API      input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens
//   OpenAI-compat     prompt_tokens / completion_tokens (+ completion_tokens_details.reasoning_tokens,
//                     prompt_tokens_details.cached_tokens)
export function normUsage(u) {
  if (!u || typeof u !== "object") return {};
  if ("input_tokens" in u || "output_tokens" in u) {
    return {
      input_tokens: num(u.input_tokens),
      output_tokens: num(u.output_tokens),
      cache_read_tokens: num(u.cache_read_input_tokens) ?? 0,
      cache_write_tokens: num(u.cache_creation_input_tokens) ?? 0,
    };
  }
  const cached = num(u.prompt_tokens_details?.cached_tokens) ?? 0;
  return {
    input_tokens: num(u.prompt_tokens) != null ? num(u.prompt_tokens) - cached : null,
    output_tokens: num(u.completion_tokens),
    reasoning_tokens: num(u.completion_tokens_details?.reasoning_tokens),
    cache_read_tokens: cached,
    cache_write_tokens: 0,
  };
}

const COLS = [
  "route", "op", "feature", "profile", "upstream", "model", "effort", "ok", "status",
  "stream", "tools", "input_tokens", "output_tokens", "reasoning_tokens",
  "cache_read_tokens", "cache_write_tokens", "ttft_ms", "total_ms", "stop_reason",
  "attempt", "region",
];

function clean(row) {
  const out = {};
  for (const k of COLS) {
    const v = row[k];
    if (v === undefined || v === null || v === "") continue;
    out[k] = typeof v === "string" ? v.slice(0, 120) : v;
  }
  return out;
}

// Records one row. Always resolves (never throws) and never waits longer than
// capMs: a slow Supabase must not slow an answer down. Region is the Vercel
// edge region, useful when a lane's latency moves.
export async function recordUsage(row, { capMs = 700 } = {}) {
  const r = clean({ region: env().VERCEL_REGION || undefined, ...row });
  try { console.log(JSON.stringify({ evt: "llm_usage", ...r })); } catch {}
  const url = env().SUPABASE_URL;
  const key = env().SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), capMs);
  try {
    await fetch(`${url.replace(/\/$/, "")}/rest/v1/llm_usage`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(r),
      signal: ctrl.signal,
    });
  } catch {} finally {
    clearTimeout(timer);
  }
}

// Which part of the app made the call. The browser names itself with this
// header; anything else is "unknown" rather than guessed.
export function featureOf(req) {
  const f = req?.headers?.get?.("X-Saathi-Feature") || "";
  return /^[a-z0-9:_-]{1,40}$/i.test(f) ? f.toLowerCase() : "unknown";
}

// Taps an OpenAI-shaped SSE stream (the Gemini passthrough) for a final
// `usage` object without changing a byte of it. Upstreams that do not send
// usage in the stream leave tokens null, which the dashboard shows as such.
export function tapOpenAiSse(body, onDone) {
  const dec = new TextDecoder();
  let tail = "";
  let usage = null;
  let finish = null;
  return body.pipeThrough(new TransformStream({
    transform(bytes, controller) {
      controller.enqueue(bytes);
      tail = (tail + dec.decode(bytes, { stream: true })).slice(-8192);
      const lines = tail.split("\n");
      tail = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          if (ev?.usage) usage = ev.usage;
          const fr = ev?.choices?.[0]?.finish_reason;
          if (fr) finish = fr;
        } catch {}
      }
    },
    async flush() {
      await onDone({ usage, finish });
    },
  }));
}
