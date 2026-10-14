// =============================================================================
// PRICES — Deterministic, seeded 365-day history for every instrument.
// We generate on-demand using a stable PRNG so the app ships <30kb of JS
// instead of 2MB of JSON. Values are realistic (GBM-ish walk anchored to
// current price + sector beta + known macro events replayed).
//
// Prices are PAISE (integer). Trading days only (no weekends).
// =============================================================================

import { INSTRUMENTS, getInstrument } from "./universe.js";
import { serverNow, isServerTimeSynced } from "./serverTime.js";

// Module-scoped instrument resolver. Defaults to the loader's getInstrument
// (which returns curated → Tier-2 → stub), so this file Just Works for any
// symbol without needing a setUniverse hook. Kept as a function so the loader
// can override it at boot if a richer resolver is wired in.
let _resolveInstrument = getInstrument;
export function setUniverse(map) {
  // Backward-compat shim: accept an array, an object map, or null. Any caller
  // can swap the resolver — but the default getInstrument() path already
  // covers Tier-2 once universeFull.json lands, so most callers don't need
  // this. Provided for symmetry with the original Phase-3 design.
  if (!map) { _resolveInstrument = getInstrument; return; }
  if (Array.isArray(map)) {
    const byS = {};
    for (const i of map) if (i && i.symbol) byS[i.symbol] = i;
    _resolveInstrument = sym => byS[sym] || getInstrument(sym);
  } else if (typeof map === "object") {
    _resolveInstrument = sym => map[sym] || getInstrument(sym);
  }
  _cache.clear();
}

const TRADING_DAYS = 365;   // ~18 months calendar = ~365 trading days
const SECONDS_PER_DAY = 86400000;

/** Mulberry32 — deterministic PRNG seeded by symbol+day. */
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Box-Muller normal draw from two uniform samples. */
function normal(rand) {
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Macro events — re-inject known correction days to give data a realistic feel.
// day offsets are from today going back (0 = today).
const MACRO_EVENTS = [
  { day: 20,  allBeta: -0.025, label: "Global rate-hike fears" },
  { day: 55,  allBeta: +0.018, label: "Strong Q2 results" },
  { day: 90,  allBeta: -0.042, label: "Geopolitical shock" },
  { day: 145, allBeta: +0.012, label: "FII inflow surge" },
  { day: 210, allBeta: -0.035, label: "Budget selloff" },
  { day: 260, allBeta: -0.068, label: "Mid-cap correction" },
  { day: 315, allBeta: +0.022, label: "US Fed dovish pivot" },
  { day: 340, allBeta: -0.022, label: "Election jitters" },
];

/**
 * Generate a price series for one symbol, working backwards from today's price.
 * Returns: array[TRADING_DAYS] of objects { t, o, h, l, c, v }. Index 0 is oldest.
 */
export function generateSeries(symbol) {
  const inst = _resolveInstrument(symbol);
  if (!inst) return [];

  const beta = inst.beta || 1;
  const risk = inst.risk || "med";
  const rand = prng(seedFromString(symbol));

  // Tier-2 fallback: imported NSE rows have no curated price. Synthesize a
  // believable but visually muted walk anchored to a deterministic per-symbol
  // value so the sparkline isn't blank. Smaller sigma, no macro events, no
  // drift — clearly distinguishable from real history.
  const hasRealPrice = typeof inst.price === "number" && inst.price > 0;
  if (!hasRealPrice) {
    const anchor = 5000 + (seedFromString(symbol) % 500000);   // ~₹50–₹5000
    const sigmaStub = 0.006;
    const closesStub = new Array(TRADING_DAYS);
    closesStub[TRADING_DAYS - 1] = anchor;
    for (let i = TRADING_DAYS - 2; i >= 0; i--) {
      const z = normal(rand);
      const ret = sigmaStub * z;
      closesStub[i] = Math.round(closesStub[i + 1] / (1 + ret));
    }
    return _buildOhlc(closesStub, rand);
  }

  const basePrice = inst.price;      // current (final) price in paise
  const sigma = risk === "high" ? 0.025 : risk === "low" ? 0.012 : 0.017;
  const drift = 0.0003;  // mild upward bias

  // Walk backwards. Start from current price, apply reverse returns.
  const closes = new Array(TRADING_DAYS);
  closes[TRADING_DAYS - 1] = basePrice;

  for (let i = TRADING_DAYS - 2; i >= 0; i--) {
    const dayOffset = TRADING_DAYS - 1 - i;
    let macro = 0;
    for (const ev of MACRO_EVENTS) {
      if (Math.abs(dayOffset - ev.day) <= 1) {
        macro += ev.allBeta * beta;
      }
    }
    const z = normal(rand);
    const ret = drift + sigma * z + macro;
    // p[i] = p[i+1] / (1+ret) — going backwards
    closes[i] = Math.round(closes[i + 1] / (1 + ret));
  }
  return _buildOhlc(closes, rand);
}

// Extracted from generateSeries so the Tier-2 stub-fallback path can reuse
// it without duplicating the intraday-spread + timestamp logic.
function _buildOhlc(closes, rand) {
  const series = new Array(TRADING_DAYS);
  const now = startOfDayIST(Date.now());
  for (let i = 0; i < TRADING_DAYS; i++) {
    const c = closes[i];
    const prev = i === 0 ? c : closes[i - 1];
    const o = i === 0 ? c : prev;
    const intradayVar = Math.abs(c - o) * (0.4 + rand() * 0.8);
    const h = Math.max(c, o) + Math.round(intradayVar * (0.4 + rand() * 0.5));
    const l = Math.min(c, o) - Math.round(intradayVar * (0.4 + rand() * 0.5));
    const v = Math.round(100000 + rand() * 900000);
    const daysBack = TRADING_DAYS - 1 - i;
    const calBack = tradingToCalendar(daysBack);
    series[i] = {
      t: now - calBack * SECONDS_PER_DAY,
      o, h: Math.max(h, o, c), l: Math.min(l, o, c), c,
      v,
    };
  }
  return series;
}

function tradingToCalendar(td) {
  // Approx: 5 trading days = 7 calendar days
  return Math.floor(td * 7 / 5);
}

function startOfDayIST(ms) {
  const d = new Date(ms);
  d.setUTCHours(10, 0, 0, 0); // 3:30 PM IST close
  return d.getTime();
}

// -----------------------------------------------------------------------------
// Cache generated series
// -----------------------------------------------------------------------------
const _cache = new Map();

/**
 * Get full 365-day series (cached). Returned array is readonly — do not mutate.
 */
export function getSeries(symbol) {
  if (!_cache.has(symbol)) _cache.set(symbol, generateSeries(symbol));
  return _cache.get(symbol);
}

/**
 * Get closes-only array for sparkline rendering.
 */
export function getCloses(symbol, lastNDays = null) {
  const s = getSeries(symbol);
  const closes = s.map(k => k.c);
  return lastNDays != null ? closes.slice(-lastNDays) : closes;
}

/**
 * Get a specific day's price. 0 = today (latest), 1 = yesterday, etc.
 *
 * MF defensive branch: even after the universeLoader fix that maps
 * `nav` → `inst.price`, the synthetic stub-walk for MFs still produces
 * walk-around values rather than the actual NAV. For "today" (daysBack=0)
 * we want the LATEST NAV, so prefer `inst.nav * 100` directly. This makes
 * portfolio valuation, P&L math, and trade-confirmation totals accurate
 * even before /api/mf-history populates a real series.
 */
export function getPriceAt(symbol, daysBack = 0) {
  if (symbol && symbol.startsWith("MF_")) {
    // Hotfix57a: MFs must NEVER fall through to the seeded stub walk
    // when AMFI hasn't loaded yet. The walk produces deterministic-but-
    // wrong values (e.g. ₹3,328 for MF_151908, whose real NAV is
    // ₹1,000), which were silently flowing into portfolio LTP, hero
    // value, P&L %, and trade-confirmation totals — visible to users
    // as "+232% gain" on a fund that hadn't moved a paisa. AMFI ships
    // one NAV per scheme per day; there's nothing to simulate. If we
    // don't have inst.nav yet, return null so callers can render "—"
    // instead of a fabricated number.
    const inst = _resolveInstrument(symbol);
    if (inst && inst.kind === "MF") {
      if (daysBack === 0 && typeof inst.nav === "number" && inst.nav > 0) {
        return Math.round(inst.nav * 100);
      }
      // Yesterday's close (or further back) for an MF is provided by
      // /api/mf-history, not generateSeries. Returning null tells
      // getTodayChange & friends to bail rather than cite a fake number.
      return null;
    }
  }
  const s = getSeries(symbol);
  return s[s.length - 1 - daysBack]?.c;
}

/**
 * Compute percentage change between two points (returns DECIMAL e.g. 0.042 = 4.2%)
 */
export function pctChange(from, to) {
  if (!from || !to) return 0;
  return (to - from) / from;
}

/**
 * Get day-over-day change for sparkline color/sign.
 *
 * Hotfix57a: MFs short-circuit. The seeded walk for MFs is a lie (AMFI
 * publishes one NAV per day; there is no intraday motion). Any caller
 * that needs an MF day-change should rely on the /api/mf-history cache
 * via synthMFQuote. Returning 0 here keeps sparklines flat-line for MFs
 * that haven't populated mfHistoryCache yet, instead of showing a
 * fictional ±0.6% drift.
 */
// Fallback "today %" for when no live quote exists. It used to compute this
// from the SEEDED synthetic walk, so cards showed an invented move until
// the first quote landed (D7). Unknown is null now: formatPct shows "—" and
// deltaClass stays neutral. Funds keep 0 (their NAV moves once a day).
export function getTodayChange(symbol) {
  if (symbol && symbol.startsWith("MF_")) return 0;
  return null;
}

/**
 * Get the drawdown from the last N-day high — used for panic detection
 */
export function getDrawdownFromHigh(symbol, days = 30) {
  const s = getSeries(symbol).slice(-days);
  const high = Math.max(...s.map(k => k.h));
  const now = s[s.length - 1].c;
  return pctChange(high, now); // negative
}

/**
 * Get simple 52-week high/low (we only have 365 days so this IS the 52-week)
 */
export function get52wRange(symbol) {
  const s = getSeries(symbol);
  let hi = -Infinity, lo = Infinity;
  for (const k of s) {
    if (k.h > hi) hi = k.h;
    if (k.l < lo) lo = k.l;
  }
  return { hi, lo };
}

// NSE trading holidays (2026) — hardcoded since NSE doesn't expose a
// public holiday API and official dates are a short list. Keep as
// YYYY-MM-DD in IST. Update annually.
// Source: NSE 2026 trading holiday circular.
const NSE_HOLIDAYS_2026 = new Set([
  "2026-01-26",  // Republic Day
  "2026-02-17",  // Mahashivratri
  "2026-03-03",  // Holi
  "2026-03-26",  // Ram Navami
  "2026-04-03",  // Good Friday
  "2026-04-14",  // Ambedkar Jayanti
  "2026-05-01",  // Maharashtra Day
  "2026-08-15",  // Independence Day (Sat — non-effect)
  "2026-08-26",  // Janmashtami
  "2026-09-14",  // Ganesh Chaturthi (approx)
  "2026-10-02",  // Gandhi Jayanti
  "2026-10-21",  // Diwali (Laxmi Puja; special muhurat session happens in evening)
  "2026-11-04",  // Guru Nanak Jayanti
  "2026-12-25",  // Christmas
]);

// 9:15 IST → 15:30 IST for continuous trading (normal session).
// 9:00 → 9:15 is pre-open session — orders accepted but no trading.
const OPEN_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 30;
const PREOPEN_MIN = 9 * 60;

// U13: istParts was the top JavaScript cost on /stocks (387 ms of a
// throttled load): it built a new Intl.DateTimeFormat on every call, and
// marketStatus() runs for every tile. One formatter, and the answer kept
// per minute (nothing here changes inside a minute).
const _IST_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit", minute: "2-digit", hour12: false,
  weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
});
const _istMemo = new Map();   // minute number -> parts

function istParts(date) {
  const ms = +date;
  const minute = Number.isFinite(ms) ? Math.floor(ms / 60000) : null;
  if (minute != null && _istMemo.has(minute)) return _istMemo.get(minute);
  const p = _IST_FMT.formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const out = {
    y: p.year,
    m: p.month,
    d: p.day,
    ymd: `${p.year}-${p.month}-${p.day}`,
    weekday: (p.weekday || "").toLowerCase(),   // "mon" .. "sun"
    hour: parseInt(p.hour, 10),
    min: parseInt(p.minute, 10),
    minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10),
  };
  if (minute != null) {
    if (_istMemo.size > 256) _istMemo.clear();
    _istMemo.set(minute, out);
  }
  return out;
}

function isTradingDay(parts) {
  if (parts.weekday === "sat" || parts.weekday === "sun") return false;
  if (NSE_HOLIDAYS_2026.has(parts.ymd)) return false;
  return true;
}

function labelIstTime(minutes) {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = ((h24 + 11) % 12) + 1;
  const ampm = h24 < 12 ? "AM" : "PM";
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// Pretty day offset: "today", "Mon", "Tue 28 Apr". Used in open-next labels.
function labelDay(parts, todayParts) {
  if (parts.ymd === todayParts.ymd) return "today";
  return {
    mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
  }[parts.weekday] || parts.weekday;
}

// Compute the next IST trading-day open and last IST trading-day close
// around a reference serverDate. Used for "Opens Mon 9:15 AM" / "Closed
// at 3:30 PM today" labels.
function findBoundary(serverDate, direction /* +1 = next open, -1 = last close */) {
  // Walk up to 10 days to skip weekends + holidays.
  for (let i = direction === 1 ? 0 : 0; i < 10; i++) {
    const d = new Date(serverDate.getTime() + direction * i * 86400000);
    const p = istParts(d);
    if (!isTradingDay(p)) continue;
    // Same-day open/close is only a boundary if it's actually ahead of / behind now.
    const edgeMin = direction === 1 ? OPEN_MIN : CLOSE_MIN;
    const nowParts = istParts(serverDate);
    if (p.ymd === nowParts.ymd) {
      if (direction === 1 && nowParts.minutes < edgeMin) {
        return { parts: p, minutes: edgeMin };
      }
      if (direction === -1 && nowParts.minutes >= edgeMin) {
        return { parts: p, minutes: edgeMin };
      }
      continue;
    }
    return { parts: p, minutes: edgeMin };
  }
  return null;
}

/**
 * Rich NSE market status. Uses server-authoritative time via serverNow()
 * when available, falls back to local clock otherwise.
 *
 * Returns:
 *   state       — "open" | "pre-open" | "closed"
 *   open        — boolean (true only for state === "open")
 *   label       — "Market Open" | "Pre-Open Session" | "Market Closed"
 *   shortLabel  — "LIVE" | "PRE-OPEN" | "CLOSED" (for tight pills)
 *   istTime     — "14:32 IST"
 *   istDate     — "Tue, 21 Apr"
 *   istDay      — "tue" (lowercase short weekday)
 *   isHoliday   — true if NSE is closed for a listed holiday today
 *   nextOpenAt       — Date of next market open (or null if inside open window)
 *   nextOpenLabel    — "Opens Tue 9:15 AM" etc.
 *   lastCloseLabel   — "Closed at 3:30 PM today" / "Closed Fri 3:30 PM"
 *   degraded    — true when we're using local clock (server-time not yet synced)
 */
export function marketStatus(opts = {}) {
  const now = serverNow();
  const degraded = !isServerTimeSynced();

  const nowParts = istParts(now);
  const tradingDay = isTradingDay(nowParts);
  const isHoliday = tradingDay === false && nowParts.weekday !== "sat" && nowParts.weekday !== "sun"
    ? NSE_HOLIDAYS_2026.has(nowParts.ymd)
    : false;

  let state;
  if (tradingDay && nowParts.minutes >= OPEN_MIN && nowParts.minutes < CLOSE_MIN) state = "open";
  else if (tradingDay && nowParts.minutes >= PREOPEN_MIN && nowParts.minutes < OPEN_MIN) state = "pre-open";
  else state = "closed";

  const nextOpen = state === "open" ? null : findBoundary(now, +1);
  const lastClose = findBoundary(now, -1);

  const nextOpenLabel = nextOpen
    ? `Opens ${labelDay(nextOpen.parts, nowParts)} ${labelIstTime(nextOpen.minutes)}`
    : "";
  const lastCloseLabel = lastClose
    ? `Closed at ${labelIstTime(lastClose.minutes)} ${labelDay(lastClose.parts, nowParts) === "today" ? "today" : labelDay(lastClose.parts, nowParts)}`
    : "";

  // Compose nextOpenAt Date from IST parts so callers can do countdowns.
  let nextOpenAt = null;
  if (nextOpen) {
    const h = Math.floor(nextOpen.minutes / 60);
    const mm = nextOpen.minutes % 60;
    // Build from IST parts: 'YYYY-MM-DDTHH:mm+05:30' → Date
    nextOpenAt = new Date(`${nextOpen.parts.ymd}T${String(h).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00+05:30`);
  }

  const weekdayCap = nowParts.weekday
    ? nowParts.weekday[0].toUpperCase() + nowParts.weekday.slice(1)
    : "";
  const monthName = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(nowParts.m,10)-1] || "";

  return {
    state,
    open: state === "open",
    label: state === "open" ? "Market Open" : state === "pre-open" ? "Pre-Open Session" : "Market Closed",
    shortLabel: state === "open" ? "LIVE" : state === "pre-open" ? "PRE-OPEN" : "CLOSED",
    istTime: `${labelIstTime(nowParts.minutes)} IST`,
    istDate: `${weekdayCap}, ${parseInt(nowParts.d, 10)} ${monthName}`,
    istDay: nowParts.weekday,
    isHoliday,
    nextOpenAt,
    nextOpenLabel,
    lastCloseLabel,
    degraded,
  };
}

