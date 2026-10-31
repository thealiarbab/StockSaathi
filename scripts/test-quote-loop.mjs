// =============================================================================
// scripts/test-quote-loop.mjs — getQuote/getQuoteBatch must terminate.
//
// 19-31 Oct 2026: getQuote(S) called getQuoteBatch([S]), whose per-symbol
// fallback called getQuote(S) again. For a symbol no endpoint prices (dead or
// suspended ticker) that never ended: one /api/live-quote + one /api/quotes
// per loop, ~3M requests a day. This runs the real js/data/marketData.js
// against a mocked fetch and counts requests.
//
// Run: node scripts/test-quote-loop.mjs
// =============================================================================

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const LIVE = "RELIANCE";   // priced by /api/live-quote
const DEAD = "TCS";        // priced by nothing
const calls = [];
let cap = 200;             // hard stop so the old bug fails instead of hanging

globalThis.fetch = async (url) => {
  calls.push(String(url));
  if (calls.length > cap) throw new Error("request cap hit: unbounded loop");
  const u = new URL(String(url), "https://x.test");
  const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (u.pathname === "/api/live-quote" || u.pathname === "/api/quotes") {
    const syms = (u.searchParams.get("symbols") || "").split(",");
    const quotes = {};
    for (const w of syms) if (w.replace(/\.(NS|BO)$/, "") === LIVE) quotes[w] = { price: 1234.5, prev_close: 1200, ts_ms: Date.now() };
    return json({ ok: true, quotes });
  }
  if (u.pathname === "/api/quote") return json({ ok: false, error: "no data" });
  return { ok: false, status: 404, json: async () => null, text: async () => "" };
};

const md = await import("../js/data/marketData.js");
let failed = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? "  " + extra : ""}`); if (!cond) failed++; };
const withCap = (p) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout: did not terminate")), 5000))]);

// 1. Dead symbol terminates with a bounded number of requests.
calls.length = 0;
let q = await withCap(md.getQuote(DEAD)).catch((e) => ({ err: e.message }));
check("dead symbol: getQuote terminates", !q?.err, q?.err || "");
check("dead symbol: bounded requests (<= 6)", calls.length <= 6, `${calls.length} requests: ${calls.map((c) => new URL(c, "https://x.test").pathname).join(" ")}`);
check("dead symbol: returns synthetic, not a real price", !q || q.source === "synthetic");

// 2. Negative cache: asking again within 60 s (past the 8 s quote TTL) costs nothing.
const realNow = Date.now;
Date.now = () => realNow() + 20_000;
calls.length = 0;
await withCap(md.getQuote(DEAD));
await withCap(md.getQuoteBatch([DEAD]));
check("dead symbol: no requests inside the 60 s negative cache", calls.length === 0, `${calls.length} requests`);

// 3. After 60 s it is tried again, once, and still terminates.
Date.now = () => realNow() + 70_000;
calls.length = 0;
await withCap(md.getQuoteBatch([DEAD]));
check("dead symbol: retried after 60 s, bounded", calls.length > 0 && calls.length <= 6, `${calls.length} requests`);
Date.now = realNow;

// 4. A live symbol still gets its price from /api/live-quote, one request.
calls.length = 0;
q = await withCap(md.getQuote(LIVE, {}));
check("live symbol: real price", q && q.pricePaise === 123450 && q.source !== "synthetic", JSON.stringify(q && { p: q.pricePaise, s: q.source }));
check("live symbol: one /api/live-quote request", calls.length === 1 && calls[0].startsWith("/api/live-quote"), calls.join(" "));

// 5. Mixed batch through the poll path.
Date.now = () => realNow() + 200_000;
calls.length = 0;
const b = await withCap(md.getQuoteBatch([LIVE, DEAD]));
check("batch: live priced, dead synthetic, bounded", b[LIVE]?.pricePaise === 123450 && b[DEAD]?.source === "synthetic" && calls.length <= 6, `${calls.length} requests`);
Date.now = realNow;

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
