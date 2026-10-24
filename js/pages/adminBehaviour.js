// =============================================================================
// Admin → Behaviour tab: what visitors do on the site (web_events, recorded by
// js/features/telemetry.js for everyone, signed in or not).
//
// One call (op=admin-behaviour → admin_behaviour_stats()) brings every table;
// the click map loads per page (op=admin-click-map). Reloads every 60 s while
// the tab is on screen and the browser tab is visible.
// =============================================================================

import { xyChart, barList, escapeHtml, fmtInt } from "./adminCharts.js";

const PREF_KEY = "ss.adminBehaviourPrefs.v1";
// How often pg_cron (behaviour-cache) recalculates each range.
const REFRESH = { 1: "every 10 min", 7: "every 30 min", 30: "daily", 90: "daily" };
const RELOAD_MS = 60_000;
const C = { brand: "var(--brand)", blue: "#4C8DF6", avg: "#F2994A", purple: "#9B6CF0", red: "#EB5757" };

const st = {
  data: null, error: null, loading: false, at: 0, timer: null, charts: [],
  map: null, mapKey: "", mapLoading: false,
  prefs: (() => { const d = { days: 7, mapPath: "/", mapDev: "" }; try { return { ...d, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") }; } catch { return d; } })(),
};
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(st.prefs)); } catch {} };
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(a / b < 0.1 ? 1 : 0)}%` : "—");
const secs = (s) => (s == null || s === "" ? "—" : s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);
const ist = (iso) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export function renderBehaviourTab(host, { adminGet }) {
  st.host = host;
  st.adminGet = adminGet;
  paint();
  if (!st.data || Date.now() - st.at > RELOAD_MS) load();
  if (!st.timer) {
    st.timer = setInterval(() => {
      if (!st.host?.isConnected || !st.host.querySelector(".bh-root")) { clearInterval(st.timer); st.timer = null; return; }
      if (!document.hidden) load();
    }, RELOAD_MS);
  }
}

async function load() {
  if (st.loading) return;
  st.loading = true;
  try {
    st.data = await st.adminGet(`/api/ai?op=admin-behaviour&days=${st.prefs.days}`);
    st.at = Date.now();
    st.error = null;
  } catch (e) { st.error = e.message || String(e); }
  finally { st.loading = false; if (st.host?.isConnected) paint(); }
}

async function loadMap() {
  const key = `${st.prefs.mapPath}|${st.prefs.mapDev}|${st.prefs.days}`;
  if (st.mapLoading || (st.map && st.mapKey === key)) return;
  st.mapLoading = true;
  try {
    const q = new URLSearchParams({ op: "admin-click-map", path: st.prefs.mapPath, days: String(st.prefs.days) });
    if (st.prefs.mapDev) q.set("dev", st.prefs.mapDev);
    st.map = (await st.adminGet(`/api/ai?${q}`)).points || [];
    st.mapKey = key;
  } catch (e) { st.map = []; st.mapErr = e.message || String(e); }
  finally { st.mapLoading = false; drawMap(); }
}

function table(head, rows, empty = "Nothing recorded yet.") {
  if (!rows.length) return `<div class="muted text-sm">${empty}</div>`;
  return `<div class="admin-table-wrap" style="max-height:420px;overflow:auto"><table class="admin-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
const card = (title, sub, body, cls = "") => `<div class="card bh-card ${cls}"><div class="bh-head"><h3>${title}</h3>${sub ? `<span class="dim text-sm">${sub}</span>` : ""}</div>${body}</div>`;
const tile = (l, v, sub = "") => `<div class="stat-tile"><div class="l">${l}</div><div class="v tabular">${v}</div>${sub ? `<div class="bh-sub">${sub}</div>` : ""}</div>`;
const e = escapeHtml;

function paint() {
  ensureStyle();
  st.charts.forEach((c) => c.destroy?.());
  st.charts = [];
  const host = st.host;
  const d = st.data;
  const ranges = [[1, "24 hours"], [7, "7 days"], [30, "30 days"], [90, "90 days"]];
  const head = `<div class="bh-top">
    <div class="sg-seg bh-seg" id="bh-days">${ranges.map(([v, l]) => `<button data-v="${v}" class="${st.prefs.days === v ? "on" : ""}">${l}</button>`).join("")}</div>
    <span class="dim text-xs">${st.loading ? "loading…" : st.at ? `${d?.asOf ? `figures from ${new Date(d.asOf).toLocaleTimeString("en-IN")} (recalculated ${REFRESH[d.days] || "regularly"}) · ` : ""}live panel ${new Date(st.at).toLocaleTimeString("en-IN")}, every 60 s` : ""}</span>
  </div>`;
  if (!d) {
    host.innerHTML = `<div class="bh-root">${head}<div class="card">${st.error ? `<span style="color:var(--negative)">${e(st.error)}</span>` : "Loading…"}</div></div>`;
    wire();
    return;
  }
  if (d.pending) {
    host.innerHTML = `<div class="bh-root">${head}<div class="card">These figures are being calculated for the first time in the background (a job runs every 10 minutes). Check back in a few minutes.</div></div>`;
    wire();
    return;
  }
  const t = d.totals || {};
  const f = d.funnel || {};
  const live = d.live || {};
  const steps = [
    ["Visitors", f.visitors, "different browsers seen"],
    ["Opened the sign-up page", f.sawRegister, "/register"],
    ["Started typing in the form", f.startedForm, "first field focused"],
    ["Pressed Create account", f.submittedForm, "form submitted"],
    ["Got to the email-code step", f.sawCode, "code box focused"],
    ["Entered the code", f.submittedCode, "code submitted"],
    ["Account created", f.signedUp, "linked to a tracked browser"],
    ["Reached onboarding", f.reachedOnboarding, "/onboarding"],
  ];
  const fmax = Math.max(1, f.visitors || 0);
  const pages = d.pages || [];
  const mapPaths = [...new Set(["/", ...pages.map((p) => p[0])])];

  host.innerHTML = `<div class="bh-root">
    ${head}
    <div class="card bh-live">
      <div><div class="dim text-sm">On the site right now</div><div class="bh-big tabular">${fmtInt(live.sessions5m || 0)}</div><div class="dim text-sm">sessions active in the last 5 min · ${fmtInt(live.visitors30m || 0)} visitors in the last 30 min</div></div>
      <div class="bh-livepages">${(live.pages || []).map(([p, n]) => `<div><span>${e(p || "/")}</span><b>${n}</b></div>`).join("") || `<span class="dim text-sm">nobody on a page right now</span>`}</div>
    </div>

    <div class="bh-tiles">
      ${tile("Sessions", fmtInt(t.sessions), `${fmtInt(t.signedInSessions)} signed in`)}
      ${tile("Visitors", fmtInt(t.visitors), "different browsers")}
      ${tile("Average visit", secs(t.avgSessionSec), `middle visit ${secs(t.medianSessionSec)}`)}
      ${tile("Pages per visit", t.pagesPerSession ?? "—")}
      ${tile("Left without doing anything", `${t.bouncePct ?? "—"}%`, "one page, no clicks")}
      ${tile("Events recorded", fmtInt(t.events))}
    </div>

    <div class="bh-grid2">
      ${card("Visits per day", "Indian time", `<div id="bh-daily"></div>`)}
      ${card("Average visit length per day", "", `<div id="bh-len"></div>`)}
    </div>
    ${card("Visits by hour of day", "Indian time", `<div id="bh-hour"></div>`)}

    ${card("Sign-up funnel", "each step: how many different visitors got that far", `<div class="sg-funnel">${steps.map(([l, n, h]) => `
      <div class="sg-f-row" title="${e(h)}"><div class="sg-f-lab">${l}</div>
        <div class="sg-f-track"><div class="sg-f-fill" style="width:${((100 * (n || 0)) / fmax).toFixed(1)}%"></div></div>
        <div class="sg-f-num tabular">${fmtInt(n || 0)} <span class="dim">${pct(n || 0, fmax)}</span></div></div>`).join("")}
      <div class="dim text-xs" style="margin-top:6px">Clicked "Continue with Google" on a sign-up or login page: ${fmtInt(f.clickedGoogle || 0)}</div></div>`)}

    <div class="bh-grid2">
      ${card("Where visitors came from", "first visit of each browser · visitors / sign-ups", table(["Source", "Visitors", "Sign-ups", "Rate"], (d.sources || []).map(([s, v, n]) => [e(s), fmtInt(v), fmtInt(n), pct(n, v)])))}
      ${card("Campaign links (utm)", "source / medium / campaign", table(["Campaign", "Visitors", "Sign-ups"], (d.campaigns || []).map(([c, v, n]) => [e(c), fmtInt(v), fmtInt(n)]), "No tagged links used yet. Add ?utm_source=instagram&utm_campaign=… to links you share."))}
      ${card("First page of the visit", "", barList((d.landing || []).map(([p, n]) => [p || "/", n])))}
      ${card("Last page before leaving", "", barList((d.exits || []).map(([p, n]) => [p || "/", n])))}
    </div>

    ${card("Pages", "views, time on page, how far down people scroll", table(["Page", "Views", "Visitors", "Avg time", "Avg scroll", "Reached 75%"],
      pages.map(([p, v, vis, sec, sd, r75]) => [e(p || "/"), fmtInt(v), fmtInt(vis), secs(sec), sd == null ? "—" : `${sd}%`, r75 == null ? "—" : `${r75}%`])))}

    ${card("Click map", "every click on the page, placed where it landed (darker = more)", `
      <div class="bh-mapbar">
        <select id="bh-map-path" class="select">${mapPaths.map((p) => `<option value="${e(p)}" ${p === st.prefs.mapPath ? "selected" : ""}>${e(p || "/")}</option>`).join("")}</select>
        <div class="sg-seg" id="bh-map-dev">${[["", "All"], ["mobile", "Phone"], ["tablet", "Tablet"], ["desktop", "Computer"]].map(([v, l]) => `<button data-v="${v}" class="${st.prefs.mapDev === v ? "on" : ""}">${l}</button>`).join("")}</div>
        <span class="dim text-xs" id="bh-map-n"></span>
      </div>
      <div class="bh-mapwrap"><canvas id="bh-map"></canvas><div class="bh-maptop" id="bh-map-top"></div></div>`)}

    <div class="bh-grid2">
      ${card("Most clicked", "page · what was clicked", table(["Page", "Clicked", "Clicks", "People"], (d.clicks || []).map(([p, tg, n, v]) => [e(p || "/"), e(tg || ""), fmtInt(n), fmtInt(v)])))}
      ${card("Angry clicks", "3+ clicks on the same spot within a second: usually something that looks clickable but isn't, or is slow", table(["Page", "On", "Times", "People"], (d.rage || []).map(([p, tg, n, v]) => [e(p || "/"), e(tg || ""), fmtInt(n), fmtInt(v)]), "None so far."))}
      ${card("Clicks on things that do nothing", "not a link or button", table(["Page", "On", "Clicks"], (d.deadClicks || []).map(([p, tg, n]) => [e(p || "/"), e(tg || ""), fmtInt(n)])))}
      ${card("Links out of the site", "", table(["To", "Clicks"], (d.outbound || []).map(([tg, n]) => [e(tg), fmtInt(n)])))}
    </div>

    ${card("Errors students hit", "script errors, failed promises, files that did not load", table(["Error", "Times", "Visits", "Last", "Mostly on", "Where in code", "Browsers"],
      (d.errors || []).map(([m, n, s, last, p, src, br]) => [`<code>${e(m)}</code>`, fmtInt(n), fmtInt(s), e(ist(last)), e(p || "/"), `<span class="dim text-xs">${e(src || "")}</span>`, e(br || "")]), "No errors recorded. 🎉"))}

    <div class="bh-grid2">
      ${card("Failed or slow requests", "status 0 = no connection; slow = over 2.5 s", table(["Request", "Status", "Times", "Avg ms", "90% under"], (d.api || []).map(([tg, s, n, a, p9]) => [e(tg), e(s), fmtInt(n), fmtInt(a), fmtInt(p9)])))}
      ${card("Pop-up messages shown", "", table(["Kind", "Message", "Times"], (d.toasts || []).map(([k, tg, n]) => [e(k || ""), e(tg || ""), fmtInt(n)])))}
    </div>

    <div class="bh-grid2">
      ${card("Forms", "visits that started / submitted / left half done", table(["Form", "Started", "Submitted", "Left", "Finished"], (d.forms || []).map(([tg, a, b, c]) => [e(tg), fmtInt(a), fmtInt(b), fmtInt(c), pct(b, a)])))}
      ${card("Field people left on", "the field they were on when they gave up", table(["Form", "Field", "Times"], (d.abandonFields || []).map(([tg, fl, n]) => [e(tg), e(fl), fmtInt(n)])))}
      ${card("Time per field", "and how often it was left empty", table(["Form", "Field", "Times", "Avg time", "Left empty"], (d.fieldTimes || []).map(([tg, fl, n, a, emp]) => [e(tg), e(fl || ""), fmtInt(n), secs(a), `${emp}%`])))}
      ${card("Error messages shown in forms", "", table(["Form", "Message", "Times"], (d.formErrors || []).map(([tg, m, n]) => [e(tg), e(m || ""), fmtInt(n)])))}
    </div>

    <div class="bh-grid2">
      ${card("Searches", "what was searched · how often it found nothing", table(["Search", "Times", "People", "No results", "Box"], (d.searches || []).map(([q, n, v, z, src]) => [e(q), fmtInt(n), fmtInt(v), z ? `<b style="color:var(--negative)">${fmtInt(z)}</b>` : "0", e(src || "")])))}
      ${card("Searches that found nothing", "things students want and can't find", barList((d.zeroSearches || []).map(([q, n]) => [q, n]), { color: C.red }))}
    </div>

    ${card("Page speed on students' devices", "75% of visits were this fast or faster · green good, red poor", table(["Page", "Loads", "Server reply", "First paint", "Main content", "Layout shift", "Tap response"],
      (d.perf || []).map(([p, n, ttfb, fcp, lcp, cls, inp]) => [e(p || "/"), fmtInt(n), ms(ttfb, 800, 1800), ms(fcp, 1800, 3000), ms(lcp, 2500, 4000), shift(cls), ms(inp, 200, 500)])))}

    <div class="bh-grid3">
      ${card("Device", "", barList((d.devices?.dev || []).map(([k, n]) => [k, n])))}
      ${card("System", "", barList((d.devices?.os || []).map(([k, n]) => [k, n])))}
      ${card("Browser", "", barList((d.devices?.br || []).map(([k, n]) => [k, n])))}
      ${card("Screen size", "", barList((d.devices?.scr || []).map(([k, n]) => [k, n])))}
      ${card("Language", "", barList((d.devices?.lang || []).map(([k, n]) => [k, n])))}
      ${card("Connection", "", barList((d.devices?.net || []).map(([k, n]) => [k || "unknown", n])))}
      ${card("Theme", "", barList((d.devices?.theme || []).map(([k, n]) => [k, n])))}
      ${card("Installed as an app", "", barList((d.devices?.pwa || []).map(([k, n]) => [k === "1" ? "Yes" : "No", n])))}
      ${card("Country", "", barList((d.devices?.cc || []).map(([k, n]) => [k, n])))}
    </div>

    ${card("Everything recorded, by type", "", barList(Object.entries(d.other || {}).sort((a, b) => b[1] - a[1])))}
  </div>`;
  drawCharts(d);
  wire();
  drawMap();
  loadMap();
}

function ms(v, good, poor) {
  if (v == null || v === "") return "—";
  const c = v <= good ? "var(--positive)" : v >= poor ? "var(--negative)" : "#F2994A";
  return `<span style="color:${c}">${fmtInt(v)} ms</span>`;
}
function shift(v) {
  if (v == null || v === "") return "—";
  const c = v <= 0.1 ? "var(--positive)" : v >= 0.25 ? "var(--negative)" : "#F2994A";
  return `<span style="color:${c}">${v}</span>`;
}

function drawCharts(d) {
  const daily = d.daily || [];
  const lab = (day) => { const [y, m, dd] = day.split("-"); return `${+dd}/${+m}`; };
  st.charts.push(xyChart(st.host.querySelector("#bh-daily"), {
    labels: daily.map((r) => r[0]),
    series: [
      { name: "Sessions", values: daily.map((r) => r[1]), color: C.blue, kind: "bar" },
      { name: "Visitors", values: daily.map((r) => r[2]), color: C.brand, kind: "line" },
      { name: "Signed-in visitors", values: daily.map((r) => r[3]), color: C.avg, kind: "line" },
    ],
    height: 220, xTick: (i) => lab(daily[i][0]), tip: (i) => daily[i][0],
  }));
  st.charts.push(xyChart(st.host.querySelector("#bh-len"), {
    labels: daily.map((r) => r[0]),
    series: [{ name: "Average visit (seconds)", values: daily.map((r) => Number(r[4]) || 0), color: C.purple, kind: "area" },
             { name: "Pages per visit", values: daily.map((r) => Number(r[5]) || 0), color: C.avg, kind: "line" }],
    height: 220, integer: false, xTick: (i) => lab(daily[i][0]), tip: (i) => daily[i][0],
  }));
  const hr = (h) => `${h % 12 || 12} ${h < 12 ? "am" : "pm"}`;
  st.charts.push(xyChart(st.host.querySelector("#bh-hour"), {
    labels: [...Array(24).keys()],
    series: [{ name: "Visits", values: d.hourly || [], color: C.blue, kind: "bar" }],
    height: 180, legend: false, xTick: (i) => (i % 3 === 0 ? hr(i) : ""), tip: (i) => `${hr(i)}–${hr((i + 1) % 24)}`,
  }));
}

// Click map: dots on a box shaped like the page (width = window width,
// height = page height), blended so busy spots go dark.
function drawMap() {
  const cv = st.host?.querySelector("#bh-map");
  if (!cv) return;
  const pts = st.mapKey === `${st.prefs.mapPath}|${st.prefs.mapDev}|${st.prefs.days}` ? st.map || [] : [];
  const n = st.host.querySelector("#bh-map-n");
  if (n) n.textContent = st.mapLoading ? "loading clicks…" : `${fmtInt(pts.length)} clicks${pts.length >= 8000 ? " (latest 8,000)" : ""}`;
  const W = Math.min(420, cv.parentElement.clientWidth || 420);
  const pageH = Math.max(800, ...pts.map((p) => Number(p[2]) || 0));
  const scale = W / 1000;
  const yScale = Math.min(1, 1600 / pageH) * (W / 400);
  const H = Math.max(200, Math.round(pageH * yScale));
  cv.width = W * 2; cv.height = H * 2;
  cv.style.width = `${W}px`; cv.style.height = `${H}px`;
  const ctx = cv.getContext("2d");
  ctx.scale(2, 2);
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--bg-soft") || "#111";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(128,128,128,.25)";
  for (let y = 0; y < H; y += Math.round(800 * yScale)) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }
  ctx.globalCompositeOperation = "source-over";
  for (const [x, y] of pts) {
    if (x == null || y == null) continue;
    const cx = x * scale, cy = y * yScale;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 9);
    g.addColorStop(0, "rgba(235,87,87,0.35)");
    g.addColorStop(1, "rgba(235,87,87,0)");
    ctx.fillStyle = g;
    ctx.fillRect(cx - 9, cy - 9, 18, 18);
  }
  const top = st.host.querySelector("#bh-map-top");
  if (top) {
    const counts = new Map();
    for (const p of pts) counts.set(p[4] || "?", (counts.get(p[4] || "?") || 0) + 1);
    top.innerHTML = `<div class="dim text-sm" style="margin-bottom:6px">Most clicked on this page</div>` +
      barList([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15));
  }
}

function wire() {
  const h = st.host;
  h.querySelectorAll("#bh-days button").forEach((b) => b.addEventListener("click", () => {
    st.prefs.days = Number(b.dataset.v); savePrefs(); st.data = null; st.map = null; paint(); load();
  }));
  h.querySelector("#bh-map-path")?.addEventListener("change", (ev) => { st.prefs.mapPath = ev.target.value; savePrefs(); drawMap(); loadMap(); });
  h.querySelectorAll("#bh-map-dev button").forEach((b) => b.addEventListener("click", () => {
    st.prefs.mapDev = b.dataset.v; savePrefs();
    h.querySelectorAll("#bh-map-dev button").forEach((x) => x.classList.toggle("on", x === b));
    drawMap(); loadMap();
  }));
}

// ---------------------------------------------------------------------------
// One student's trail, for the user drill-down.
export async function renderJourney(el, { adminGet, userId }) {
  el.innerHTML = `<div class="muted text-sm">Loading their journey…</div>`;
  let d;
  try { d = await adminGet(`/api/ai?op=admin-journey&uid=${encodeURIComponent(userId)}`); }
  catch (err) { el.innerHTML = `<div style="color:var(--negative)">${e(err.message || err)}</div>`; return; }
  const ft = d.visitors?.[0]?.firstTouch || {};
  const evs = d.events || [];
  if (!evs.length && !d.visitors?.length) { el.innerHTML = `<div class="muted text-sm">Nothing tracked yet for this student (tracking started 18 Oct 2026).</div>`; return; }
  const bySid = [];
  for (const [ts, kind, path, target, props, sid] of evs) {
    let g = bySid[bySid.length - 1];
    if (!g || g.sid !== sid) { g = { sid, rows: [] }; bySid.push(g); }
    g.rows.push({ ts, kind, path, target, props: props || {} });
  }
  const icon = { session_start: "▶", page: "📄", page_leave: "↩", click: "👆", rage_click: "😡", form_start: "✏️", field: "·", form_submit: "✅", form_abandon: "🚪", form_error: "⚠️", toast: "💬", error: "💥", api: "🌐", perf: "⏱", search: "🔍", outbound: "↗", copy: "📋", net: "📶", install: "📲" };
  const detail = (r) => {
    const p = r.props;
    switch (r.kind) {
      case "page_leave": return `${secs((p.ms || 0) / 1000)} on page, scrolled ${p.sd ?? "?"}%`;
      case "field": return `${e(p.f || "")} · ${secs((p.ms || 0) / 1000)} · ${p.filled ? "filled" : "left empty"}`;
      case "search": return `“${e(r.target || "")}” → ${p.res === "" ? "?" : p.res} results`;
      case "api": return `${e(r.target || "")} → ${p.st} in ${p.ms} ms`;
      case "session_start": return `from ${e(p.src || "direct")} · ${e(p.dev || "")} ${e(p.os || "")} ${e(p.br || "")} · ${e(p.scr || "")}`;
      case "form_error": return `${e(r.target || "")}: ${e(p.msg || "")}`;
      case "perf": return `main content ${p.lcp || "?"} ms, first paint ${p.fcp || "?"} ms`;
      default: return e(r.target || "");
    }
  };
  el.innerHTML = `
    <div class="dim text-sm" style="margin-bottom:8px">First visit ${d.visitors?.[0] ? e(ist(d.visitors[0].firstSeen)) : "?"} · came from <b>${e(ft.src || "direct")}</b>${ft.landing ? ` · landed on ${e(ft.landing)}` : ""}${ft.dev ? ` · ${e(ft.dev)} ${e(ft.os || "")} ${e(ft.br || "")}` : ""}${ft.cc ? ` · ${e(ft.cc)}` : ""} · ${fmtInt(evs.length)} events (latest first)</div>
    <div class="bh-journey">${bySid.map((g) => `
      <details ${g === bySid[0] ? "open" : ""}><summary>Visit · ${e(ist(g.rows[g.rows.length - 1].ts))} – ${e(ist(g.rows[0].ts).split(", ").pop())} · ${g.rows.length} events</summary>
        ${g.rows.map((r) => `<div class="bh-jr"><span class="dim">${e(new Date(r.ts).toLocaleTimeString("en-IN"))}</span><span>${icon[r.kind] || "•"} ${e(r.kind)}</span><span class="dim">${e(r.path || "")}</span><span>${detail(r)}</span></div>`).join("")}
      </details>`).join("")}</div>`;
}

function ensureStyle() {
  if (document.getElementById("admin-behaviour-style")) return;
  const s = document.createElement("style");
  s.id = "admin-behaviour-style";
  s.textContent = `
.bh-root { display: flex; flex-direction: column; gap: 12px; }
.bh-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.bh-seg, .sg-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; flex-wrap: wrap; }
.sg-seg button { background: transparent; border: 0; padding: 5px 10px; font-size: 12.5px; font-weight: 600; color: var(--text-muted); cursor: pointer; font-family: inherit; }
.sg-seg button + button { border-left: 1px solid var(--border); }
.sg-seg button.on { background: var(--brand); color: #fff; }
.bh-live { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; align-items: center; }
.bh-big { font-family: var(--font-mono, monospace); font-size: 2.6rem; font-weight: 800; line-height: 1.1; color: var(--text-strong); }
.bh-livepages { display: grid; gap: 4px; min-width: 220px; font-size: 13px; }
.bh-livepages div { display: flex; justify-content: space-between; gap: 12px; }
.bh-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
.bh-sub { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.bh-card { min-width: 0; }
.bh-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.bh-head h3 { margin: 0; }
.bh-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 440px), 1fr)); gap: 12px; }
.bh-grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 12px; }
.bh-mapbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.bh-mapbar .select { max-width: 260px; }
.bh-mapwrap { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
.bh-mapwrap canvas { border: 1px solid var(--border); border-radius: 8px; max-height: 900px; }
.bh-maptop { flex: 1; min-width: 240px; }
.bh-journey details { border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; margin-bottom: 6px; }
.bh-journey summary { cursor: pointer; font-weight: 600; font-size: 13px; }
.bh-jr { display: grid; grid-template-columns: 80px 120px minmax(80px, 160px) 1fr; gap: 8px; font-size: 12.5px; padding: 3px 0; border-bottom: 1px solid var(--divider, var(--border)); }
.bh-jr span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg-funnel { display: flex; flex-direction: column; gap: 8px; }
.sg-f-row { display: grid; grid-template-columns: minmax(140px, 230px) 1fr auto; gap: 10px; align-items: center; font-size: 13px; }
.sg-f-track { height: 16px; background: var(--bg-soft); border-radius: 6px; overflow: hidden; }
.sg-f-fill { height: 100%; background: linear-gradient(90deg, var(--brand), color-mix(in srgb, var(--brand) 60%, #4C8DF6)); border-radius: 6px; }
.sg-f-num { min-width: 110px; text-align: right; font-family: var(--font-mono, monospace); }
@media (max-width: 560px) { .sg-f-row { grid-template-columns: 1fr auto; } .sg-f-track { grid-column: 1 / -1; order: 3; } .bh-jr { grid-template-columns: 70px 1fr; } }
`;
  document.head.appendChild(s);
}
