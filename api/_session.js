// =============================================================================
// The NSE session a piece of market data belongs to, in IST. Server-side
// twin of marketStatus() in js/data/prices.js: same hours, same holiday list
// (keep the two in step when the 2027 circular comes out).
// =============================================================================

const NSE_HOLIDAYS_2026 = new Set([
  "2026-01-26", "2026-02-17", "2026-03-03", "2026-03-26", "2026-04-03",
  "2026-04-14", "2026-05-01", "2026-08-15", "2026-08-26", "2026-09-14",
  "2026-10-02", "2026-10-21", "2026-11-04", "2026-12-25",
]);
const OPEN_MIN = 9 * 60 + 15;

function istParts(ms) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(new Date(ms)).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { ymd: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute, weekday: p.weekday };
}

const isTradingDay = (ymd, weekday) => !["Sat", "Sun"].includes(weekday) && !NSE_HOLIDAYS_2026.has(ymd);

/**
 * The latest session that has started by `now`:
 * { ymd, isToday, label } where label is "today" or e.g. "Friday 10 Oct".
 */
export function lastSessionIst(now = Date.now()) {
  const today = istParts(now);
  if (isTradingDay(today.ymd, today.weekday) && today.min >= OPEN_MIN) {
    return { ymd: today.ymd, isToday: true, label: "today" };
  }
  for (let back = 1; back <= 10; back++) {
    const t = now - back * 86_400_000;
    const p = istParts(t);
    if (isTradingDay(p.ymd, p.weekday)) {
      const label = new Date(t).toLocaleDateString("en-IN", {
        weekday: "long", day: "numeric", month: "short", timeZone: "Asia/Kolkata",
      });
      return { ymd: p.ymd, isToday: false, label };
    }
  }
  return { ymd: today.ymd, isToday: false, label: "the last session" };
}
