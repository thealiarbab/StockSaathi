// =============================================================================
// PORTFOLIO DIGEST — One-paragraph AI take on the user's portfolio state,
// shown at the top of /portfolio. Generated server-side via Gemini, cached
// per-user per-day in localStorage so reloads are instant.
// =============================================================================

import { aiLang } from "./aiLang.js";

const CACHE_KEY = "ss.portfolioDigest.v1";   // old entries have no basis: one regeneration, then reused

export function cachedDigest(userId) {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.userId !== userId) return null;
    if (obj.dayKey !== dayKey()) return null;
    // C11: written in the other language (Hinglish switched since).
    if ((obj.lang ?? "") !== aiLang()) return null;
    return obj.data;
  } catch { return null; }
}

function writeCache(userId, data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      userId, dayKey: dayKey(), lang: aiLang(), data, savedAt: Date.now(),
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

// When is a saved digest still right? Compare against the numbers it was
// WRITTEN FROM, not rounded buckets. Until 31 Oct this rounded every
// holding's day move to a whole percent, so +0.4% -> +0.6% (rounds 0 -> 1)
// bought a new digest: 8,945 model calls for 25,230 portfolio opens in a week.
// Now a new one is written only when:
//   - the user trades (holdings or quantities change), or it is a new day,
//     or the language changed;
//   - the total return or any holding's day move is MOVE_PTS points away
//     from what the saved digest described.
const MOVE_PTS = 2;

function basisOf(payload) {
  const h = {};
  for (const x of payload.holdings || []) h[x.symbol] = { q: x.qty, d: Number(x.dayPct) || 0 };
  return { r: Number(payload.deltaPct) || 0, h };
}

export function digestStillFits(saved, payload) {
  if (!saved || typeof saved !== "object" || !saved.h) return false;
  const now = basisOf(payload);
  const a = Object.keys(saved.h).sort(), b = Object.keys(now.h).sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i])) return false;
  if (Math.abs((saved.r || 0) - now.r) >= MOVE_PTS) return false;
  for (const k of b) {
    if (saved.h[k].q !== now.h[k].q) return false;
    if (Math.abs((saved.h[k].d || 0) - now.h[k].d) >= MOVE_PTS) return false;
  }
  return true;
}

export async function fetchDigest(userId, payload) {
  // Client-side cache check: same user + same day + same language, and the
  // portfolio has not really changed since the digest was written.
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && obj.userId === userId && obj.dayKey === dayKey() && (obj.lang ?? "") === aiLang()
          && digestStillFits(obj.basis, payload)) {
        return obj.data;
      }
    }
  } catch {}

  const res = await fetch("/api/ai?op=portfolio-digest" + aiLang(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.narrative) throw new Error("no_narrative");

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      userId, dayKey: dayKey(), basis: basisOf(payload), lang: aiLang(), data, savedAt: Date.now(),
    }));
  } catch {}
  return data;
}
