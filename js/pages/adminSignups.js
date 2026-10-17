// =============================================================================
// Admin → Signups tab.
//
// One call (op=admin-signup-stats → admin_signup_stats() in Postgres) brings
// every number; everything else (ranges, weeks, months, running totals,
// rolling sums, averages, forecasts) is worked out here from those series.
// All days and hours are Indian time.
//
// Live: while this tab is on screen and the browser tab is visible, the total
// is checked every 10 s (~1 KB each). When it moves, the full stats reload at
// most once a minute. Nothing runs once you leave the tab.
// =============================================================================

import { xyChart, heatmap, barList, escapeHtml, fmtInt } from "./adminCharts.js";

const LIVE_MS = 10_000;
const STATS_MIN_GAP_MS = 60_000;
const STATS_MAX_AGE_MS = 5 * 60_000;
const PREF_KEY = "ss.adminSignupsPrefs.v1";

const C = {
  brand: "var(--brand)",
  avg: "#F2994A",
  prev: "#8B93A7",
  blue: "#4C8DF6",
  purple: "#9B6CF0",
  pink: "#E3609B",
};

const st = {
  stats: null, error: null, loading: false, statsAt: 0,
  count: null, countAt: 0, openedCount: null, liveErr: null,
  timer: null, charts: [],
  prefs: loadPrefs(),
};

function loadPrefs() {
  const d = { range: "30d", gran: "day", cumulative: false, avg: true, metric: "dau" };
  try { return { ...d, ...(JSON.parse(localStorage.getItem(PREF_KEY) || "{}")) }; } catch { return d; }
}
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(st.prefs)); } catch {} }

// ---------------------------------------------------------------------------
// Dates. Series labels are Indian wall-clock times; they are handled as UTC
// values internally so no conversion ever shifts them.
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_MON = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dayMs = 86_400_000, hourMs = 3_600_000;

const parseDay = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const parseHour = s => parseDay(s) + (+s.slice(11, 13)) * hourMs;
const isoDay = t => new Date(t).toISOString().slice(0, 10);
function hr12(h) { return `${h % 12 || 12} ${h < 12 ? "am" : "pm"}`; }
function fmtDay(t, withDow = true) { const d = new Date(t); return `${withDow ? DOW[d.getUTCDay()] + " " : ""}${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; }
function fmtDayY(t) { const d = new Date(t); return `${fmtDay(t)} ${d.getUTCFullYear()}`; }
function fmtHourSlot(t) { const d = new Date(t); return `${fmtDay(t)}, ${hr12(d.getUTCHours())}–${hr12((d.getUTCHours() + 1) % 24)}`; }
// Real instants (record end times) shown in Indian time.
function fmtInstant(iso) {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function pctChange(cur, prev) {
  if (!prev) return cur ? { txt: "new", cls: "positive" } : { txt: "—", cls: "dim" };
  const p = (100 * (cur - prev)) / prev;
  const txt = `${p >= 0 ? "▲" : "▼"} ${Math.abs(p) >= 100 ? Math.round(Math.abs(p)).toLocaleString("en-IN") : Math.abs(p).toFixed(1)}%`;
  return { txt, cls: p >= 0 ? "positive" : "negative" };
}

// ---------------------------------------------------------------------------
// Data shaping
function series() {
  const s = st.stats;
  const d0 = parseDay(s.daily.start);
  const days = s.daily.n.map((n, i) => ({ t: d0 + i * dayMs, n }));
  const h0 = parseHour(s.hourly.start);
  const hours = s.hourly.n.map((n, i) => ({ t: h0 + i * hourMs, n }));
  return { days, hours, total: days.reduce((a, b) => a + b.n, 0) };
}

function groupDays(days, keyFn) {
  const out = [];
  for (const d of days) {
    const k = keyFn(d.t);
    const last = out[out.length - 1];
    if (last && last.k === k) last.n += d.n;
    else out.push({ k, t: k, n: d.n });
  }
  return out;
}
const weekKey = t => { const wd = (new Date(t).getUTCDay() + 6) % 7; return t - wd * dayMs; };
const monthKey = t => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };

const RANGES = [
  { id: "48h", label: "48 hours", hours: 48 },
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
  { id: "all", label: "All time", days: Infinity },
];
const GRANS = [
  { id: "hour", label: "Hourly" },
  { id: "day", label: "Daily" },
  { id: "week", label: "Weekly" },
  { id: "month", label: "Monthly" },
];
function gransFor(range) {
  if (range === "48h") return ["hour"];
  if (range === "7d") return ["hour", "day"];
  if (range === "30d") return ["hour", "day", "week"];
  return ["day", "week", "month"];
}

function mainSeries() {
  const { days, hours, total } = series();
  const { range, gran } = st.prefs;
  const r = RANGES.find(x => x.id === range) || RANGES[2];
  let pts, fmtTick, fmtTip, unit;
  if (gran === "hour") {
    const n = r.hours || Math.min(hours.length, r.days * 24);
    pts = hours.slice(-n);
    fmtTick = t => { const d = new Date(t); const h = d.getUTCHours(); return h === 0 ? fmtDay(t, false) : n <= 48 ? hr12(h) : ""; };
    fmtTip = fmtHourSlot;
    unit = "hour";
  } else {
    const win = Number.isFinite(r.days) ? days.slice(-r.days) : days;
    if (gran === "day") {
      pts = win;
      fmtTick = t => fmtDay(t, false);
      fmtTip = t => fmtDayY(t) + (t === days[days.length - 1].t ? " (so far)" : "");
      unit = "day";
    } else if (gran === "week") {
      pts = groupDays(win, weekKey);
      fmtTick = t => fmtDay(t, false);
      fmtTip = t => `Week of ${fmtDayY(t)}`;
      unit = "week";
    } else {
      pts = groupDays(win, monthKey);
      fmtTick = t => { const d = new Date(t); return `${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`; };
      fmtTip = t => { const d = new Date(t); return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
      unit = "month";
    }
  }
  const values = pts.map(p => p.n);
  // Running total: everything before the window, then add as we go.
  const before = total - values.reduce((a, b) => a + b, 0);
  let run = before;
  const cumulative = values.map(v => (run += v));
  // Trailing 7-day average uses days before the window too.
  let avg = null;
  if (gran === "day") {
    const idx0 = days.length - pts.length;
    avg = pts.map((_, i) => {
      const end = idx0 + i;
      if (end === days.length - 1) return null;   // today is not over yet
      const slice = days.slice(Math.max(0, end - 6), end + 1);
      return slice.length < 7 ? null : Math.round((slice.reduce((a, b) => a + b.n, 0) / 7) * 10) / 10;
    });
  }
  return { pts, values, cumulative, avg, fmtTick, fmtTip, unit };
}

// ---------------------------------------------------------------------------
// Rendering
export function renderSignupsTab(host, { adminGet, onOpenUser }) {
  st.host = host;
  st.adminGet = adminGet;
  st.onOpenUser = onOpenUser;
  if (st.openedCount == null && st.count != null) st.openedCount = st.count;
  paint();
  if (!st.stats || Date.now() - st.statsAt > STATS_MAX_AGE_MS) loadStats();
  startLive();
}

async function loadStats() {
  if (st.loading) return;
  st.loading = true;
  try {
    st.stats = await st.adminGet("/api/ai?op=admin-signup-stats");
    st.statsAt = Date.now();
    st.error = null;
    const total = st.stats.totals?.total;
    if (total != null && (st.count == null || total > st.count)) { st.count = total; st.countAt = Date.now(); }
    if (st.openedCount == null) st.openedCount = st.count;
  } catch (e) {
    st.error = e.message || String(e);
  } finally {
    st.loading = false;
    if (mounted()) paint();
  }
}

const mounted = () => !!(st.host && st.host.isConnected && st.host.querySelector(".sg-root"));

function startLive() {
  if (st.timer) return;
  st.timer = setInterval(liveTick, LIVE_MS);
  document.addEventListener("visibilitychange", onVis);
}
function stopLive() {
  clearInterval(st.timer);
  st.timer = null;
  document.removeEventListener("visibilitychange", onVis);
}
function onVis() { if (!document.hidden) liveTick(); }

async function liveTick() {
  if (!st.host || !st.host.isConnected || !st.host.querySelector(".sg-root")) { stopLive(); return; }
  if (document.hidden) return;
  try {
    const r = await st.adminGet("/api/ai?op=admin-signup-count");
    const prev = st.count;
    st.count = r.count;
    st.countAt = Date.now();
    st.liveErr = null;
    if (st.openedCount == null) st.openedCount = r.count;
    paintLive(prev != null && r.count > prev ? r.count - prev : 0);
    const stale = Date.now() - st.statsAt;
    if ((prev != null && r.count !== prev && stale > STATS_MIN_GAP_MS) || stale > STATS_MAX_AGE_MS) loadStats();
  } catch (e) {
    st.liveErr = e.message || String(e);
    paintLive(0);
  }
}

function paintLive(jump) {
  const el = st.host?.querySelector("#sg-live");
  if (!el) return;
  el.querySelector(".sg-big").textContent = st.count == null ? "…" : fmtInt(st.count);
  const tot = st.host.querySelector("#sg-total");
  if (tot && st.count != null) tot.textContent = fmtInt(st.count);
  const since = st.count != null && st.openedCount != null ? st.count - st.openedCount : 0;
  el.querySelector(".sg-since").textContent = since > 0 ? `+${fmtInt(since)} since you opened this tab` : "no new signups since you opened this tab";
  el.querySelector(".sg-checked").innerHTML = st.liveErr
    ? `<span style="color:var(--negative)">live check failed: ${escapeHtml(st.liveErr)}</span>`
    : `<span class="sg-dot"></span> live · checked ${new Date(st.countAt || Date.now()).toLocaleTimeString("en-IN")} · every ${LIVE_MS / 1000}s`;
  if (jump > 0) {
    const chip = el.querySelector(".sg-jump");
    chip.textContent = `+${jump} just now`;
    chip.classList.remove("on"); void chip.offsetWidth; chip.classList.add("on");
  }
}

function destroyCharts() { st.charts.forEach(c => c.destroy?.()); st.charts = []; }

function paint() {
  const host = st.host;
  destroyCharts();
  ensureStyle();
  if (!st.stats) {
    host.innerHTML = `<div class="sg-root">${liveCard()}<div class="card" style="margin-top:12px">${st.error
      ? `<div style="color:var(--negative)">${escapeHtml(st.error)}</div><button class="btn btn-ghost btn-sm" id="sg-retry" style="margin-top:12px">Retry</button>`
      : `<div class="muted">Loading signup history…</div>`}</div></div>`;
    host.querySelector("#sg-retry")?.addEventListener("click", () => { st.error = null; paint(); loadStats(); });
    paintLive(0);
    return;
  }
  const s = st.stats;
  const { days, hours, total } = series();
  const scroll = window.scrollY;

  host.innerHTML = `<div class="sg-root">
    ${liveCard()}
    ${st.error ? `<div class="card" style="margin-top:12px;color:var(--negative)">Last refresh failed: ${escapeHtml(st.error)} (showing data from ${new Date(st.statsAt).toLocaleTimeString("en-IN")})</div>` : ""}

    <h3 class="sg-h">Rolling windows <span class="dim text-sm">vs the same length just before it</span></h3>
    <div class="sg-tiles">${windowTiles(s, total)}</div>

    <h3 class="sg-h">Calendar <span class="dim text-sm">Indian time</span></h3>
    <div class="sg-tiles">${calendarTiles(s, days)}</div>

    <h3 class="sg-h">Records and pace</h3>
    <div class="sg-tiles">${recordTiles(s, days, total)}</div>

    <div class="card sg-card">
      <div class="sg-card-head">
        <h3>Signups over time</h3>
        <div class="sg-controls">
          <div class="sg-seg" id="sg-range">${RANGES.map(r => `<button data-v="${r.id}" class="${st.prefs.range === r.id ? "on" : ""}">${r.label}</button>`).join("")}</div>
          <div class="sg-seg" id="sg-gran">${GRANS.map(g => `<button data-v="${g.id}" class="${st.prefs.gran === g.id ? "on" : ""}" ${gransFor(st.prefs.range).includes(g.id) ? "" : "disabled"}>${g.label}</button>`).join("")}</div>
          <button class="sg-toggle ${st.prefs.cumulative ? "on" : ""}" id="sg-cum" aria-pressed="${st.prefs.cumulative}">Running total</button>
          ${st.prefs.gran === "day" && !st.prefs.cumulative ? `<button class="sg-toggle ${st.prefs.avg ? "on" : ""}" id="sg-avg" aria-pressed="${st.prefs.avg}">7-day average</button>` : ""}
        </div>
      </div>
      <div id="sg-main" style="margin-top:8px"></div>
      <div class="dim text-xs" id="sg-main-note" style="margin-top:4px"></div>
    </div>

    <div class="sg-grid2">
      <div class="card sg-card">
        <div class="sg-card-head"><h3>Rolling 24 hours</h3><span class="dim text-sm">signups in the 24 h up to each hour, last 30 days</span></div>
        <div id="sg-roll24"></div>
      </div>
      <div class="card sg-card">
        <div class="sg-card-head"><h3>Rolling 7 days</h3><span class="dim text-sm">signups in the 7 days up to each day</span></div>
        <div id="sg-roll7"></div>
      </div>
    </div>

    <div class="sg-grid2">
      <div class="card sg-card">
        <div class="sg-card-head"><h3>Time of day</h3><span class="dim text-sm">share of signups per clock hour</span></div>
        <div id="sg-hod"></div>
      </div>
      <div class="card sg-card">
        <div class="sg-card-head"><h3>Day of week</h3><span class="dim text-sm">all time</span></div>
        <div id="sg-dow"></div>
      </div>
    </div>

    <div class="card sg-card">
      <div class="sg-card-head"><h3>When people sign up</h3><span class="dim text-sm">day × hour, last 30 days · darker = more</span></div>
      <div id="sg-heat"></div>
    </div>

    <div class="sg-grid2">
      <div class="card sg-card">
        <div class="sg-card-head"><h3>Top 10 days</h3></div>
        ${rankTable(s.topDays.map(([d, n]) => [fmtDayY(parseDay(d)), n]), "Day")}
      </div>
      <div class="card sg-card">
        <div class="sg-card-head"><h3>Top 10 hours</h3></div>
        ${rankTable(s.topHours.map(([h, n]) => [fmtHourSlot(parseHour(h)) + " " + new Date(parseHour(h)).getUTCFullYear(), n]), "Hour")}
      </div>
    </div>

    <div class="card sg-card">
      <div class="sg-card-head"><h3>From signup to using the app</h3><span class="dim text-sm">all ${fmtInt(s.totals.total)} accounts</span></div>
      ${funnel(s.totals)}
    </div>

    <div class="card sg-card">
      <div class="sg-card-head">
        <h3>Usage per day</h3>
        <div class="sg-seg" id="sg-metric">${METRICS.map(m => `<button data-v="${m.id}" class="${st.prefs.metric === m.id ? "on" : ""}">${m.label}</button>`).join("")}</div>
      </div>
      <div id="sg-act" style="margin-top:8px"></div>
      <div class="dim text-xs" style="margin-top:4px">${escapeHtml((METRICS.find(m => m.id === st.prefs.metric) || METRICS[0]).hint)}</div>
    </div>

    <div class="sg-grid3">
      <div class="card sg-card"><div class="sg-card-head"><h3>Age</h3></div>${barList(s.ages, { total })}</div>
      <div class="card sg-card"><div class="sg-card-head"><h3>Risk style picked</h3></div>${barList(s.risk, { total })}</div>
      <div class="card sg-card"><div class="sg-card-head"><h3>Sign-up method</h3></div>${barList([["Email + password", s.totals.emailProvider], ["Google", s.totals.google]], { total })}</div>
      <div class="card sg-card"><div class="sg-card-head"><h3>Top schools (as typed)</h3></div>${barList(s.schools, { total })}</div>
      <div class="card sg-card"><div class="sg-card-head"><h3>Email domains</h3></div>${barList(s.domains, { total })}</div>
      ${s.cities.length >= 3 ? `<div class="card sg-card"><div class="sg-card-head"><h3>Top cities</h3></div>${barList(s.cities, { total })}</div>` : ""}
    </div>

    <div class="card sg-card">
      <div class="sg-card-head"><h3>Latest 50 signups</h3><span class="dim text-sm">click a row for the full profile</span></div>
      ${recentTable(s.recent)}
    </div>

    <div class="card sg-card">
      <div class="sg-card-head"><h3>Every day since launch</h3>
        <div class="flex gap-2"><button class="btn btn-ghost btn-sm" id="sg-csv-d">Download daily CSV</button><button class="btn btn-ghost btn-sm" id="sg-csv-h">Download hourly CSV (30 days)</button></div>
      </div>
      ${allDaysTable(days)}
    </div>

    <div class="dim text-xs" style="margin:12px 0 24px">Stats worked out ${new Date(st.statsAt).toLocaleTimeString("en-IN")} · first signup ${fmtInstant(s.totals.firstAt)} · latest ${fmtInstant(s.totals.lastAt)} (${ago(s.totals.lastAt)}) · <a href="#" id="sg-reload">reload now</a></div>
  </div>`;

  paintLive(0);
  drawMain();
  drawRolling(days, hours);
  drawClock(s);
  drawActivity(s);
  wire();
  window.scrollTo(0, scroll);
}

function liveCard() {
  return `<div class="card sg-live" id="sg-live">
    <div>
      <div class="dim text-sm">Students signed up</div>
      <div class="sg-big tabular">…</div>
      <div class="sg-since dim text-sm"></div>
    </div>
    <div class="sg-live-right">
      <span class="sg-jump"></span>
      <div class="sg-checked dim text-xs"></div>
    </div>
  </div>`;
}

function tile(label, value, sub = "", cls = "") {
  return `<div class="stat-tile sg-tile ${cls}"><div class="l">${label}</div><div class="v tabular">${value}</div>${sub ? `<div class="sg-sub">${sub}</div>` : ""}</div>`;
}
function vs(cur, prev, what) {
  const c = pctChange(cur, prev);
  return `<span class="${c.cls}">${c.txt}</span> <span class="dim">vs ${fmtInt(prev)} ${what}</span>`;
}

function windowTiles(s, total) {
  const W = s.windows;
  const lab = { "1h": "Last 60 min", "6h": "Last 6 hours", "24h": "Last 24 hours", "48h": "Last 48 hours", "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days" };
  const prevLab = { "1h": "the hour before", "6h": "6 h before", "24h": "24 h before", "48h": "48 h before", "7d": "7 days before", "30d": "30 days before", "90d": "90 days before" };
  return ["1h", "6h", "24h", "48h", "7d", "30d", "90d"].map(k => {
    const [cur, prev] = W[k] || [0, 0];
    return tile(lab[k], fmtInt(cur), vs(cur, prev, prevLab[k]));
  }).join("") + tile("Since launch", `<span id="sg-total">${fmtInt(Math.max(total, st.count || 0))}</span>`, `${fmtInt(daysSince(s.totals.firstAt))} days · ${(total / Math.max(1, daysSince(s.totals.firstAt))).toFixed(1)}/day on average`);
}
const daysSince = iso => Math.max(1, Math.floor((Date.now() - Date.parse(iso)) / dayMs));

function calendarTiles(s, days) {
  const c = s.calendar;
  return [
    tile("Today so far", fmtInt(c.today), vs(c.today, c.yesterdaySameTime, "yesterday by now")),
    tile("Yesterday", fmtInt(c.yesterday), vs(c.yesterday, days.length > 2 ? days[days.length - 3].n : 0, "the day before")),
    tile("Same day last week", fmtInt(c.weekAgoDay), `<span class="dim">${fmtInt(c.weekAgoSameTime)} by this time</span>`),
    tile("This week (Mon–)", fmtInt(c.thisWeek), vs(c.thisWeek, c.lastWeekToDate, "last week by now")),
    tile("Last week", fmtInt(c.lastWeek)),
    tile("This month", fmtInt(c.thisMonth), vs(c.thisMonth, c.lastMonthToDate, "last month by now")),
    tile("Last month", fmtInt(c.lastMonth)),
  ].join("");
}

function recordTiles(s, days, total) {
  const R = s.records;
  const best = s.topDays[0];
  const bestHour = s.topHours[0];
  const hod = s.hourOfDay;
  const peakH = hod.indexOf(Math.max(...hod));
  const wd = s.weekday;
  const peakW = wd.indexOf(Math.max(...wd));
  const last7 = days.slice(-7).reduce((a, b) => a + b.n, 0);
  // Pace from the last 7 full days (today is still running).
  const full7 = days.slice(-8, -1).reduce((a, b) => a + b.n, 0) / 7;
  const zeroStreak = (() => { let k = 0; for (let i = days.length - 1; i >= 0 && days[i].n > 0; i--) k++; return k; })();
  const hundredStreak = (() => { let k = 0; for (let i = days.length - 2; i >= 0 && days[i].n >= 100; i--) k++; return k; })();
  const milestones = [1000, 2000, 2500, 5000, 10000, 25000, 50000, 100000].filter(m => m > total).slice(0, 3);
  const nowIst = parseDay(s.nowIst.slice(0, 10));
  const fc = milestones.map(m => {
    const d = full7 > 0 ? Math.ceil((m - total) / full7) : null;
    return `${fmtInt(m)}: ${d == null ? "—" : `~${fmtDay(nowIst + d * dayMs)} (${d} d)`}`;
  }).join("<br>");
  return [
    tile("Best day", best ? fmtInt(best[1]) : "—", best ? fmtDayY(parseDay(best[0])) : ""),
    tile("Best clock hour", bestHour ? fmtInt(bestHour[1]) : "—", bestHour ? fmtHourSlot(parseHour(bestHour[0])) : ""),
    tile("Best 60 minutes", R.best1h ? fmtInt(R.best1h[0]) : "—", R.best1h ? `ending ${fmtInstant(R.best1h[1])}` : ""),
    tile("Best 24 hours", R.best24h ? fmtInt(R.best24h[0]) : "—", R.best24h ? `ending ${fmtInstant(R.best24h[1])}` : ""),
    tile("Best 7 days", R.best7d ? fmtInt(R.best7d[0]) : "—", R.best7d ? `ending ${fmtInstant(R.best7d[1])}` : ""),
    tile("Busiest hour of day", hr12(peakH), `${fmtInt(hod[peakH])} signups all time (${(100 * hod[peakH] / Math.max(1, total)).toFixed(1)}%)`),
    tile("Busiest weekday", DOW_MON[peakW], `${fmtInt(wd[peakW])} signups all time`),
    tile("Average per day", full7.toFixed(1), `last 7 full days · ${fmtInt(last7)} in the last 7 incl. today`),
    tile("Days in a row with a signup", fmtInt(zeroStreak), hundredStreak ? `${hundredStreak} full days in a row with 100+` : ""),
    tile("At this pace", "", fc || "—", "sg-tile-fc"),
  ].join("");
}

function rankTable(rows, what) {
  if (!rows.length) return `<div class="muted text-sm">No data yet.</div>`;
  const max = Math.max(...rows.map(r => r[1]));
  return `<table class="admin-table sg-rank"><thead><tr><th>#</th><th>${what}</th><th style="text-align:right">Signups</th></tr></thead><tbody>
    ${rows.map(([lab, n], i) => `<tr><td class="dim">${i + 1}</td><td>${escapeHtml(lab)}</td><td class="tabular" style="text-align:right"><span class="sg-inline-bar" style="width:${(60 * n / max).toFixed(0)}px"></span>${fmtInt(n)}</td></tr>`).join("")}
  </tbody></table>`;
}

function funnel(t) {
  const steps = [
    ["Signed up", t.total, "made an account"],
    ["Confirmed email", t.confirmed, "clicked the link in the email (Google counts as confirmed)"],
    ["Finished setup", t.onboarded, "completed the first-run questions"],
    ["Used the AI coach", t.coached, "at least one coach message"],
    ["Made a trade", t.traded, "at least one buy or sell"],
    ["Came back another day", t.returned, "seen on a later day than the signup day (tracking started 14 Sep)"],
  ];
  return `<div class="sg-funnel">${steps.map(([lab, n, hint]) => `
    <div class="sg-f-row" title="${escapeHtml(hint)}">
      <div class="sg-f-lab">${lab}</div>
      <div class="sg-f-track"><div class="sg-f-fill" style="width:${(100 * n / Math.max(1, t.total)).toFixed(1)}%"></div></div>
      <div class="sg-f-num tabular">${fmtInt(n)} <span class="dim">${(100 * n / Math.max(1, t.total)).toFixed(1)}%</span></div>
    </div>`).join("")}</div>`;
}

function recentTable(rows) {
  return `<div class="admin-table-wrap" style="max-height:460px;overflow:auto"><table class="admin-table">
    <thead><tr><th>When</th><th>Username</th><th>Name</th><th>Age</th><th>School</th><th>Method</th><th>Email ok</th><th>Setup done</th></tr></thead>
    <tbody>${rows.map(r => `<tr data-uid="${escapeHtml(r.id)}" style="cursor:pointer">
      <td class="text-xs" title="${escapeHtml(fmtInstant(r.ts))}">${escapeHtml(ago(r.ts))}<div class="dim">${escapeHtml(fmtInstant(r.ts))}</div></td>
      <td>@${escapeHtml(r.username || "?")}</td>
      <td>${escapeHtml(r.name || "")}</td>
      <td class="tabular">${r.age ?? "—"}</td>
      <td class="text-xs">${escapeHtml(r.school || "—")}</td>
      <td>${r.provider === "google" ? "Google" : "Email"}</td>
      <td>${r.confirmed ? "✓" : `<span class="dim">no</span>`}</td>
      <td>${r.onboarded ? "✓" : `<span class="dim">no</span>`}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

function allDaysTable(days) {
  const rows = days.slice().reverse();
  let run = days.reduce((a, b) => a + b.n, 0);
  return `<div class="admin-table-wrap" style="max-height:360px;overflow:auto"><table class="admin-table">
    <thead><tr><th>Day</th><th style="text-align:right">Signups</th><th style="text-align:right">Total after the day</th></tr></thead>
    <tbody>${rows.map(d => { const tot = run; run -= d.n; return `<tr><td>${fmtDayY(d.t)}</td><td class="tabular" style="text-align:right">${fmtInt(d.n)}</td><td class="tabular dim" style="text-align:right">${fmtInt(tot)}</td></tr>`; }).join("")}</tbody>
  </table></div>`;
}

const METRICS = [
  { id: "dau", label: "Active users", key: "dau", hint: "Different signed-in people who opened the app that day (tracking started 14 Sep)." },
  { id: "views", label: "Page views", key: "views", hint: "Pages opened by signed-in people." },
  { id: "trades", label: "Trades", key: "trades", hint: "Buys and sells filled that day." },
  { id: "traders", label: "People trading", key: "traders", hint: "Different people with at least one trade that day." },
  { id: "coach", label: "Coach messages", key: "coach", hint: "Messages in the AI coach (both sides)." },
];

function drawMain() {
  const el = st.host.querySelector("#sg-main");
  const m = mainSeries();
  const ser = [];
  if (st.prefs.cumulative) {
    ser.push({ name: "Total accounts", values: m.cumulative, color: C.brand, kind: "area" });
  } else {
    ser.push({ name: `Signups per ${m.unit}`, values: m.values, color: C.brand, kind: "bar" });
    if (m.avg && st.prefs.avg) ser.push({ name: "7-day average", values: m.avg, color: C.avg, kind: "line" });
  }
  const lastIdx = m.pts.length - 1;
  st.charts.push(xyChart(el, {
    labels: m.pts.map(p => p.t), series: ser, height: 260,
    xTick: i => m.fmtTick(m.pts[i].t), tip: i => m.fmtTip(m.pts[i].t),
    faded: i => i === lastIdx && !st.prefs.cumulative,
  }));
  const sum = m.values.reduce((a, b) => a + b, 0);
  const peak = Math.max(0, ...m.values);
  const pi = m.values.indexOf(peak);
  st.host.querySelector("#sg-main-note").textContent =
    `${fmtInt(sum)} signups in this view · peak ${fmtInt(peak)} (${pi >= 0 ? m.fmtTip(m.pts[pi].t) : "—"}) · average ${(sum / Math.max(1, m.values.length)).toFixed(1)} per ${m.unit} · last bar is still running`;
}

function drawRolling(days, hours) {
  const r24 = hours.map((_, i) => i < 23 ? null : hours.slice(i - 23, i + 1).reduce((a, b) => a + b.n, 0));
  const off = 23;
  const h = hours.slice(off);
  st.charts.push(xyChart(st.host.querySelector("#sg-roll24"), {
    labels: h.map(x => x.t), series: [{ name: "Signups in the 24 h before", values: r24.slice(off), color: C.blue, kind: "area" }],
    height: 200, legend: false,
    xTick: i => new Date(h[i].t).getUTCHours() === 0 ? fmtDay(h[i].t, false) : "",
    tip: i => { const end = h[i].t + hourMs; return `24 h up to ${fmtDay(end)}, ${hr12(new Date(end).getUTCHours())}`; },
  }));
  const r7 = days.map((_, i) => i < 6 ? null : days.slice(i - 6, i + 1).reduce((a, b) => a + b.n, 0));
  const d = days.slice(-90), rv = r7.slice(-90);
  st.charts.push(xyChart(st.host.querySelector("#sg-roll7"), {
    labels: d.map(x => x.t), series: [{ name: "Signups in the 7 days up to this day", values: rv, color: C.purple, kind: "area" }],
    height: 200, legend: false,
    xTick: i => fmtDay(d[i].t, false), tip: i => `7 days up to ${fmtDayY(d[i].t)}${i === d.length - 1 ? " (so far)" : ""}`,
  }));
}

function drawClock(s) {
  const totAll = s.hourOfDay.reduce((a, b) => a + b, 0) || 1;
  const tot7 = s.hourOfDay7d.reduce((a, b) => a + b, 0) || 1;
  const hrs = [...Array(24).keys()];
  st.charts.push(xyChart(st.host.querySelector("#sg-hod"), {
    labels: hrs,
    series: [
      { name: "All time", values: s.hourOfDay.map(v => (100 * v) / totAll), color: C.brand, kind: "bar" },
      { name: "Last 7 days", values: s.hourOfDay7d.map(v => (100 * v) / tot7), color: C.avg, kind: "bar" },
    ],
    height: 210, integer: false, yFmt: v => v.toFixed(1) + "%",
    xTick: i => (i % 3 === 0 ? hr12(i) : ""),
    tip: i => `${hr12(i)}–${hr12((i + 1) % 24)} · ${fmtInt(s.hourOfDay[i])} all time, ${fmtInt(s.hourOfDay7d[i])} last 7 days`,
  }));
  st.charts.push(xyChart(st.host.querySelector("#sg-dow"), {
    labels: DOW_MON, series: [{ name: "Signups", values: s.weekday, color: C.pink, kind: "bar" }],
    height: 210, legend: false, xTick: i => DOW_MON[i], tip: i => DOW_MON[i],
  }));
  heatmap(st.host.querySelector("#sg-heat"), {
    rowLabels: DOW_MON, colLabels: hrs.map(h => hr12(h).replace(" ", "")), values: s.heat,
    tip: (r, c, v) => `${DOW_MON[r]} ${hr12(c)}–${hr12((c + 1) % 24)}: ${v} signup${v === 1 ? "" : "s"}`,
  });
}

function drawActivity(s) {
  const a = s.activity;
  const metric = METRICS.find(m => m.id === st.prefs.metric) || METRICS[0];
  const vals = a[metric.key];
  // Skip the empty run before tracking started.
  let first = vals.findIndex(v => v > 0);
  if (first < 0) first = 0;
  const t0 = parseDay(a.start);
  const ts = vals.map((_, i) => t0 + i * dayMs).slice(first);
  const v = vals.slice(first);
  // Today is not over yet, so it gets no average point.
  const avg = v.map((_, i) => i < 6 || i === v.length - 1 ? null : Math.round(v.slice(i - 6, i + 1).reduce((x, y) => x + y, 0) / 7 * 10) / 10);
  st.charts.push(xyChart(st.host.querySelector("#sg-act"), {
    labels: ts,
    series: [
      { name: metric.label, values: v, color: C.blue, kind: "bar" },
      { name: "7-day average", values: avg, color: C.avg, kind: "line" },
    ],
    height: 240, xTick: i => fmtDay(ts[i], false), tip: i => fmtDayY(ts[i]) + (i === ts.length - 1 ? " (so far)" : ""),
    faded: i => i === ts.length - 1,
  }));
}

function wire() {
  const h = st.host;
  h.querySelectorAll("#sg-range button").forEach(b => b.addEventListener("click", () => {
    st.prefs.range = b.dataset.v;
    const ok = gransFor(st.prefs.range);
    if (!ok.includes(st.prefs.gran)) st.prefs.gran = ok.includes("day") ? "day" : ok[0];
    savePrefs(); paint();
  }));
  h.querySelectorAll("#sg-gran button").forEach(b => b.addEventListener("click", () => {
    if (b.disabled) return;
    st.prefs.gran = b.dataset.v; savePrefs(); paint();
  }));
  h.querySelector("#sg-cum")?.addEventListener("click", () => { st.prefs.cumulative = !st.prefs.cumulative; savePrefs(); paint(); });
  h.querySelector("#sg-avg")?.addEventListener("click", () => { st.prefs.avg = !st.prefs.avg; savePrefs(); paint(); });
  h.querySelectorAll("#sg-metric button").forEach(b => b.addEventListener("click", () => { st.prefs.metric = b.dataset.v; savePrefs(); paint(); }));
  h.querySelectorAll("tr[data-uid]").forEach(tr => tr.addEventListener("click", () => st.onOpenUser?.(tr.dataset.uid)));
  h.querySelector("#sg-reload")?.addEventListener("click", e => { e.preventDefault(); loadStats(); });
  h.querySelector("#sg-csv-d")?.addEventListener("click", () => {
    const { days } = series();
    let run = 0;
    download("signups-daily.csv", "day_ist,signups,total_after\n" + days.map(d => `${isoDay(d.t)},${d.n},${(run += d.n)}`).join("\n"));
  });
  h.querySelector("#sg-csv-h")?.addEventListener("click", () => {
    const { hours } = series();
    download("signups-hourly-30d.csv", "hour_ist,signups\n" + hours.map(x => `${new Date(x.t).toISOString().slice(0, 13)}:00,${x.n}`).join("\n"));
  });
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------------------
function ensureStyle() {
  if (document.getElementById("admin-signups-style")) return;
  const el = document.createElement("style");
  el.id = "admin-signups-style";
  el.textContent = `
.sg-root { display: flex; flex-direction: column; gap: 0; }
.sg-h { margin: 22px 0 10px; font-size: var(--text-lg); display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.sg-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(178px, 1fr)); gap: 10px; }
.sg-tile .v { font-size: 1.45rem; }
.sg-sub { font-size: 12px; margin-top: 4px; line-height: 1.4; color: var(--text-muted); }
.sg-tile-fc .v { display: none; }
.sg-tile-fc .sg-sub { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--text); }
.sg-live { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.sg-big { font-family: var(--font-mono, monospace); font-size: clamp(2.4rem, 7vw, 3.6rem); font-weight: 800; line-height: 1.05; color: var(--text-strong); letter-spacing: -0.02em; }
.sg-live-right { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.sg-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--positive); margin-right: 4px; animation: pulse-dot 2s infinite; }
.sg-jump { font-weight: 800; color: var(--positive); opacity: 0; font-size: 1.1rem; }
.sg-jump.on { animation: sg-pop 4s ease-out; }
@keyframes sg-pop { 0% { opacity: 0; transform: translateY(6px); } 10% { opacity: 1; transform: none; } 80% { opacity: 1; } 100% { opacity: 0; } }
.sg-card { margin-top: 12px; }
.sg-card-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.sg-card-head h3 { margin: 0; }
.sg-controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.sg-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; flex-wrap: wrap; }
.sg-seg button { background: transparent; border: 0; padding: 5px 10px; font-size: 12.5px; font-weight: 600; color: var(--text-muted); cursor: pointer; font-family: inherit; }
.sg-seg button + button { border-left: 1px solid var(--border); }
.sg-seg button.on { background: var(--brand); color: #fff; }
.sg-seg button:disabled { opacity: .35; cursor: not-allowed; }
.sg-toggle { border: 1px solid var(--border); background: transparent; color: var(--text-muted); border-radius: 8px; padding: 5px 10px; font-size: 12.5px; font-weight: 600; cursor: pointer; font-family: inherit; }
.sg-toggle::before { content: "○ "; }
.sg-toggle.on { border-color: var(--brand); color: var(--brand); background: color-mix(in srgb, var(--brand) 10%, transparent); }
.sg-toggle.on::before { content: "● "; }
.sg-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 12px; }
.sg-grid2 > .sg-card { margin-top: 12px; }
.sg-grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 12px; }
.sg-grid3 > .sg-card { margin-top: 12px; }
.sg-inline-bar { display: inline-block; height: 8px; background: var(--brand); opacity: .35; border-radius: 4px; margin-right: 8px; vertical-align: middle; }
.sg-funnel { display: flex; flex-direction: column; gap: 8px; }
.sg-f-row { display: grid; grid-template-columns: minmax(120px, 190px) 1fr auto; gap: 10px; align-items: center; font-size: 13px; }
.sg-f-track { height: 16px; background: var(--bg-soft); border-radius: 6px; overflow: hidden; }
.sg-f-fill { height: 100%; background: linear-gradient(90deg, var(--brand), color-mix(in srgb, var(--brand) 60%, #4C8DF6)); border-radius: 6px; }
.sg-f-num { min-width: 110px; text-align: right; font-family: var(--font-mono, monospace); }
@media (max-width: 560px) { .sg-f-row { grid-template-columns: 1fr auto; } .sg-f-track { grid-column: 1 / -1; order: 3; } }
`;
  document.head.appendChild(el);
}
