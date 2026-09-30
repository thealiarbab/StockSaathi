// =============================================================================
// PORTFOLIO DIGEST — One-paragraph AI take on the user's portfolio state,
// shown at the top of /portfolio. Generated server-side via Gemini, cached
// per-user per-day in localStorage so reloads are instant.
// =============================================================================

const CACHE_KEY = "ss.portfolioDigest.v1";

export function cachedDigest(userId) {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.userId !== userId) return null;
    if (obj.dayKey !== dayKey()) return null;
    return obj.data;
  } catch { return null; }
}

function writeCache(userId, data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      userId, dayKey: dayKey(), data, savedAt: Date.now(),
    }));
  } catch {}
}

function dayKey() {
  // IST-day bucket so "today's digest" always matches the trading day the
  // user actually sees at market open/close, not the UTC midnight flip.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// signature = concise summary of what the digest was generated from.
// If holdings or today's change has shifted meaningfully since the cached
// digest, the signature changes and we regenerate. Stops stale narrative
// after a trade mid-day.
function signatureOf(payload) {
  const h = (payload.holdings || []).map(x => `${x.symbol}:${x.qty}:${x.dayPct.toFixed(1)}`).join(",");
  return `${payload.totalRupees.toFixed(0)}|${payload.deltaPct.toFixed(1)}|${h}`;
}

export async function fetchDigest(userId, payload) {
  // Client-side cache check: same user + same day + same portfolio signature.
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && obj.userId === userId && obj.dayKey === dayKey() && obj.signature === signatureOf(payload)) {
        return obj.data;
      }
    }
  } catch {}

  const res = await fetch("/api/ai?op=portfolio-digest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.narrative) throw new Error("no_narrative");

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      userId, dayKey: dayKey(), signature: signatureOf(payload), data, savedAt: Date.now(),
    }));
  } catch {}
  return data;
}
