// =============================================================================
// EVENT MARQUEE â€” traversing announcement bar that ONLY appears when
// there's something to announce.
// =============================================================================
//
// Hotfix46d. User asked for "a traversing header which loops through the
// header of the page announcing any stock closing today or any dates,
// the header should ONLY be activated during such events."
//
// Design rules:
//   1. Hidden by default. Zero DOM weight on quiet days.
//   2. Renders ABOVE the main nav so it's the first thing the user sees.
//   3. Picks events from a deterministic getActiveEvents() function:
//      - Recently wound-up MFs (last 30 days by nav_date when nav < 0.01)
//      - Today is an NSE market holiday
//      - More sources can be plugged in later (earnings, IPO listings,
//        corporate actions, RBI policy days)
//   4. Each event scrolls right-to-left; on hover it pauses (CSS).
//   5. CSS animation (no JS frame loop) so it costs nothing to run.
//
// Wire-up: js/app.js calls mountEventMarquee() on boot. The function is
// idempotent â€” calling twice is a no-op (returns early if already mounted).

import { INSTRUMENTS } from "../data/universe.js";

// NSE market holidays for the current year. Manually maintained because
// NSE doesn't publish a machine-readable feed and the list is short
// enough to update annually. Format: ISO date strings (Asia/Kolkata).
//
// Source: nseindia.com/resources/exchange-communication-holidays
// Last reviewed 2026-04-26 against the 2026 holiday list.
const NSE_HOLIDAYS_2026 = {
  "2026-01-26": "Republic Day",
  "2026-03-04": "Mahashivratri",
  "2026-03-25": "Holi",
  "2026-04-03": "Mahavir Jayanti",
  "2026-04-14": "Dr. Ambedkar Jayanti",
  "2026-04-19": "Good Friday",
  "2026-08-15": "Independence Day",
  "2026-08-27": "Ganesh Chaturthi",
  "2026-10-02": "Mahatma Gandhi Jayanti",
  "2026-10-21": "Diwali Laxmi Pujan",
  "2026-11-25": "Guru Nanak Jayanti",
  "2026-12-25": "Christmas",
};

function _todayIstIso() {
  // YYYY-MM-DD in IST. Date.now() is UTC; we add the IST offset (+5:30)
  // before slicing.
  const istMs = Date.now() + 5.5 * 3600 * 1000;
  return new Date(istMs).toISOString().slice(0, 10);
}

function _daysAgo(isoDate) {
  if (!isoDate) return Infinity;
  const dt = new Date(isoDate);
  if (isNaN(dt)) return Infinity;
  return Math.floor((Date.now() - dt.getTime()) / 86400000);
}

// Public for testability. Returns array of { kind, text, severity } objects.
// Severity drives the marquee colour (info / warning).
export function getActiveEvents() {
  const events = [];

  // 1. NSE market holidays
  const today = _todayIstIso();
  if (NSE_HOLIDAYS_2026[today]) {
    events.push({
      kind: "holiday",
      text: `NSE & BSE closed today — ${NSE_HOLIDAYS_2026[today]}. No equity / ETF trading. MF NAVs publish as usual.`,
      severity: "info",
    });
  }

  // 2. Recently wound-up MFs (last 30 days). Detection mirrors
  //    isTerminatedFund in stockDetail.js / _isMfTerminated in stocks.js.
  //    A wound-up scheme is recent if nav_date is in the last 30 days.
  //    Most zombie schemes are 3+ years old so this section will be
  //    empty most of the time â€” which is intentional. If a real
  //    termination happens recently, it surfaces here.
  try {
    const recent = (INSTRUMENTS || []).filter(i => {
      if (i?.kind !== "MF") return false;
      const nav = typeof i.nav === "number" ? i.nav : null;
      if (nav == null || nav >= 0.01) return false;
      return _daysAgo(i.nav_date) <= 30;
    });
    if (recent.length === 1) {
      const mf = recent[0];
      events.push({
        kind: "termination",
        text: `⚠ Fund wound up: ${mf.name} (last NAV ₹${mf.nav.toFixed(4)} on ${mf.nav_date}). Existing holders can redeem; no new orders accepted.`,
        severity: "warning",
      });
    } else if (recent.length > 1) {
      events.push({
        kind: "termination",
        text: `⚠ ${recent.length} funds wound up recently. Check Markets → Mutual Funds for the active universe.`,
        severity: "warning",
      });
    }
  } catch (_) {
    // INSTRUMENTS may not be loaded yet on first paint; the marquee
    // re-mounts on universe-loaded so we'll catch it next pass.
  }

  return events;
}

let _mounted = false;
let _root = null;

export function mountEventMarquee() {
  if (_mounted) { _refresh(); return; }
  _mounted = true;
  // Insert before the nav header. Defer one tick so index.html's body
  // is fully parsed before we touch it.
  queueMicrotask(() => {
    const nav = document.getElementById("nav-root");
    if (!nav || !nav.parentNode) return;
    _root = document.createElement("div");
    _root.id = "event-marquee-root";
    _root.style.cssText = "display:none;";  // hidden until events exist
    nav.parentNode.insertBefore(_root, nav);
    _refresh();
    // Re-poll when the universe finishes loading so a late-arriving MF
    // termination surfaces on this mount instead of the next.
    window.addEventListener("ss:mf-universe-loaded", _refresh);
    window.addEventListener("ss:universe-loaded", _refresh);
    // Re-evaluate on hashchange (date might have crossed midnight if the
    // user keeps the tab open through midnight IST).
    window.addEventListener("ss:navigate", _refresh);
  });
}

function _refresh() {
  if (!_root) return;
  const events = getActiveEvents();
  if (events.length === 0) {
    _root.style.display = "none";
    _root.innerHTML = "";
    return;
  }
  _root.style.display = "";
  // Concatenate events into one long marquee track. Each gets a separator
  // so the eye can break between them as they scroll past.
  const SEP = " • ";
  const text = events.map(e => e.text).join(SEP);
  // Repeat the text so the loop appears continuous as it scrolls.
  // Without the repeat, there's a visible gap when the first copy exits
  // the viewport before the next starts.
  const repeated = text + SEP + text;
  const severity = events.some(e => e.severity === "warning") ? "warning" : "info";
  _root.innerHTML = `
    <div class="event-marquee event-marquee--${severity}" role="status" aria-live="polite">
      <div class="event-marquee-track">${escapeHtml(repeated)}</div>
    </div>
  `;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}
