// =============================================================================
// ADMIN GOD-MODE PANEL
// Nine-tab unified ops console at /a/<ADMIN_PATH>. Replaces the owner's
// need to open Supabase Studio, Vercel Dashboard, or GitHub Web UI for
// routine operations.
//
// Tabs:
//   Overview   — aggregate health across all three services
//   Users      — every user x every column x filterable/sortable/drill-down
//   Activity   — live-tailing SSE feed of every event
//   Database   — Supabase god mode (SQL editor, table CRUD, RPC runner)
//   Auth       — Supabase Auth admin (list, reset, ban, magic link)
//   Markets    — quote_cache + ai_response_cache + dhan coverage
//   Deploy     — Vercel deployments + logs + envs + redeploy + rollback
//   Repo       — GitHub commits + PRs + issues + Actions + workflow dispatch
//   Audit      — every admin write with before/after diff
//
// Gated by ADMIN_PATH (URL slug) + ADMIN_TOKEN (bearer). Each tab's detail
// code lives in separate modules under /js/pages/admin/ where the module
// count justifies; for now, everything's inline here and will split later
// if the file grows unwieldy.
// =============================================================================

import { formatRupees } from "../money.js";
import { areaChart } from "../components/charts.js";
import { toast } from "../components/toast.js";
import { mountThemedSelect } from "../components/themedSelect.js";

const TOKEN_KEY = "ss.adminToken.v1";
const LAST_TAB_KEY = "ss.adminLastTab.v1";

// Shared fetch state so tabs don't re-fetch on every switch.
const state = {
  overview: null,
  overviewLoading: false,
  overviewError: null,
  activity: [],
  activityFilter: "all",     // trades | coach | transfers | orders | signups | all
  activityPaused: false,
  tail: null,                // EventSource instance
  tailConnected: false,
  userDetail: null,
  userDetailLoading: false,
  filters: {
    search: "",
    onboarded: "any",         // any | yes | no
    riskProfile: "any",       // any | cautious | balanced | bold
    consent: "any",           // any | yes | no
    traded: "any",            // any | yes | no
    coached: "any",           // any | yes | no
    ageBracket: "any",        // any | 13-15 | 16-17 | 18+
    tradeBucket: "any",       // any | 0 | 1-5 | 6-20 | 20+
    activity: "any",          // any | <1d | <7d | <30d | 30d+
    school: "any",            // any | <specific school name>
  },
  sort: { by: "createdAt", dir: "desc" },
};

let currentTab = "overview";

// -----------------------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------------------
export function renderAdmin(main, params) {
  const slug = params?.slug || "";
  if (!slug) return render404Like(main);

  renderLoadingShell(main);
  fetch("/api/ai?op=admin-path-check&slug=" + encodeURIComponent(slug))
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data?.ok) return render404Like(main);
      if (!getToken()) return renderTokenForm(main);
      currentTab = getLastTab() || "overview";
      renderTabbedShell(main);
    })
    .catch(() => render404Like(main));
}

function render404Like(main) {
  main.innerHTML = `
    <div class="empty-state" style="padding: 12vh var(--sp-4);">
      <span class="emoji">🔍</span>
      <h3>Page not found</h3>
      <p class="muted">The route you tried doesn't exist.</p>
      <a href="/" class="btn btn-primary">Back home</a>
    </div>`;
}
function renderLoadingShell(main) {
  main.innerHTML = `<div class="card" style="max-width: 420px; margin: 10vh auto; text-align:center; padding: var(--sp-5);"><div class="muted">Loading…</div></div>`;
}

function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } }
function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch {} }
function getLastTab() { try { return localStorage.getItem(LAST_TAB_KEY); } catch { return null; } }
function setLastTab(t) { try { localStorage.setItem(LAST_TAB_KEY, t); } catch {} }

function renderTokenForm(main) {
  main.innerHTML = `
    <div style="max-width: 520px; margin: 10vh auto;">
      <div class="card">
        <h2 style="margin-top: 0;">Admin access</h2>
        <p class="muted" style="line-height: 1.6;">
          Paste the ADMIN_TOKEN you set on Vercel. Stored in localStorage on this
          device only; sent as a Bearer header on every admin API call.
        </p>
        <div class="field">
          <label class="label" for="admin-token">ADMIN_TOKEN</label>
          <input class="input" id="admin-token" type="password" autocomplete="off" />
        </div>
        <div class="flex gap-2" style="margin-top: var(--sp-3);">
          <button id="admin-token-save" class="btn btn-primary">Unlock</button>
          <a href="/" class="btn btn-ghost">Cancel</a>
        </div>
      </div>
    </div>`;
  const input = main.querySelector("#admin-token");
  // Desktop: auto-focus the token input. Mobile: don't pop the keyboard
  // uninvited — admins on mobile can tap the input themselves.
  if (window.innerWidth >= 1024) input.focus();
  const submit = async () => {
    const t = input.value.trim();
    if (!t) return;
    setToken(t);
    try {
      await loadOverview();
      if (!state.overview) throw new Error(state.overviewError || "rejected");
      renderTabbedShell(main);
    } catch (e) {
      setToken("");
      toast({ kind: "error", message: "Token rejected — try again." });
      renderTokenForm(main);
    }
  };
  main.querySelector("#admin-token-save").addEventListener("click", submit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
}

// -----------------------------------------------------------------------------
// Shared HTTP helpers
// -----------------------------------------------------------------------------
async function adminGet(path) {
  const token = getToken();
  const r = await fetch(path, { headers: { "Authorization": "Bearer " + token } });
  if (r.status === 401) { setToken(""); throw new Error("Unauthorised — sign in again."); }
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function adminPost(path, body) {
  const token = getToken();
  const r = await fetch(path, {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (r.status === 401) { setToken(""); throw new Error("Unauthorised — sign in again."); }
  const rb = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(rb?.error || ("HTTP " + r.status));
  return rb;
}

async function loadOverview() {
  state.overviewLoading = true;
  state.overviewError = null;
  try { state.overview = await adminGet("/api/ai?op=admin-overview"); }
  catch (e) { state.overviewError = e.message || String(e); state.overview = null; throw e; }
  finally { state.overviewLoading = false; }
}

// -----------------------------------------------------------------------------
// Tabbed shell
// -----------------------------------------------------------------------------
function renderTabbedShell(main) {
  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "users",    label: "Users" },
    { id: "activity", label: "Activity" },
    { id: "database", label: "Database" },
    { id: "auth",     label: "Auth" },
    { id: "markets",  label: "Markets" },
    { id: "deploy",   label: "Deploy" },
    { id: "repo",     label: "Repo" },
    { id: "audit",    label: "Audit" },
  ];
  main.innerHTML = `
    <div class="admin-shell">
      <header class="admin-shell-head">
        <div>
          <h1 style="margin:0;">Admin</h1>
          <p class="muted" style="margin:4px 0 0 0;">God-mode ops. Every write is audit-logged.</p>
        </div>
        <div class="flex gap-2 items-center">
          <span id="tail-indicator" class="tail-indicator ${state.tailConnected ? "live" : "off"}">${state.tailConnected ? "● LIVE" : "○ paused"}</span>
          <button class="btn btn-ghost btn-sm" id="tail-toggle">${state.tailConnected ? "Pause tail" : "Live tail"}</button>
          <button class="btn btn-ghost btn-sm" id="admin-refresh">↻ Refresh</button>
          <button class="btn btn-ghost btn-sm" id="admin-logout">Sign out</button>
        </div>
      </header>
      <nav class="admin-tabs">
        ${tabs.map(t => `<button class="admin-tab ${currentTab === t.id ? "active" : ""}" data-tab="${t.id}">${t.label}</button>`).join("")}
      </nav>
      <div class="admin-tab-body" id="admin-tab-body"></div>
    </div>`;
  main.querySelectorAll(".admin-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      currentTab = btn.dataset.tab;
      setLastTab(currentTab);
      renderTabBody(main);
      main.querySelectorAll(".admin-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === currentTab));
    });
  });
  main.querySelector("#admin-refresh").addEventListener("click", async () => {
    await loadOverview().catch(() => {});
    renderTabBody(main);
  });
  main.querySelector("#admin-logout").addEventListener("click", () => {
    setToken("");
    closeTail();
    state.overview = null;
    renderTokenForm(main);
  });
  main.querySelector("#tail-toggle").addEventListener("click", () => {
    if (state.tailConnected) closeTail(); else openTail(main);
    updateTailBadge(main);
  });
  renderTabBody(main);
}

function renderTabBody(main) {
  const host = main.querySelector("#admin-tab-body");
  if (!host) return;
  host.innerHTML = "";
  switch (currentTab) {
    case "overview": return renderOverview(host, main);
    case "users":    return renderUsersTab(host, main);
    case "activity": return renderActivityTab(host, main);
    case "database": return renderDatabaseTab(host, main);
    case "auth":     return renderAuthTab(host, main);
    case "markets":  return renderMarketsTab(host, main);
    case "deploy":   return renderDeployTab(host, main);
    case "repo":     return renderRepoTab(host, main);
    case "audit":    return renderAuditTab(host, main);
    default:         return renderOverview(host, main);
  }
}

function renderPlaceholder(host, title, hint) {
  host.innerHTML = `<div class="card" style="text-align:center; padding: var(--sp-6);"><h3>${escapeHtml(title)}</h3><p class="muted">${escapeHtml(hint)}</p></div>`;
}

// -----------------------------------------------------------------------------
// Overview tab
// -----------------------------------------------------------------------------
function renderOverview(host, main) {
  if (!state.overview && !state.overviewLoading) {
    loadOverview().catch(() => {}).finally(() => renderTabBody(main));
  }
  if (state.overviewLoading && !state.overview) {
    host.innerHTML = `<div class="card"><div class="muted">Loading overview…</div></div>`;
    return;
  }
  if (!state.overview) {
    host.innerHTML = `<div class="card"><div style="color: var(--negative);">${escapeHtml(state.overviewError || "Failed to load.")}</div></div>`;
    return;
  }
  const { aggregates: a, byDay, top, rowCounts } = state.overview;
  const maxDay = byDay.reduce((b, c) => c.count > b.count ? c : b, { count: 0, day: "" });
  const signupChart = areaChart(byDay.map(d => d.count), { height: 80, color: "var(--brand)", paddingLeft: 0 });
  host.innerHTML = `
    <div class="admin-stats">
      <div class="stat-tile"><div class="l">Users</div><div class="v tabular">${a.users}</div></div>
      <div class="stat-tile"><div class="l">Onboarded</div><div class="v tabular">${a.onboarded} <span class="dim text-sm">(${a.onboardedPct}%)</span></div></div>
      <div class="stat-tile"><div class="l">Traded ever</div><div class="v tabular">${a.active} <span class="dim text-sm">(${a.activePct}%)</span></div></div>
      <div class="stat-tile"><div class="l">Consented</div><div class="v tabular">${a.consented}</div></div>
      <div class="stat-tile"><div class="l">Total portfolio</div><div class="v tabular">${formatRupees((a.totalPortfolioRupees || 0) * 100, { compact: true })}</div></div>
      <div class="stat-tile"><div class="l">Total cash</div><div class="v tabular">${formatRupees(a.totalCashRupees * 100, { compact: true })}</div></div>
      <div class="stat-tile"><div class="l">Total trades</div><div class="v tabular">${a.totalTrades}</div></div>
      <div class="stat-tile"><div class="l">Coach msgs</div><div class="v tabular">${a.totalCoachMessages}</div></div>
    </div>

    <div class="card" style="margin-top: var(--sp-4);">
      <div class="card-head"><h3>Sign-ups · last 30 days</h3><span class="dim text-sm">Peak: ${maxDay.count || 0} on ${escapeHtml(maxDay.day || "—")}</span></div>
      <div style="height: 80px;">${signupChart}</div>
    </div>

    <div class="admin-overview-grid" style="margin-top: var(--sp-4);">
      <div class="card">
        <div class="card-head"><h3>Row counts (every table)</h3></div>
        <div class="admin-row-counts">
          ${Object.entries(rowCounts).map(([k, v]) => `<div class="admin-kv"><span>${escapeHtml(k)}</span><span class="tabular">${v}</span></div>`).join("")}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Top portfolios</h3></div>
        ${renderLeaderboard(top.biggestPortfolios, v => formatRupees(v * 100, { compact: true }))}
      </div>
      <div class="card">
        <div class="card-head"><h3>Most active (trades)</h3></div>
        ${renderLeaderboard(top.mostActive, v => v + " trades")}
      </div>
      <div class="card">
        <div class="card-head"><h3>Most coached</h3></div>
        ${renderLeaderboard(top.mostCoached, v => v + " msgs")}
      </div>
      <div class="card">
        <div class="card-head"><h3>Biggest gainers</h3></div>
        ${renderLeaderboard(top.biggestGainers, v => (v >= 0 ? "+" : "") + v.toFixed(1) + "%")}
      </div>
      <div class="card">
        <div class="card-head"><h3>Biggest losers</h3></div>
        ${renderLeaderboard(top.biggestLosers, v => v.toFixed(1) + "%")}
      </div>
    </div>`;
}
function renderLeaderboard(rows, fmt) {
  if (!rows?.length) return `<div class="muted text-sm" style="padding: var(--sp-3);">No data yet.</div>`;
  return `<ol class="admin-lb">${rows.map(r => `<li><a href="#" data-open-user="${escapeAttr(r.id)}">@${escapeHtml(r.username || "?")}</a><span class="tabular">${escapeHtml(fmt(r.value))}</span></li>`).join("")}</ol>`;
}

// -----------------------------------------------------------------------------
// Users tab
// -----------------------------------------------------------------------------
function renderUsersTab(host, main) {
  if (!state.overview && !state.overviewLoading) {
    loadOverview().catch(() => {}).finally(() => renderTabBody(main));
  }
  if (state.overviewLoading && !state.overview) {
    host.innerHTML = `<div class="card"><div class="muted">Loading users…</div></div>`;
    return;
  }
  if (!state.overview) return;
  const users = state.overview.users || [];
  const list = applyFiltersAndSort(users);
  const schools = [...new Set(users.map(u => u.school).filter(Boolean))].sort();

  host.innerHTML = `
    <div class="admin-filter-bar card" style="margin-bottom: var(--sp-3);">
      <input id="u-search" class="input" placeholder="Search username / name / email / school / city" value="${escapeAttr(state.filters.search)}" style="flex:1; min-width: 240px;" />
      <div id="u-onboarded" class="u-filter-slot"></div>
      <div id="u-risk"      class="u-filter-slot"></div>
      <div id="u-consent"   class="u-filter-slot"></div>
      <div id="u-traded"    class="u-filter-slot"></div>
      <div id="u-coached"   class="u-filter-slot"></div>
      <div id="u-age"       class="u-filter-slot"></div>
      <div id="u-trades"    class="u-filter-slot"></div>
      <div id="u-activity"  class="u-filter-slot"></div>
      <div id="u-school"    class="u-filter-slot"></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>Users (${list.length} of ${users.length})</h3>
        <div class="dim text-xs">Click header to sort · click row for drill-down</div>
      </div>
      <div class="admin-table-wrap">
        ${renderUsersTable(list)}
      </div>
    </div>`;

  // Wire filters
  const setF = (key, val) => {
    state.filters[key] = val;
    renderTabBody(main);
  };
  host.querySelector("#u-search").addEventListener("input", e => {
    state.filters.search = e.target.value;
    const tbody = host.querySelector(".admin-table tbody");
    if (tbody) tbody.innerHTML = renderUsersRowsHtml(applyFiltersAndSort(users));
    wireRowClicks(host, main);
  });
  mountThemedSelect(host.querySelector("#u-onboarded"), {
    value: state.filters.onboarded,
    options: [{ value: "any", label: "Onboarded: any" }, { value: "yes", label: "Onboarded · yes" }, { value: "no", label: "Onboarded · no" }],
    onChange: v => setF("onboarded", v),
  });
  mountThemedSelect(host.querySelector("#u-risk"), {
    value: state.filters.riskProfile,
    options: [{ value: "any", label: "Risk: any" }, { value: "cautious", label: "Cautious" }, { value: "balanced", label: "Balanced" }, { value: "bold", label: "Bold" }],
    onChange: v => setF("riskProfile", v),
  });
  mountThemedSelect(host.querySelector("#u-consent"), {
    value: state.filters.consent,
    options: [{ value: "any", label: "Consent: any" }, { value: "yes", label: "Consented" }, { value: "no", label: "No consent" }],
    onChange: v => setF("consent", v),
  });
  mountThemedSelect(host.querySelector("#u-traded"), {
    value: state.filters.traded,
    options: [{ value: "any", label: "Trading: any" }, { value: "yes", label: "Has traded" }, { value: "no", label: "Zero trades" }],
    onChange: v => setF("traded", v),
  });
  mountThemedSelect(host.querySelector("#u-coached"), {
    value: state.filters.coached,
    options: [{ value: "any", label: "Coach: any" }, { value: "yes", label: "Has coach msgs" }, { value: "no", label: "No coach msgs" }],
    onChange: v => setF("coached", v),
  });
  mountThemedSelect(host.querySelector("#u-age"), {
    value: state.filters.ageBracket,
    options: [{ value: "any", label: "Age: any" }, { value: "13-15", label: "13–15" }, { value: "16-17", label: "16–17" }, { value: "18+", label: "18+" }],
    onChange: v => setF("ageBracket", v),
  });
  mountThemedSelect(host.querySelector("#u-trades"), {
    value: state.filters.tradeBucket,
    options: [
      { value: "any", label: "Trades: any" },
      { value: "0", label: "Zero trades" },
      { value: "1-5", label: "1–5" },
      { value: "6-20", label: "6–20" },
      { value: "20+", label: "20+" },
    ],
    onChange: v => setF("tradeBucket", v),
  });
  mountThemedSelect(host.querySelector("#u-activity"), {
    value: state.filters.activity,
    options: [
      { value: "any", label: "Activity: any" },
      { value: "<1d", label: "Active < 1 day" },
      { value: "<7d", label: "Active < 7 days" },
      { value: "<30d", label: "Active < 30 days" },
      { value: "30d+", label: "Stale 30d+" },
    ],
    onChange: v => setF("activity", v),
  });
  mountThemedSelect(host.querySelector("#u-school"), {
    value: state.filters.school,
    options: [{ value: "any", label: "School: any" }, ...schools.map(s => ({ value: s, label: s }))],
    onChange: v => setF("school", v),
  });

  host.querySelectorAll(".admin-table th[data-col]").forEach(th => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (state.sort.by === col) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      else { state.sort.by = col; state.sort.dir = "desc"; }
      renderTabBody(main);
    });
  });
  wireRowClicks(host, main);
}

// 27-column sortable user table
function renderUsersTable(list) {
  const cols = [
    ["user", "User"],
    ["createdAt", "Joined"],
    ["onboarded", "OB"],
    ["age", "Age"],
    ["school", "School"],
    ["riskProfile", "Risk"],
    ["tradeCount", "Trades"],
    ["coachMsgCount", "Coach"],
    ["holdingCount", "Hold"],
    ["friendCount", "Friends"],
    ["watchlistCount", "WL"],
    ["limitOrderCount", "LO"],
    ["biasFlagCount", "Biases"],
    ["transferInCount", "In"],
    ["transferOutCount", "Out"],
    ["cashRupees", "Cash"],
    ["totalPortfolioRupees", "Portfolio"],
    ["unrealizedPLPct", "P/L%"],
    ["totalTradedValueRupees", "Vol"],
    ["daysSinceLastTrade", "Idle"],
    ["lastActive", "Active"],
  ];
  return `<table class="admin-table">
    <thead><tr>${cols.map(([col, label]) => colHead(col, label)).join("")}<th>Act</th></tr></thead>
    <tbody>${renderUsersRowsHtml(list)}</tbody>
  </table>`;
}
function renderUsersRowsHtml(list) {
  return list.slice(0, 500).map(u => `
    <tr data-user-id="${escapeAttr(u.id)}">
      <td><div class="font-semi">${escapeHtml(u.displayName || u.username)}</div>
          <div class="dim text-xs">@${escapeHtml(u.username || "")} · ${escapeHtml(u.email || "")}</div></td>
      <td class="dim text-xs">${formatDateShort(u.createdAt)}</td>
      <td>${u.onboarded ? '<span class="pill pill-green" style="font-size:10px;">OB</span>' : '<span class="pill" style="font-size:10px;background:var(--bg-subtle);color:var(--text-dim);">NEW</span>'}</td>
      <td class="dim">${u.age ?? "—"}</td>
      <td class="dim text-xs">${escapeHtml(u.school || "—")}</td>
      <td class="dim text-xs">${escapeHtml(u.riskProfile || "—")}</td>
      <td class="tabular">${u.tradeCount}</td>
      <td class="tabular">${u.coachMsgCount}</td>
      <td class="tabular">${u.holdingCount}</td>
      <td class="tabular">${u.friendCount}</td>
      <td class="tabular">${u.watchlistCount}</td>
      <td class="tabular">${u.limitOrderCount}</td>
      <td class="tabular">${u.biasFlagCount}</td>
      <td class="tabular">${u.transferInCount}</td>
      <td class="tabular">${u.transferOutCount}</td>
      <td class="tabular">${u.cashRupees != null ? formatRupees(u.cashRupees * 100, { compact: true }) : "—"}</td>
      <td class="tabular">${u.totalPortfolioRupees ? formatRupees(u.totalPortfolioRupees * 100, { compact: true }) : "—"}</td>
      <td class="tabular ${u.unrealizedPLPct >= 0 ? "positive" : "negative"}">${u.unrealizedPLPct >= 0 ? "+" : ""}${u.unrealizedPLPct.toFixed(1)}%</td>
      <td class="tabular">${u.totalTradedValueRupees ? formatRupees(u.totalTradedValueRupees * 100, { compact: true }) : "—"}</td>
      <td class="tabular">${u.daysSinceLastTrade != null ? u.daysSinceLastTrade + "d" : "—"}</td>
      <td class="dim text-xs" title="${escapeAttr(formatDatePrecise(u.lastActive))}">${formatDateShort(u.lastActive)}</td>
      <td><button class="btn btn-ghost btn-sm" data-quick-reset="${escapeAttr(u.id)}" title="Reset portfolio">⟲</button></td>
    </tr>`).join("");
}
function colHead(col, label) {
  const arrow = state.sort.by === col ? (state.sort.dir === "asc" ? " ↑" : " ↓") : "";
  return `<th data-col="${col}" class="sortable">${escapeHtml(label)}${arrow}</th>`;
}
function wireRowClicks(host, main) {
  host.querySelectorAll(".admin-table tbody tr").forEach(tr => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-quick-reset]")) return;
      openUserModal(tr.dataset.userId);
    });
  });
  host.querySelectorAll("[data-quick-reset]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const userId = btn.dataset.quickReset;
      const reason = prompt("Reason for reset (≥ 8 chars, logged to audit):");
      if (!reason || reason.trim().length < 8) return;
      adminPost("/api/ai?op=admin-user-reset", { userId, reason })
        .then(() => { toast({ kind: "success", message: "User reset." }); loadOverview().then(() => renderTabBody(main)); })
        .catch(e => toast({ kind: "error", message: e.message }));
    });
  });
  host.querySelectorAll("[data-open-user]").forEach(el => {
    el.addEventListener("click", (e) => { e.preventDefault(); openUserModal(el.dataset.openUser); });
  });
}

function applyFiltersAndSort(users) {
  const f = state.filters;
  let list = users;
  if (f.search) {
    const q = f.search.toLowerCase();
    list = list.filter(u =>
      (u.username || "").toLowerCase().includes(q) ||
      (u.displayName || "").toLowerCase().includes(q) ||
      (u.email || "").toLowerCase().includes(q) ||
      (u.school || "").toLowerCase().includes(q) ||
      (u.city || "").toLowerCase().includes(q));
  }
  if (f.onboarded !== "any")      list = list.filter(u => f.onboarded === "yes" ? !!u.onboarded : !u.onboarded);
  if (f.riskProfile !== "any")    list = list.filter(u => u.riskProfile === f.riskProfile);
  if (f.consent !== "any")        list = list.filter(u => f.consent === "yes" ? u.parentConsented : !u.parentConsented);
  if (f.traded !== "any")         list = list.filter(u => f.traded === "yes" ? u.tradeCount > 0 : u.tradeCount === 0);
  if (f.coached !== "any")        list = list.filter(u => f.coached === "yes" ? u.coachMsgCount > 0 : u.coachMsgCount === 0);
  if (f.ageBracket !== "any") {
    list = list.filter(u => {
      const a = u.age;
      if (a == null) return false;
      if (f.ageBracket === "13-15") return a >= 13 && a <= 15;
      if (f.ageBracket === "16-17") return a >= 16 && a <= 17;
      if (f.ageBracket === "18+")   return a >= 18;
      return true;
    });
  }
  if (f.tradeBucket !== "any") {
    list = list.filter(u => {
      const c = u.tradeCount;
      if (f.tradeBucket === "0")    return c === 0;
      if (f.tradeBucket === "1-5")  return c >= 1 && c <= 5;
      if (f.tradeBucket === "6-20") return c >= 6 && c <= 20;
      if (f.tradeBucket === "20+")  return c > 20;
      return true;
    });
  }
  if (f.activity !== "any") {
    const now = Date.now();
    list = list.filter(u => {
      const diff = u.lastActive ? now - new Date(u.lastActive).getTime() : Infinity;
      const days = diff / 86400000;
      if (f.activity === "<1d")   return days < 1;
      if (f.activity === "<7d")   return days < 7;
      if (f.activity === "<30d")  return days < 30;
      if (f.activity === "30d+")  return days >= 30;
      return true;
    });
  }
  if (f.school !== "any")         list = list.filter(u => u.school === f.school);
  const { by, dir } = state.sort;
  list = list.slice().sort((a, b) => {
    const av = a[by], bv = b[by];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av === bv) return 0;
    return (av > bv ? 1 : -1) * (dir === "asc" ? 1 : -1);
  });
  return list;
}

// -----------------------------------------------------------------------------
// User drill-down modal (14 sections)
// -----------------------------------------------------------------------------
async function openUserModal(userId) {
  const host = document.getElementById("modal-root");
  host.innerHTML = `
    <div class="modal-overlay" id="admin-user-overlay">
      <div class="modal" style="max-width: 880px; max-height: 90vh; overflow: auto;">
        <div class="modal-head">
          <h2>Loading…</h2>
          <button class="btn btn-ghost btn-icon" id="admin-close-modal">✕</button>
        </div>
        <div class="modal-body" id="admin-user-body"><div class="muted">Fetching 11 parallel queries…</div></div>
      </div>
    </div>`;
  document.getElementById("admin-close-modal").addEventListener("click", () => host.innerHTML = "");
  document.getElementById("admin-user-overlay").addEventListener("click", e => {
    if (e.target.id === "admin-user-overlay") host.innerHTML = "";
  });
  state.userDetailLoading = true;
  try {
    state.userDetail = await adminGet("/api/ai?op=admin-user&id=" + encodeURIComponent(userId));
  } catch (e) {
    state.userDetail = { error: e.message };
  }
  state.userDetailLoading = false;
  paintUserModal();
}
function paintUserModal() {
  const host = document.getElementById("modal-root");
  const body = document.getElementById("admin-user-body");
  const head = host?.querySelector(".modal-head h2");
  if (!body || !head) return;
  const d = state.userDetail;
  if (d?.error) { body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(d.error)}</div>`; head.textContent = "Error"; return; }
  const { profile, portfolio, holdings, transactions, coachMessages, portfolioHistory, watchlist, friends, transfers, limitOrders, adminActionHistory, reportCard, authMeta } = d;
  head.innerHTML = `${escapeHtml(profile.display_name || profile.username)} <span class="dim text-sm">@${escapeHtml(profile.username)}</span>`;

  const histValues = (portfolioHistory || []).map(h => (h.total_value_paise || 0) / 100);
  const histSvg = histValues.length > 1
    ? `<div style="height: 180px;">${areaChart(histValues, { height: 180, color: "var(--brand)", paddingLeft: 40 })}</div>`
    : `<div class="muted text-sm" style="padding: var(--sp-3); border: 1px dashed var(--border); border-radius: var(--r); text-align:center;">No history yet. Kick off backfill from System tab.</div>`;

  const totalHoldValue = (holdings || []).reduce((a, h) => a + (Number(h.qty) || 0) * (Number(h.avg_cost_paise) || 0), 0) / 100;
  const cashRupees = (portfolio?.cash_paise || 0) / 100;
  const totalValue = cashRupees + totalHoldValue;

  body.innerHTML = `
    <div class="admin-drill-nav">
      ${["identity","money","history","holdings","transactions","orders","watchlist","friends","transfers","coach","report","auth","audit","raw"].map(s => `<button type="button" class="drill-jump" data-drill-target="sec-${s}">${s}</button>`).join("")}
    </div>

    <div id="sec-identity"><div class="admin-user-section-label">1. Identity</div>
      <div class="admin-user-grid">
        <div>
          ${kv("Email", profile.email)}
          ${kv("Age", profile.age)}
          ${kv("School", profile.school)}
          ${kv("Class code", profile.class_code)}
          ${kv("City", profile.city)}
          ${kv("Risk profile", profile.risk_profile)}
          ${kv("Avatar color", profile.avatar_color)}
        </div>
        <div>
          ${kv("Parent email", profile.parent_email)}
          ${kv("Consent at", profile.parent_consent_at ? formatDatePrecise(profile.parent_consent_at) : "—")}
          ${kv("Onboarded", profile.onboarded ? "Yes" : "No")}
          ${kv("Joined", formatDatePrecise(profile.created_at))}
          ${kv("Last active", formatDatePrecise(profile.updated_at))}
          ${kv("ID", profile.id)}
        </div>
      </div>
    </div>

    <div id="sec-money"><div class="admin-user-section-label">2. Money</div>
      <div class="admin-kv"><span>Cash</span><span>${formatRupees(cashRupees * 100)}</span></div>
      <div class="admin-kv"><span>Holdings (cost-basis)</span><span>${formatRupees(totalHoldValue * 100)}</span></div>
      <div class="admin-kv"><span>Starting cash</span><span>${formatRupees(portfolio?.starting_cash_paise || 10000000)}</span></div>
      <div class="admin-kv" style="border-top:1px solid var(--divider); padding-top: 6px; margin-top: 6px;">
        <span class="font-semi">Total portfolio</span><span class="font-semi">${formatRupees(totalValue * 100)}</span>
      </div>
    </div>

    <div id="sec-history"><div class="admin-user-section-label">3. Portfolio value over time</div>${histSvg}</div>

    <div id="sec-holdings"><div class="admin-user-section-label">4. Holdings (${holdings?.length || 0})</div>
      ${holdings?.length ? `<table class="admin-table"><thead><tr><th>Symbol</th><th>Qty</th><th>Avg cost</th><th>Cost basis</th><th>First bought</th></tr></thead><tbody>
        ${holdings.map(h => `<tr><td>${escapeHtml(h.symbol)}</td><td class="tabular">${h.qty}</td><td class="tabular">${formatRupees(h.avg_cost_paise || 0)}</td><td class="tabular">${formatRupees((Number(h.qty) || 0) * (Number(h.avg_cost_paise) || 0))}</td><td class="dim text-xs">${formatDateShort(h.first_bought_at)}</td></tr>`).join("")}
      </tbody></table>` : `<div class="muted text-sm">No holdings.</div>`}</div>

    <div id="sec-transactions"><div class="admin-user-section-label">5. Transactions (last ${transactions?.length || 0})</div>
      ${transactions?.length ? `<table class="admin-table"><thead><tr><th>When</th><th>Side</th><th>Symbol</th><th>Qty</th><th>Price</th><th>Value</th><th>Biases</th><th>Act</th></tr></thead><tbody>
        ${transactions.slice(0, 100).map(t => `<tr>
          <td class="dim text-xs">${formatDateShort(t.created_at)}</td>
          <td><span class="pill ${t.side === "BUY" ? "pill-green" : "pill-red"}" style="font-size:10px;">${t.side}</span></td>
          <td>${escapeHtml(t.symbol)}</td>
          <td class="tabular">${t.qty}</td>
          <td class="tabular">${formatRupees(t.price_paise || 0)}</td>
          <td class="tabular">${formatRupees(t.value_paise || 0)}</td>
          <td class="dim text-xs">${Array.isArray(t.bias_flags) ? t.bias_flags.length : 0}</td>
          <td><button class="btn btn-ghost btn-sm" data-delete-trade="${escapeAttr(t.id)}">reverse</button></td>
        </tr>`).join("")}
      </tbody></table>` : `<div class="muted text-sm">No trades.</div>`}</div>

    <div id="sec-orders"><div class="admin-user-section-label">6. Limit orders (${limitOrders?.length || 0})</div>
      ${limitOrders?.length ? `<table class="admin-table"><thead><tr><th>When</th><th>Side</th><th>Symbol</th><th>Qty</th><th>Limit</th><th>Status</th><th>Act</th></tr></thead><tbody>
        ${limitOrders.map(o => `<tr>
          <td class="dim text-xs">${formatDateShort(o.created_at)}</td>
          <td>${o.side}</td><td>${escapeHtml(o.symbol)}</td><td class="tabular">${o.qty}</td>
          <td class="tabular">${formatRupees(o.limit_price_paise || 0)}</td>
          <td>${o.status}</td>
          <td>${o.status === "pending" ? `<button class="btn btn-ghost btn-sm" data-cancel-order="${escapeAttr(o.id)}">cancel</button>` : "—"}</td>
        </tr>`).join("")}
      </tbody></table>` : `<div class="muted text-sm">No orders.</div>`}</div>

    <div id="sec-watchlist"><div class="admin-user-section-label">7. Watchlist (${watchlist?.length || 0})</div>
      ${watchlist?.length ? `<div class="flex gap-1 wrap">${watchlist.map(w => `<span class="pill">${escapeHtml(w.symbol)}</span>`).join("")}</div>` : `<div class="muted text-sm">Empty.</div>`}</div>

    <div id="sec-friends"><div class="admin-user-section-label">8. Friends (${friends?.length || 0})</div>
      ${friends?.length ? `<div class="dim text-sm">${friends.length} friend(s) — IDs: ${friends.map(f => escapeHtml((f.friend_id || "").slice(0, 8))).join(", ")}</div>` : `<div class="muted text-sm">No friends yet.</div>`}</div>

    <div id="sec-transfers"><div class="admin-user-section-label">9. Transfers (${transfers?.length || 0})</div>
      ${transfers?.length ? `<table class="admin-table"><thead><tr><th>When</th><th>Dir</th><th>Amount</th><th>Status</th><th>Act</th></tr></thead><tbody>
        ${transfers.map(tf => `<tr>
          <td class="dim text-xs">${formatDateShort(tf.created_at)}</td>
          <td>${tf.sender_id === profile.id ? "OUT" : "IN"}</td>
          <td class="tabular">${formatRupees(tf.amount_paise || 0)}</td>
          <td>${tf.status}</td>
          <td><button class="btn btn-ghost btn-sm" data-void-transfer="${escapeAttr(tf.id)}">void</button></td>
        </tr>`).join("")}
      </tbody></table>` : `<div class="muted text-sm">No transfers.</div>`}</div>

    ${renderCoachSection(coachMessages)}

    <div id="sec-report"><div class="admin-user-section-label">11. Report card (server-computed)</div>
      ${reportCard ? `<div class="admin-user-grid">
        <div>
          ${kv("Total trades", reportCard.totalTrades)}
          ${kv("Closed trades", reportCard.closedTrades)}
          ${kv("Wins / Losses", reportCard.wins + " / " + reportCard.losses)}
          ${kv("Win rate", Math.round(reportCard.winRate * 100) + "%")}
        </div>
        <div>
          ${kv("Biggest win", formatRupees(reportCard.biggestWinRupees * 100))}
          ${kv("Biggest loss", formatRupees(reportCard.biggestLossRupees * 100))}
          ${kv("Avg hold days", reportCard.avgHoldDays)}
          ${kv("Bias flags", (reportCard.biasFlags || []).join(", ") || "—")}
        </div>
      </div>` : `<div class="muted text-sm">Not available.</div>`}</div>

    <div id="sec-auth"><div class="admin-user-section-label">12. Supabase Auth metadata</div>
      ${authMeta ? `<div class="admin-user-grid">
        <div>
          ${kv("Last sign-in", authMeta.lastSignInAt ? formatDateShort(authMeta.lastSignInAt) : "—")}
          ${kv("Email confirmed", authMeta.emailConfirmedAt ? formatDateShort(authMeta.emailConfirmedAt) : "—")}
          ${kv("Phone", authMeta.phone || "—")}
          ${kv("Banned until", authMeta.bannedUntil || "—")}
        </div>
        <div>
          ${kv("Created", formatDateShort(authMeta.createdAt))}
          ${kv("Updated", formatDateShort(authMeta.updatedAt))}
          <details><summary>Raw user metadata</summary><pre class="admin-coach-payload">${escapeHtml(JSON.stringify(authMeta.rawUserMetaData || {}, null, 2))}</pre></details>
        </div>
      </div>
      <div class="flex gap-2 wrap" style="margin-top: var(--sp-3);">
        <button class="btn btn-ghost btn-sm" data-auth-reset="${escapeAttr(profile.email)}" title="Sends a password-reset email to the user. They click it to choose a new password themselves.">Send reset email</button>
        <button class="btn btn-ghost btn-sm" data-auth-magic="${escapeAttr(profile.email)}" title="Generates a one-time magic link. User clicks it and is logged in without a password.">Magic link</button>
        <button class="btn btn-ghost btn-sm" data-auth-set-password="${escapeAttr(profile.id)}" data-username="${escapeAttr(profile.username)}" title="Set a new password for this user (bypasses email). They'll use it to log in. Passwords themselves CAN'T be retrieved — they're one-way bcrypt-hashed.">Set password</button>
        ${authMeta.bannedUntil ? `<button class="btn btn-ghost btn-sm" data-unban="${escapeAttr(profile.id)}">Unban</button>` : `<button class="btn btn-ghost btn-sm" data-ban="${escapeAttr(profile.id)}" style="color:var(--negative);">Ban</button>`}
        <button class="btn btn-ghost btn-sm" data-delete-user="${escapeAttr(profile.id)}" data-username="${escapeAttr(profile.username)}" style="color:var(--negative);">Delete account</button>
      </div>
      <div class="muted text-xs" style="margin-top: var(--sp-2); line-height: 1.5;">
        Note: actual passwords cannot be shown. Supabase (like every real auth system) stores them as <strong>bcrypt one-way hashes</strong> — mathematically irreversible. "Set password" is the admin equivalent of reading a password.
      </div>
      ` : `<div class="muted text-sm">Unreachable (service-role needed).</div>`}</div>

    <div id="sec-audit"><div class="admin-user-section-label">13. Admin action history (${adminActionHistory?.length || 0})</div>
      ${adminActionHistory?.length ? `<table class="admin-table"><thead><tr><th>When</th><th>Action</th><th>Reason</th></tr></thead><tbody>
        ${adminActionHistory.map(a => `<tr><td class="dim text-xs">${formatDateShort(a.ts)}</td><td>${escapeHtml(a.action)}</td><td class="dim text-xs">${escapeHtml(a.reason || "—")}</td></tr>`).join("")}
      </tbody></table>` : `<div class="muted text-sm">None.</div>`}</div>

    <div id="sec-raw"><div class="admin-user-section-label">14. Raw (collapsed)</div>
      <details><summary>Expand every field as JSON</summary><pre class="admin-coach-payload">${escapeHtml(JSON.stringify(d, null, 2))}</pre></details>
    </div>
  `;
  wireModalActions(profile);
}
function wireModalActions(profile) {
  const host = document.getElementById("modal-root");
  // Drill-nav click handler: scroll to the target section INSIDE the modal
  // without touching location.hash. Previously these were plain anchor tags
  // whose default behaviour set location.hash = "#sec-money", which the
  // router then interpreted as a new top-level route and kicked the user
  // out of the admin page entirely.
  host.querySelectorAll(".drill-jump").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const targetId = btn.getAttribute("data-drill-target");
      if (!targetId) return;
      const target = host.querySelector(`#${CSS.escape(targetId)}`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  host.querySelectorAll("[data-delete-trade]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason for reversing this trade (≥ 8 chars):");
    if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-trade-delete", { txnId: b.dataset.deleteTrade, reason }); toast({ kind: "success", message: "Trade reversed." }); openUserModal(profile.id); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-cancel-order]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason for cancelling (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-order-cancel", { orderId: b.dataset.cancelOrder, reason }); toast({ kind: "success", message: "Cancelled." }); openUserModal(profile.id); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-void-transfer]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason for voiding (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-transfer-void", { transferId: b.dataset.voidTransfer, reason }); toast({ kind: "success", message: "Voided." }); openUserModal(profile.id); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-delete-coach]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-coach-delete", { messageId: b.dataset.deleteCoach, reason }); toast({ kind: "success", message: "Deleted." }); openUserModal(profile.id); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-auth-reset]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-auth-reset", { email: b.dataset.authReset, reason }); toast({ kind: "success", message: "Reset email sent." }); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-auth-magic]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { const r = await adminPost("/api/ai?op=admin-auth-magiclink", { email: b.dataset.authMagic, reason }); toast({ kind: "success", message: "Link: " + (r.link || "generated.") }); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-auth-set-password]").forEach(b => b.addEventListener("click", async () => {
    const username = b.dataset.username || "this user";
    const newPw = prompt(`Set a NEW password for @${username}. The user can log in with this password (minimum 8 characters). Passwords CAN'T be retrieved — this is the admin equivalent of reading one.`);
    if (!newPw) return;
    if (newPw.length < 8) { toast({ kind: "error", message: "Password must be at least 8 characters." }); return; }
    if (newPw.length > 128) { toast({ kind: "error", message: "Password must be 128 characters or less." }); return; }
    const reason = prompt("Reason for setting this password (≥ 8 chars, audit-logged):");
    if (!reason || reason.trim().length < 8) return;
    try {
      await adminPost("/api/ai?op=admin-auth-set-password", { userId: b.dataset.authSetPassword, password: newPw, reason });
      toast({ kind: "success", message: `Password set for @${username}. They can now log in with it.` });
    } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-ban]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason for ban (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-user-ban", { userId: b.dataset.ban, reason }); toast({ kind: "success", message: "Banned." }); openUserModal(profile.id); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-unban]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-user-unban", { userId: b.dataset.unban, reason }); toast({ kind: "success", message: "Unbanned." }); openUserModal(profile.id); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-delete-user]").forEach(b => b.addEventListener("click", async () => {
    const username = b.dataset.username;
    const confirm = prompt(`DESTRUCTIVE. Type the username (${username}) to confirm:`);
    if (confirm !== username) return;
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-user-delete", { userId: b.dataset.deleteUser, confirm: username, reason }); toast({ kind: "success", message: "Deleted." }); document.getElementById("modal-root").innerHTML = ""; } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
}

// -----------------------------------------------------------------------------
// Activity tab + Live tail (SSE)
// -----------------------------------------------------------------------------
function renderActivityTab(host, main) {
  host.innerHTML = `
    <div class="card" style="margin-bottom: var(--sp-3);">
      <div class="card-head">
        <h3>Live activity feed</h3>
        <div class="flex gap-2 items-center">
          <div id="act-filter" style="min-width: 180px;"></div>
          <button class="btn btn-ghost btn-sm" id="act-clear">Clear</button>
        </div>
      </div>
      <div id="activity-list" class="activity-list">
        <div class="muted text-sm" style="padding: var(--sp-3);">Open Live tail at the top to start streaming events.</div>
      </div>
    </div>`;
  mountThemedSelect(host.querySelector("#act-filter"), {
    value: state.activityFilter,
    options: [
      { value: "all", label: "All events" },
      { value: "trades", label: "🟢 Trades" },
      { value: "coach", label: "💬 Coach" },
      { value: "transfers", label: "💸 Transfers" },
      { value: "orders", label: "📊 Orders" },
      { value: "signups", label: "✨ Signups" },
    ],
    onChange: v => { state.activityFilter = v; repaintActivity(); },
  });
  host.querySelector("#act-clear").addEventListener("click", () => {
    state.activity = [];
    repaintActivity();
  });
  // Also auto-fetch a recent batch of events so the feed isn't empty on open.
  adminGet("/api/ai?op=admin-activity-feed&limit=100")
    .then(d => { state.activity = (d?.events || []).reverse(); repaintActivity(); })
    .catch(() => {});
}

function repaintActivity() {
  const host = document.getElementById("activity-list");
  if (!host) return;
  const events = state.activity
    .filter(e => state.activityFilter === "all" || matchesFilter(e.kind, state.activityFilter))
    .slice(-500);
  if (!events.length) {
    host.innerHTML = `<div class="muted text-sm" style="padding: var(--sp-3);">No events yet.</div>`;
    return;
  }
  host.innerHTML = events.slice().reverse().map(e => renderEventRow(e)).join("");
}
function matchesFilter(kind, filter) {
  if (filter === "trades")    return kind === "trade";
  if (filter === "coach")     return kind === "coach";
  if (filter === "transfers") return kind === "transfer";
  if (filter === "orders")    return kind === "order";
  if (filter === "signups")   return kind === "signup";
  return true;
}
function renderEventRow(ev) {
  const icon = ({ trade: "🟢", coach: "💬", transfer: "💸", order: "📊", signup: "✨", admin: "🛠" })[ev.kind] || "•";
  const payload = ev.payload?.row || ev.payload || {};
  let summary = "";
  if (ev.kind === "trade")    summary = `${payload.side} ${payload.qty} ${payload.symbol} @ ${formatRupees(payload.price_paise || 0, { compact: true })}`;
  else if (ev.kind === "coach") summary = `${payload.event_type || ""} ${payload.trigger_symbol || ""}`;
  else if (ev.kind === "transfer") summary = `${formatRupees(payload.amount_paise || 0, { compact: true })} (${payload.status})`;
  else if (ev.kind === "order")    summary = `${payload.side} ${payload.qty} ${payload.symbol} — ${payload.status}`;
  else if (ev.kind === "signup")   summary = `@${payload.username || (payload.id || "").slice(0, 8)}`;
  else if (ev.kind === "admin")    summary = `${payload.action} · ${payload.reason || ""}`;
  return `<div class="activity-row"><span class="act-icon">${icon}</span><span class="act-kind">${escapeHtml(ev.kind)}</span><span class="act-summary">${escapeHtml(summary)}</span><span class="act-ts dim">${formatDateShort(ev.ts)}</span></div>`;
}

function openTail(main) {
  if (state.tail) return;
  const token = getToken();
  if (!token) { toast({ kind: "error", message: "No admin token." }); return; }
  const url = `/api/ai?op=admin-tail&token=${encodeURIComponent(token)}`;
  const es = new EventSource(url);
  state.tail = es;
  es.addEventListener("open", () => { state.tailConnected = true; updateTailBadge(main); });
  es.addEventListener("error", () => { state.tailConnected = false; updateTailBadge(main); });
  ["trade", "coach", "transfer", "order", "signup", "admin"].forEach(kind => {
    es.addEventListener(kind, (e) => {
      try {
        const ev = JSON.parse(e.data);
        state.activity.push(ev);
        if (state.activity.length > 500) state.activity.shift();
        if (currentTab === "activity") repaintActivity();
      } catch {}
    });
  });
  es.addEventListener("close", () => { state.tailConnected = false; state.tail = null; updateTailBadge(main); });
}
function closeTail() {
  if (state.tail) { try { state.tail.close(); } catch {} state.tail = null; }
  state.tailConnected = false;
}
function updateTailBadge(main) {
  const el = main.querySelector("#tail-indicator");
  const btn = main.querySelector("#tail-toggle");
  if (el) { el.className = `tail-indicator ${state.tailConnected ? "live" : "off"}`; el.textContent = state.tailConnected ? "● LIVE" : "○ paused"; }
  if (btn) btn.textContent = state.tailConnected ? "Pause tail" : "Live tail";
}

// -----------------------------------------------------------------------------
// Database tab — SQL editor, table browser, RPC runner, schema, stats
// -----------------------------------------------------------------------------
const dbState = {
  tables: null, schema: null, stats: null,
  browseTable: null, browseRows: [], browseTotal: 0, browseOffset: 0, browseLimit: 50, browseOrderBy: "", browseOrderDir: "desc", browseFilter: "",
  sqlInput: "select * from profiles limit 10;",
  sqlResult: null, sqlRunning: false,
  rpcName: "", rpcParams: "{}", rpcResult: null,
  view: "browser",  // browser | sql | rpc | schema | stats
};
function renderDatabaseTab(host, main) {
  host.innerHTML = `
    <div class="card" style="margin-bottom: var(--sp-3);">
      <div class="card-head">
        <h3>Supabase god mode</h3>
        <div class="flex gap-2">
          ${["browser","sql","rpc","schema","stats"].map(v => `<button class="btn btn-ghost btn-sm ${dbState.view === v ? "active-btn" : ""}" data-db-view="${v}">${v}</button>`).join("")}
        </div>
      </div>
      <div id="db-view-body"></div>
    </div>`;
  host.querySelectorAll("[data-db-view]").forEach(b => b.addEventListener("click", () => {
    dbState.view = b.dataset.dbView;
    renderDatabaseTab(host, main);
  }));
  renderDbView(host);
}
async function renderDbView(host) {
  const body = host.querySelector("#db-view-body");
  if (!body) return;
  if (dbState.view === "browser") return renderDbBrowser(body);
  if (dbState.view === "sql") return renderDbSql(body);
  if (dbState.view === "rpc") return renderDbRpc(body);
  if (dbState.view === "schema") return renderDbSchema(body);
  if (dbState.view === "stats") return renderDbStats(body);
}

async function renderDbBrowser(body) {
  body.innerHTML = `<div class="muted">Loading table list…</div>`;
  if (!dbState.tables) {
    try { dbState.tables = (await adminGet("/api/ai?op=admin-db-tables")).tables || []; }
    catch (e) { body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`; return; }
  }
  const t = dbState.browseTable;
  body.innerHTML = `
    <div class="flex gap-2 wrap" style="margin-bottom: var(--sp-3);">
      <div id="db-table-picker" style="min-width: 280px; max-width: 380px;"></div>
      ${t ? `
        <input class="input" id="db-order" placeholder="order by col" value="${escapeAttr(dbState.browseOrderBy)}" style="max-width: 140px;" />
        <div id="db-order-dir" style="min-width: 120px;"></div>
        <input class="input" id="db-filter" placeholder="filter (e.g. age=gte.13)" value="${escapeAttr(dbState.browseFilter)}" style="flex:1;" />
        <button class="btn btn-primary btn-sm" id="db-browse-go">Apply</button>
      ` : ""}
    </div>
    <div id="db-browse-result"></div>`;
  mountThemedSelect(body.querySelector("#db-table-picker"), {
    value: dbState.browseTable || "",
    placeholder: "pick a table…",
    options: [
      { value: "", label: "— pick a table —" },
      ...dbState.tables.map(x => ({
        value: x.table_name,
        label: x.table_name,
        hint: `${x.approx_row_count} rows · ${x.total_size}`,
      })),
    ],
    onChange: v => {
      dbState.browseTable = v || null;
      dbState.browseOffset = 0;
      renderDbBrowser(body);
      if (dbState.browseTable) fetchBrowserRows(body);
    },
  });
  if (t) {
    mountThemedSelect(body.querySelector("#db-order-dir"), {
      value: dbState.browseOrderDir,
      options: [{ value: "desc", label: "Desc ↓" }, { value: "asc", label: "Asc ↑" }],
      onChange: v => { dbState.browseOrderDir = v; },
    });
  }
  body.querySelector("#db-order")?.addEventListener("change", e => { dbState.browseOrderBy = e.target.value; });
  body.querySelector("#db-filter")?.addEventListener("change", e => { dbState.browseFilter = e.target.value; });
  body.querySelector("#db-browse-go")?.addEventListener("click", () => fetchBrowserRows(body));
  if (t && dbState.browseRows.length === 0) fetchBrowserRows(body);
  else if (t) paintBrowserRows(body);
}
async function fetchBrowserRows(body) {
  const resultHost = body.querySelector("#db-browse-result");
  resultHost.innerHTML = `<div class="muted">Loading rows…</div>`;
  try {
    const q = new URLSearchParams({
      op: "admin-db-browse",
      table: dbState.browseTable,
      limit: dbState.browseLimit,
      offset: dbState.browseOffset,
    });
    if (dbState.browseOrderBy) { q.set("orderBy", dbState.browseOrderBy); q.set("orderDir", dbState.browseOrderDir); }
    if (dbState.browseFilter) q.set("filter", dbState.browseFilter);
    const r = await adminGet("/api/ai?" + q);
    dbState.browseRows = r.rows || [];
    dbState.browseTotal = r.total || 0;
    paintBrowserRows(body);
  } catch (e) {
    resultHost.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`;
  }
}
function paintBrowserRows(body) {
  const host = body.querySelector("#db-browse-result");
  if (!host) return;
  if (!dbState.browseRows.length) {
    host.innerHTML = `<div class="muted text-sm">Empty result.</div>`; return;
  }
  const cols = Object.keys(dbState.browseRows[0]);
  host.innerHTML = `
    <div class="dim text-xs" style="margin-bottom: 6px;">
      Showing ${dbState.browseOffset + 1}–${dbState.browseOffset + dbState.browseRows.length} of ${dbState.browseTotal}
      <button class="btn btn-ghost btn-sm" data-browse-prev ${dbState.browseOffset === 0 ? "disabled" : ""}>← prev</button>
      <button class="btn btn-ghost btn-sm" data-browse-next ${dbState.browseOffset + dbState.browseLimit >= dbState.browseTotal ? "disabled" : ""}>next →</button>
    </div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join("")}<th></th></tr></thead>
        <tbody>
          ${dbState.browseRows.map((row, i) => `<tr>
            ${cols.map(c => `<td class="dim text-xs" style="max-width: 240px; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(typeof row[c] === "object" ? JSON.stringify(row[c]).slice(0, 80) : String(row[c] ?? ""))}</td>`).join("")}
            <td><button class="btn btn-ghost btn-sm" data-edit-row="${i}">edit</button>
                <button class="btn btn-ghost btn-sm" data-delete-row="${i}" style="color:var(--negative);">del</button></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  host.querySelector("[data-browse-prev]")?.addEventListener("click", () => {
    dbState.browseOffset = Math.max(0, dbState.browseOffset - dbState.browseLimit);
    fetchBrowserRows(body);
  });
  host.querySelector("[data-browse-next]")?.addEventListener("click", () => {
    dbState.browseOffset = dbState.browseOffset + dbState.browseLimit;
    fetchBrowserRows(body);
  });
  host.querySelectorAll("[data-edit-row]").forEach(b => b.addEventListener("click", async () => {
    const idx = parseInt(b.dataset.editRow, 10);
    const row = dbState.browseRows[idx];
    const pkCol = row.id ? "id" : Object.keys(row)[0];
    const pkVal = row[pkCol];
    const col = prompt("Column to edit:");
    if (!col) return;
    const newVal = prompt(`New value for ${col} (current: ${row[col]}):`);
    if (newVal == null) return;
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try {
      await adminPost("/api/ai?op=admin-db-row-patch", {
        table: dbState.browseTable, filter: `${pkCol}=eq.${encodeURIComponent(pkVal)}`, patch: { [col]: newVal }, reason,
      });
      toast({ kind: "success", message: "Row updated." });
      fetchBrowserRows(body);
    } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-delete-row]").forEach(b => b.addEventListener("click", async () => {
    const idx = parseInt(b.dataset.deleteRow, 10);
    const row = dbState.browseRows[idx];
    const pkCol = row.id ? "id" : Object.keys(row)[0];
    const pkVal = row[pkCol];
    if (!confirm(`Delete row where ${pkCol}=${pkVal}?`)) return;
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try {
      await adminPost("/api/ai?op=admin-db-row-delete", {
        table: dbState.browseTable, filter: `${pkCol}=eq.${encodeURIComponent(pkVal)}`, reason,
      });
      toast({ kind: "success", message: "Row deleted." });
      fetchBrowserRows(body);
    } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
}

function renderDbSql(body) {
  body.innerHTML = `
    <div class="db-sql-warn">⚠ Raw SQL via admin_exec_sql RPC. Mutations are audited. Triple-check before running DDL.</div>
    <textarea class="input db-sql-input" id="db-sql-input" rows="8">${escapeHtml(dbState.sqlInput)}</textarea>
    <div class="flex gap-2" style="margin: var(--sp-3) 0;">
      <button class="btn btn-primary" id="db-sql-run">Execute</button>
      <input class="input" id="db-sql-reason" placeholder="Reason (≥ 8 chars, audit-logged)" style="flex:1;" />
    </div>
    <div id="db-sql-result"></div>`;
  body.querySelector("#db-sql-input").addEventListener("input", e => { dbState.sqlInput = e.target.value; });
  body.querySelector("#db-sql-run").addEventListener("click", async () => {
    const sql = dbState.sqlInput.trim();
    const reason = body.querySelector("#db-sql-reason").value.trim();
    if (!sql) return;
    if (reason.length < 8) { toast({ kind: "error", message: "Reason must be ≥ 8 chars." }); return; }
    // DDL confirmation
    const isDDL = /^\s*(drop|alter|create|truncate|grant|revoke)\s/i.test(sql);
    if (isDDL) {
      const ok = prompt("This looks like DDL. Type 'I understand RLS' to proceed:");
      if (ok !== "I understand RLS") return;
    }
    dbState.sqlRunning = true;
    body.querySelector("#db-sql-result").innerHTML = `<div class="muted">Running…</div>`;
    try {
      const r = await adminPost("/api/ai?op=admin-db-sql", { sql, reason });
      dbState.sqlResult = r;
      paintSqlResult(body);
    } catch (e) {
      body.querySelector("#db-sql-result").innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`;
    } finally { dbState.sqlRunning = false; }
  });
  if (dbState.sqlResult) paintSqlResult(body);
}
function paintSqlResult(body) {
  const host = body.querySelector("#db-sql-result");
  if (!host || !dbState.sqlResult) return;
  const r = dbState.sqlResult;
  if (r.error) { host.innerHTML = `<div style="color:var(--negative);">Error: ${escapeHtml(r.error)} ${r.sqlstate ? `(${r.sqlstate})` : ""}</div>`; return; }
  const rows = r.rows || [];
  if (!rows.length) { host.innerHTML = `<div class="muted">0 rows.</div>`; return; }
  const cols = Object.keys(rows[0]);
  host.innerHTML = `
    <div class="dim text-xs">${rows.length} rows</div>
    <div class="admin-table-wrap">
      <table class="admin-table"><thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(row => `<tr>${cols.map(c => `<td class="dim text-xs">${escapeHtml(typeof row[c] === "object" ? JSON.stringify(row[c]).slice(0, 100) : String(row[c] ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody></table>
    </div>`;
}

function renderDbRpc(body) {
  body.innerHTML = `
    <div style="margin-bottom: var(--sp-3);">
      <input class="input" id="rpc-name" placeholder="RPC name (e.g. leaderboard)" value="${escapeAttr(dbState.rpcName)}" style="width: 300px;" />
      <textarea class="input" id="rpc-params" placeholder='{ "p_limit": 10 }' rows="4" style="width: 100%; margin-top: 8px;">${escapeHtml(dbState.rpcParams)}</textarea>
      <input class="input" id="rpc-reason" placeholder="Reason (≥ 8 chars)" style="margin-top: 8px;" />
      <button class="btn btn-primary" id="rpc-run" style="margin-top: 8px;">Invoke</button>
    </div>
    <div id="rpc-result"></div>`;
  body.querySelector("#rpc-run").addEventListener("click", async () => {
    const rpcName = body.querySelector("#rpc-name").value.trim();
    const params = body.querySelector("#rpc-params").value.trim();
    const reason = body.querySelector("#rpc-reason").value.trim();
    if (!rpcName) return;
    if (reason.length < 8) { toast({ kind: "error", message: "Reason ≥ 8 chars." }); return; }
    let parsedParams = {};
    try { parsedParams = params ? JSON.parse(params) : {}; } catch { toast({ kind: "error", message: "Params must be valid JSON." }); return; }
    try {
      const r = await adminPost("/api/ai?op=admin-db-rpc", { rpcName, params: parsedParams, reason });
      dbState.rpcResult = r;
      body.querySelector("#rpc-result").innerHTML = `<pre class="admin-coach-payload">${escapeHtml(JSON.stringify(r.result, null, 2))}</pre>`;
    } catch (e) {
      body.querySelector("#rpc-result").innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`;
    }
  });
}

async function renderDbSchema(body) {
  body.innerHTML = `<div class="muted">Loading schema…</div>`;
  try { dbState.schema = dbState.schema || await adminGet("/api/ai?op=admin-db-schema"); }
  catch (e) { body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`; return; }
  const s = dbState.schema;
  body.innerHTML = `
    <div class="admin-user-grid">
      <div>
        <div class="admin-user-section-label">Columns (${s.columns.length})</div>
        ${renderList(s.columns, c => `<div class="dim text-xs"><strong>${escapeHtml(c.table_name)}.${escapeHtml(c.column_name)}</strong> · ${escapeHtml(c.data_type)} ${c.is_nullable === "YES" ? "·null ok" : ""}</div>`)}
      </div>
      <div>
        <div class="admin-user-section-label">Policies (${s.policies.length})</div>
        ${renderList(s.policies, p => `<div class="dim text-xs"><strong>${escapeHtml(p.tablename)}.${escapeHtml(p.policyname)}</strong> · ${escapeHtml(p.cmd)}</div>`)}
      </div>
      <div>
        <div class="admin-user-section-label">Indexes (${s.indexes.length})</div>
        ${renderList(s.indexes, i => `<div class="dim text-xs"><strong>${escapeHtml(i.indexname)}</strong> on ${escapeHtml(i.tablename)}</div>`)}
      </div>
      <div>
        <div class="admin-user-section-label">Functions (${s.functions.length})</div>
        ${renderList(s.functions, f => `<div class="dim text-xs"><strong>${escapeHtml(f.routine_name)}</strong> → ${escapeHtml(f.return_type)}</div>`)}
      </div>
    </div>`;
}
function renderList(items, fmt) { return items.length ? `<div class="flex-col gap-1" style="max-height: 300px; overflow: auto; padding: 8px; background: var(--bg-soft); border-radius: 4px;">${items.map(fmt).join("")}</div>` : `<div class="muted text-sm">None.</div>`; }

async function renderDbStats(body) {
  body.innerHTML = `<div class="muted">Loading DB stats…</div>`;
  try { dbState.stats = dbState.stats || await adminGet("/api/ai?op=admin-db-stats"); }
  catch (e) { body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`; return; }
  const s = dbState.stats;
  body.innerHTML = `
    <div class="admin-user-grid">
      <div>
        <div class="admin-user-section-label">Database size</div>
        <div class="admin-kv"><span>Size</span><span>${escapeHtml(s.size?.size || "—")}</span></div>
        <div class="admin-kv"><span>Bytes</span><span class="tabular">${s.size?.bytes ?? "—"}</span></div>
      </div>
      <div>
        <div class="admin-user-section-label">Connections by state</div>
        ${s.connections.map(c => `<div class="admin-kv"><span>${escapeHtml(c.state || "idle")}</span><span class="tabular">${c.count}</span></div>`).join("") || `<div class="muted text-sm">None.</div>`}
      </div>
      <div>
        <div class="admin-user-section-label">Cache hit ratio</div>
        <div class="admin-kv"><span>Hit ratio</span><span>${s.cacheHitRatio?.hit_ratio ? (s.cacheHitRatio.hit_ratio * 100).toFixed(2) + "%" : "—"}</span></div>
        <div class="admin-kv"><span>Hits</span><span class="tabular">${s.cacheHitRatio?.hits ?? "—"}</span></div>
        <div class="admin-kv"><span>Reads</span><span class="tabular">${s.cacheHitRatio?.reads ?? "—"}</span></div>
      </div>
    </div>`;
}

// -----------------------------------------------------------------------------
// Auth tab — Supabase Auth users admin
// -----------------------------------------------------------------------------
const authState = { users: null, loading: false };
async function renderAuthTab(host, main) {
  if (!authState.users && !authState.loading) {
    authState.loading = true;
    try { authState.users = (await adminGet("/api/ai?op=admin-auth-users&perPage=500")).users || []; }
    catch (e) { host.innerHTML = `<div class="card"><div style="color:var(--negative);">${escapeHtml(e.message)}</div></div>`; return; }
    finally { authState.loading = false; }
  }
  host.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>Supabase Auth users (${authState.users?.length || 0})</h3>
        <button class="btn btn-ghost btn-sm" id="auth-refresh">↻ Refresh</button>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Email</th><th>Last sign-in</th><th>Confirmed</th><th>Banned</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>
            ${(authState.users || []).slice(0, 500).map(u => `<tr>
              <td><div class="font-semi">${escapeHtml(u.email || "—")}</div>
                  <div class="dim text-xs">${escapeHtml((u.id || "").slice(0, 8))}</div></td>
              <td class="dim text-xs">${u.lastSignInAt ? formatDateShort(u.lastSignInAt) : "—"}</td>
              <td>${u.emailConfirmedAt ? '<span class="pill pill-green" style="font-size:10px;">yes</span>' : '<span class="pill" style="font-size:10px;background:var(--bg-subtle);color:var(--text-dim);">no</span>'}</td>
              <td>${u.bannedUntil ? '<span class="pill pill-red" style="font-size:10px;">banned</span>' : "—"}</td>
              <td class="dim text-xs">${formatDateShort(u.createdAt)}</td>
              <td>
                <button class="btn btn-ghost btn-sm" data-auth-reset-email="${escapeAttr(u.email)}" title="Send password reset email">reset pw</button>
                <button class="btn btn-ghost btn-sm" data-auth-magic-email="${escapeAttr(u.email)}" title="Generate magic-link">magic</button>
                ${!u.emailConfirmedAt ? `<button class="btn btn-ghost btn-sm" data-force-confirm="${escapeAttr(u.id)}" title="Force email_confirmed_at = now() without requiring the user to click">confirm</button>` : ""}
                ${u.bannedUntil ? `<button class="btn btn-ghost btn-sm" data-unban-user="${escapeAttr(u.id)}">unban</button>` : `<button class="btn btn-ghost btn-sm" data-ban-user="${escapeAttr(u.id)}" style="color:var(--negative);">ban</button>`}
                <button class="btn btn-ghost btn-sm" data-delete-auth-user="${escapeAttr(u.id)}" data-auth-email="${escapeAttr(u.email)}" style="color:var(--negative); font-weight: 700;" title="Cascade delete auth.users + profile + holdings + transactions + coach_messages + everything else">delete</button>
              </td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
  host.querySelector("#auth-refresh").addEventListener("click", () => { authState.users = null; renderTabBody(main); });
  host.querySelectorAll("[data-auth-reset-email]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-auth-reset", { email: b.dataset.authResetEmail, reason }); toast({ kind: "success", message: "Sent." }); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-auth-magic-email]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { const r = await adminPost("/api/ai?op=admin-auth-magiclink", { email: b.dataset.authMagicEmail, reason }); toast({ kind: "success", message: "Link: " + (r.link || "sent.") }); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-force-confirm]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-auth-force-confirm", { userId: b.dataset.forceConfirm, reason }); toast({ kind: "success", message: "Confirmed." }); authState.users = null; renderTabBody(main); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-ban-user]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-user-ban", { userId: b.dataset.banUser, reason }); toast({ kind: "success", message: "Banned." }); authState.users = null; renderTabBody(main); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-unban-user]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-user-unban", { userId: b.dataset.unbanUser, reason }); toast({ kind: "success", message: "Unbanned." }); authState.users = null; renderTabBody(main); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-delete-auth-user]").forEach(b => b.addEventListener("click", async () => {
    const email = b.dataset.authEmail;
    // Need the profile username as the confirm token — opAdminUserDelete requires confirm === username.
    // Fetch the user's profile row first to get it.
    let username = "";
    try {
      const res = await adminGet("/api/ai?op=admin-user&id=" + encodeURIComponent(b.dataset.deleteAuthUser));
      username = res?.profile?.username || "";
    } catch {}
    if (!username) {
      toast({ kind: "error", message: "Couldn't resolve profile for this auth user — they may have a row in auth.users but no profile row. Cannot delete safely via this flow." });
      return;
    }
    const confirm = prompt(`DESTRUCTIVE: this cascades through profile + holdings + transactions + coach_messages + transfers + watchlist + limit_orders.\n\nType the username (${username}) to confirm:`);
    if (confirm !== username) return;
    const reason = prompt("Reason (≥ 8 chars, logged to audit):"); if (!reason || reason.trim().length < 8) return;
    try {
      await adminPost("/api/ai?op=admin-user-delete", { userId: b.dataset.deleteAuthUser, confirm: username, reason });
      toast({ kind: "success", message: `Deleted @${username} (${email}).` });
      authState.users = null;
      renderTabBody(main);
    } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
}

// -----------------------------------------------------------------------------
// Deploy tab — Vercel
// -----------------------------------------------------------------------------
const deployState = { deployments: null, envs: null, domains: null, view: "deployments", selectedLogs: null };
async function renderDeployTab(host, main) {
  host.innerHTML = `
    <div class="card" style="margin-bottom: var(--sp-3);">
      <div class="card-head">
        <h3>Vercel</h3>
        <div class="flex gap-2">
          ${["deployments","envs","domains"].map(v => `<button class="btn btn-ghost btn-sm ${deployState.view === v ? "active-btn" : ""}" data-dep-view="${v}">${v}</button>`).join("")}
        </div>
      </div>
      <div id="dep-body"></div>
    </div>`;
  host.querySelectorAll("[data-dep-view]").forEach(b => b.addEventListener("click", () => { deployState.view = b.dataset.depView; renderDeployTab(host, main); }));
  const body = host.querySelector("#dep-body");
  if (deployState.view === "deployments") return renderDeployDeployments(body);
  if (deployState.view === "envs") return renderDeployEnvs(body);
  if (deployState.view === "domains") return renderDeployDomains(body);
}
async function renderDeployDeployments(body) {
  body.innerHTML = `<div class="muted">Loading deployments…</div>`;
  try {
    const data = deployState.deployments || (deployState.deployments = await adminGet("/api/ai?op=admin-vercel-deployments&limit=30"));
    const d = data.deployments || [];
    body.innerHTML = `
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>When</th><th>Status</th><th>Target</th><th>Commit</th><th>Creator</th><th>URL</th><th>Actions</th></tr></thead>
          <tbody>
            ${d.map(x => `<tr>
              <td class="dim text-xs">${x.created ? formatDateShort(new Date(x.created).toISOString()) : "—"}</td>
              <td><span class="pill ${x.state === "READY" ? "pill-green" : x.state === "ERROR" ? "pill-red" : "pill-neutral"}" style="font-size:10px;">${escapeHtml(x.state || x.readyState || "?")}</span></td>
              <td class="dim text-xs">${escapeHtml(x.target || "preview")}</td>
              <td class="dim text-xs">${escapeHtml((x.meta?.githubCommitSha || "").slice(0, 7) || "—")}</td>
              <td class="dim text-xs">${escapeHtml(x.creator?.username || "—")}</td>
              <td><a href="https://${escapeAttr(x.url || "")}" target="_blank" class="btn-link">${escapeHtml((x.url || "").slice(0, 40))}</a></td>
              <td>
                <button class="btn btn-ghost btn-sm" data-view-logs="${escapeAttr(x.uid || x.id)}">logs</button>
                <button class="btn btn-ghost btn-sm" data-redeploy="${escapeAttr(x.uid || x.id)}">redeploy</button>
                ${x.target !== "production" && x.state === "READY" ? `<button class="btn btn-ghost btn-sm" data-promote="${escapeAttr(x.uid || x.id)}" style="color:var(--warning);">promote</button>` : ""}
              </td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <div id="dep-logs" style="margin-top: var(--sp-3);"></div>`;
    body.querySelectorAll("[data-view-logs]").forEach(b => b.addEventListener("click", async () => {
      const id = b.dataset.viewLogs;
      const logsHost = body.querySelector("#dep-logs");
      logsHost.innerHTML = `<div class="muted">Loading logs for ${escapeHtml(id)}…</div>`;
      try {
        const logs = await adminGet("/api/ai?op=admin-vercel-logs&id=" + encodeURIComponent(id));
        logsHost.innerHTML = `<div class="card"><div class="card-head"><h3>Logs · ${escapeHtml(id)}</h3></div><pre class="admin-coach-payload" style="max-height: 500px;">${escapeHtml(JSON.stringify(logs.events || logs, null, 2))}</pre></div>`;
      } catch (e) { logsHost.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`; }
    }));
    body.querySelectorAll("[data-redeploy]").forEach(b => b.addEventListener("click", async () => {
      const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
      try { await adminPost("/api/ai?op=admin-vercel-redeploy", { deploymentId: b.dataset.redeploy, reason }); toast({ kind: "success", message: "Redeploy triggered." }); }
      catch (e) { toast({ kind: "error", message: e.message }); }
    }));
    body.querySelectorAll("[data-promote]").forEach(b => b.addEventListener("click", async () => {
      const id = b.dataset.promote;
      const confirm = prompt(`DESTRUCTIVE. Type last 8 chars of deployment ID (${id.slice(-8)}) to confirm:`);
      if (confirm !== id.slice(-8)) return;
      const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
      try { await adminPost("/api/ai?op=admin-vercel-rollback", { deploymentId: id, confirm: id.slice(-8), reason }); toast({ kind: "success", message: "Promoted." }); }
      catch (e) { toast({ kind: "error", message: e.message }); }
    }));
  } catch (e) {
    body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div><div class="muted text-sm" style="margin-top: 8px;">Add <code>VERCEL_TOKEN</code> + <code>VERCEL_PROJECT_ID</code> to Vercel env vars to enable this tab.</div>`;
  }
}
async function renderDeployEnvs(body) {
  body.innerHTML = `<div class="muted">Loading env vars…</div>`;
  try {
    const data = await adminGet("/api/ai?op=admin-vercel-envs");
    body.innerHTML = `
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Key</th><th>Target</th><th>Value (masked)</th><th>Length</th><th>Updated</th><th>Act</th></tr></thead>
          <tbody>
            ${(data.envs || []).map(e => `<tr>
              <td class="font-semi">${escapeHtml(e.key)}</td>
              <td class="dim text-xs">${Array.isArray(e.target) ? e.target.join(", ") : "—"}</td>
              <td class="dim text-xs font-mono">${escapeHtml(e.maskedValue || "—")}</td>
              <td class="tabular">${e.valueLength}</td>
              <td class="dim text-xs">${formatDateShort(e.updatedAt)}</td>
              <td>
                <button class="btn btn-ghost btn-sm" data-env-update="${escapeAttr(e.id)}" data-env-key="${escapeAttr(e.key)}">edit</button>
                <button class="btn btn-ghost btn-sm" data-env-delete="${escapeAttr(e.id)}" data-env-key="${escapeAttr(e.key)}" style="color:var(--negative);">del</button>
              </td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top: var(--sp-3);">
        <h3>Create new env var</h3>
        <div class="flex gap-2 wrap">
          <input class="input" id="env-new-key" placeholder="KEY" />
          <input class="input" id="env-new-value" placeholder="value" type="password" />
          <input class="input" id="env-new-reason" placeholder="reason" />
          <button class="btn btn-primary btn-sm" id="env-create">Create</button>
        </div>
        <p class="dim text-xs" style="margin-top: 6px;">New env vars apply on next function cold start (~30s).</p>
      </div>`;
    body.querySelectorAll("[data-env-update]").forEach(b => b.addEventListener("click", async () => {
      const key = b.dataset.envKey;
      const confirm = prompt(`DESTRUCTIVE. Type env var name (${key}) to confirm edit:`);
      if (confirm !== key) return;
      const newVal = prompt(`New value for ${key}:`); if (newVal == null) return;
      const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
      try { await adminPost("/api/ai?op=admin-vercel-env-patch", { action: "update", envId: b.dataset.envUpdate, key, confirm: key, value: newVal, reason }); toast({ kind: "success", message: "Updated. Apply on next cold start." }); }
      catch (e) { toast({ kind: "error", message: e.message }); }
    }));
    body.querySelectorAll("[data-env-delete]").forEach(b => b.addEventListener("click", async () => {
      const key = b.dataset.envKey;
      const confirm = prompt(`DESTRUCTIVE. Type env var name (${key}) to confirm delete:`);
      if (confirm !== key) return;
      const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
      try { await adminPost("/api/ai?op=admin-vercel-env-patch", { action: "delete", envId: b.dataset.envDelete, key, confirm: key, reason }); toast({ kind: "success", message: "Deleted." }); }
      catch (e) { toast({ kind: "error", message: e.message }); }
    }));
    body.querySelector("#env-create").addEventListener("click", async () => {
      const key = body.querySelector("#env-new-key").value.trim();
      const value = body.querySelector("#env-new-value").value;
      const reason = body.querySelector("#env-new-reason").value.trim();
      if (!key || !value) return;
      if (reason.length < 8) { toast({ kind: "error", message: "Reason ≥ 8 chars." }); return; }
      const confirm = prompt(`Confirm creation. Type env var name (${key}):`);
      if (confirm !== key) return;
      try { await adminPost("/api/ai?op=admin-vercel-env-patch", { action: "create", key, confirm: key, value, reason }); toast({ kind: "success", message: "Created." }); }
      catch (e) { toast({ kind: "error", message: e.message }); }
    });
  } catch (e) { body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`; }
}
async function renderDeployDomains(body) {
  body.innerHTML = `<div class="muted">Loading domains…</div>`;
  try {
    const data = await adminGet("/api/ai?op=admin-vercel-domains");
    const domains = data.domains || data || [];
    body.innerHTML = `<pre class="admin-coach-payload">${escapeHtml(JSON.stringify(domains, null, 2))}</pre>`;
  } catch (e) { body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`; }
}

// -----------------------------------------------------------------------------
// Repo tab — GitHub
// -----------------------------------------------------------------------------
const repoState = { commits: null, prs: null, issues: null, runs: null, branches: null, contributors: null, view: "commits" };
async function renderRepoTab(host, main) {
  host.innerHTML = `
    <div class="card" style="margin-bottom: var(--sp-3);">
      <div class="card-head">
        <h3>GitHub</h3>
        <div class="flex gap-2">
          ${["commits","prs","issues","runs","branches","contributors"].map(v => `<button class="btn btn-ghost btn-sm ${repoState.view === v ? "active-btn" : ""}" data-repo-view="${v}">${v}</button>`).join("")}
        </div>
      </div>
      <div id="repo-body"></div>
    </div>`;
  host.querySelectorAll("[data-repo-view]").forEach(b => b.addEventListener("click", () => { repoState.view = b.dataset.repoView; renderRepoTab(host, main); }));
  const body = host.querySelector("#repo-body");
  try {
    if (repoState.view === "commits") {
      repoState.commits = repoState.commits || await adminGet("/api/ai?op=admin-gh-commits&limit=30");
      body.innerHTML = `<div class="flex-col gap-2">${(repoState.commits.commits || []).map(c => `
        <div class="card" style="padding: 10px 12px;">
          <div class="font-semi">${escapeHtml(c.message)}</div>
          <div class="dim text-xs">${escapeHtml(c.shortSha)} · ${escapeHtml(c.author || "?")} · ${formatDateShort(c.date)} · <a href="${escapeAttr(c.url)}" target="_blank">view on GitHub</a></div>
        </div>`).join("")}</div>`;
    } else if (repoState.view === "prs") {
      repoState.prs = repoState.prs || await adminGet("/api/ai?op=admin-gh-prs&state=open&limit=30");
      const prs = repoState.prs.prs || [];
      body.innerHTML = prs.length ? prs.map(pr => `
        <div class="card" style="padding: 10px 12px; margin-bottom: 6px;">
          <div class="font-semi">#${pr.number} · ${escapeHtml(pr.title)}</div>
          <div class="dim text-xs">${escapeHtml(pr.user?.login || "?")} · ${escapeHtml(pr.state)} · ${formatDateShort(pr.created_at)}
            <button class="btn btn-ghost btn-sm" data-pr-merge="${pr.number}" style="float:right;">merge</button>
          </div>
        </div>`).join("") : `<div class="muted text-sm">No open PRs.</div>`;
      body.querySelectorAll("[data-pr-merge]").forEach(b => b.addEventListener("click", async () => {
        const id = b.dataset.prMerge;
        const confirm = prompt(`Type PR number (${id}) to confirm merge:`);
        if (confirm !== id) return;
        const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
        try { await adminPost("/api/ai?op=admin-gh-pr-merge", { prId: id, confirm: id, reason }); toast({ kind: "success", message: "Merged." }); repoState.prs = null; renderRepoTab(host, main); }
        catch (e) { toast({ kind: "error", message: e.message }); }
      }));
    } else if (repoState.view === "issues") {
      repoState.issues = repoState.issues || await adminGet("/api/ai?op=admin-gh-issues&state=open&limit=30");
      const issues = repoState.issues.issues || [];
      body.innerHTML = issues.length ? issues.map(i => `
        <div class="card" style="padding: 10px 12px; margin-bottom: 6px;">
          <div class="font-semi">#${i.number} · ${escapeHtml(i.title)}</div>
          <div class="dim text-xs">${escapeHtml(i.user?.login || "?")} · ${escapeHtml(i.state)} · ${formatDateShort(i.created_at)}
            <button class="btn btn-ghost btn-sm" data-issue-close="${i.number}" style="float:right;">close</button>
          </div>
        </div>`).join("") : `<div class="muted text-sm">No open issues.</div>`;
      body.querySelectorAll("[data-issue-close]").forEach(b => b.addEventListener("click", async () => {
        const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
        try { await adminPost("/api/ai?op=admin-gh-issue-close", { issueId: b.dataset.issueClose, reason }); toast({ kind: "success", message: "Closed." }); repoState.issues = null; renderRepoTab(host, main); }
        catch (e) { toast({ kind: "error", message: e.message }); }
      }));
    } else if (repoState.view === "runs") {
      repoState.runs = repoState.runs || await adminGet("/api/ai?op=admin-gh-actions-runs&limit=20");
      const runs = repoState.runs.workflow_runs || [];
      body.innerHTML = runs.length ? runs.map(r => `
        <div class="card" style="padding: 10px 12px; margin-bottom: 6px;">
          <div class="font-semi">${escapeHtml(r.name)} · ${escapeHtml(r.head_branch)}</div>
          <div class="dim text-xs">${escapeHtml(r.status)}/${escapeHtml(r.conclusion || "—")} · ${formatDateShort(r.created_at)} · <a href="${escapeAttr(r.html_url)}" target="_blank">view</a></div>
        </div>`).join("") : `<div class="muted text-sm">No workflow runs yet.</div>`;
    } else if (repoState.view === "branches") {
      repoState.branches = repoState.branches || await adminGet("/api/ai?op=admin-gh-branches");
      const branches = repoState.branches.branches || [];
      body.innerHTML = `<div class="flex gap-1 wrap">${branches.map(b => `<span class="pill">${escapeHtml(b.name)}</span>`).join("")}</div>`;
    } else if (repoState.view === "contributors") {
      repoState.contributors = repoState.contributors || await adminGet("/api/ai?op=admin-gh-contributors");
      const cs = repoState.contributors.contributors || [];
      body.innerHTML = `<ol class="admin-lb">${cs.map(c => `<li><a href="${escapeAttr(c.html_url)}" target="_blank">@${escapeHtml(c.login)}</a><span class="tabular">${c.contributions}</span></li>`).join("")}</ol>`;
    }
  } catch (e) { body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div><div class="muted text-sm" style="margin-top:8px;">Add <code>GITHUB_TOKEN</code> + <code>GITHUB_REPO</code> to Vercel env vars to enable this tab.</div>`; }
}

// -----------------------------------------------------------------------------
// Markets / AI cache tab
// -----------------------------------------------------------------------------
const marketsState = { aiCache: null, aiBucket: "", quoteCache: null, dhan: null, view: "ai-cache" };
async function renderMarketsTab(host, main) {
  host.innerHTML = `
    <div class="card" style="margin-bottom: var(--sp-3);">
      <div class="card-head">
        <h3>Markets &amp; AI cache</h3>
        <div class="flex gap-2">
          ${["ai-cache","quote-cache","dhan"].map(v => `<button class="btn btn-ghost btn-sm ${marketsState.view === v ? "active-btn" : ""}" data-mkt-view="${v}">${v}</button>`).join("")}
        </div>
      </div>
      <div id="mkt-body"></div>
    </div>`;
  host.querySelectorAll("[data-mkt-view]").forEach(b => b.addEventListener("click", () => { marketsState.view = b.dataset.mktView; renderMarketsTab(host, main); }));
  const body = host.querySelector("#mkt-body");
  if (marketsState.view === "ai-cache") return renderAiCacheView(body);
  if (marketsState.view === "quote-cache") return renderQuoteCacheView(body);
  if (marketsState.view === "dhan") return renderDhanView(body);
}
async function renderAiCacheView(body) {
  body.innerHTML = `<div class="muted">Loading AI cache…</div>`;
  try {
    const url = `/api/ai?op=admin-ai-cache&limit=500${marketsState.aiBucket ? `&bucket=${encodeURIComponent(marketsState.aiBucket)}` : ""}`;
    marketsState.aiCache = await adminGet(url);
  } catch (e) { body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`; return; }
  const { rows, bucketStats } = marketsState.aiCache;
  const buckets = Object.keys(bucketStats).sort();
  body.innerHTML = `
    <div class="flex gap-2 wrap" style="margin-bottom: var(--sp-3);">
      <div id="mkt-bucket" style="min-width: 280px;"></div>
      <button class="btn btn-ghost btn-sm" id="mkt-purge-bucket" ${marketsState.aiBucket ? "" : "disabled"}>Purge bucket</button>
    </div>
    <div class="flex-col gap-2">
      ${rows.slice(0, 100).map(r => `
        <details class="admin-coach-row">
          <summary>
            <strong>${escapeHtml(r.bucket)}</strong> · <span class="dim text-xs">${escapeHtml(r.display_key || r.cache_key)}</span>
            <span class="dim text-xs" style="float:right;">${r.hit_count} hits · ${formatDateShort(r.created_at)}
              <button class="btn btn-ghost btn-sm" data-cache-del="ai_response_cache" data-bucket="${escapeAttr(r.bucket)}" data-key="${escapeAttr(r.cache_key)}">del</button>
            </span>
          </summary>
          <pre class="admin-coach-payload">${escapeHtml(JSON.stringify(r.payload, null, 2))}</pre>
        </details>
      `).join("")}
    </div>
    ${rows.length === 0 ? '<div class="muted text-sm">No cache entries yet.</div>' : ""}`;
  mountThemedSelect(body.querySelector("#mkt-bucket"), {
    value: marketsState.aiBucket,
    options: [
      { value: "", label: "All buckets" },
      ...buckets.map(b => ({
        value: b,
        label: b,
        hint: `${bucketStats[b].count} rows · ${bucketStats[b].totalHits} hits`,
      })),
    ],
    onChange: v => { marketsState.aiBucket = v; marketsState.aiCache = null; renderAiCacheView(body); },
  });
  body.querySelector("#mkt-purge-bucket")?.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    const confirm = prompt(`Type bucket name (${marketsState.aiBucket}) to purge all rows:`); if (confirm !== marketsState.aiBucket) return;
    try { await adminPost("/api/ai?op=admin-cache-invalidate", { table: "ai_response_cache", bucket: marketsState.aiBucket, confirm, reason }); toast({ kind: "success", message: "Purged." }); marketsState.aiCache = null; renderAiCacheView(body); }
    catch (e) { toast({ kind: "error", message: e.message }); }
  });
  body.querySelectorAll("[data-cache-del]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-cache-invalidate", { table: "ai_response_cache", bucket: b.dataset.bucket, key: b.dataset.key, reason }); toast({ kind: "success", message: "Deleted." }); marketsState.aiCache = null; renderAiCacheView(body); }
    catch (err) { toast({ kind: "error", message: err.message }); }
  }));
}
async function renderQuoteCacheView(body) {
  body.innerHTML = `<div class="muted">Loading quote cache…</div>`;
  try { marketsState.quoteCache = marketsState.quoteCache || await adminGet("/api/ai?op=admin-quote-cache"); }
  catch (e) { body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`; return; }
  const rows = marketsState.quoteCache.rows || [];
  body.innerHTML = `
    <div class="dim text-xs" style="margin-bottom: 6px;">${rows.length} symbols cached</div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Symbol</th><th>Price</th><th>Change %</th><th>Day H/L</th><th title="Number of shares traded today">Shares traded</th><th>Source</th><th>Age</th><th>Act</th></tr></thead>
        <tbody>
          ${rows.slice(0, 500).map(r => `<tr>
            <td class="font-semi">${escapeHtml(r.symbol)}</td>
            <td class="tabular">${formatRupees(r.price_paise || 0)}</td>
            <td class="tabular ${(r.change_pct || 0) >= 0 ? "positive" : "negative"}">${(r.change_pct || 0).toFixed(2)}%</td>
            <td class="dim text-xs">${formatRupees(r.day_high_paise || 0, { compact: true })} / ${formatRupees(r.day_low_paise || 0, { compact: true })}</td>
            <td class="tabular">${(r.volume || 0).toLocaleString("en-IN")}</td>
            <td class="dim text-xs">${escapeHtml(r.source || "—")}</td>
            <td class="dim text-xs">${r.staleMs != null ? Math.floor(r.staleMs / 1000) + "s" : "—"}</td>
            <td><button class="btn btn-ghost btn-sm" data-quote-invalidate="${escapeAttr(r.symbol)}">reset</button></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  body.querySelectorAll("[data-quote-invalidate]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-cache-invalidate", { table: "quote_cache", symbol: b.dataset.quoteInvalidate, reason }); toast({ kind: "success", message: "Invalidated." }); marketsState.quoteCache = null; renderQuoteCacheView(body); }
    catch (e) { toast({ kind: "error", message: e.message }); }
  }));
}
async function renderDhanView(body) {
  body.innerHTML = `<div class="muted">Loading Dhan coverage…</div>`;
  try { marketsState.dhan = marketsState.dhan || await adminGet("/api/ai?op=admin-dhan-coverage"); }
  catch (e) { body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`; return; }
  const rows = marketsState.dhan.rows || [];
  body.innerHTML = `
    <div class="dim text-xs" style="margin-bottom: 6px;">${rows.length} symbols mapped to Dhan security IDs</div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Symbol</th><th>Security ID</th><th>Segment</th><th>Type</th><th>Lot size</th><th>Updated</th></tr></thead>
        <tbody>${rows.slice(0, 500).map(r => `<tr>
          <td class="font-semi">${escapeHtml(r.symbol)}</td>
          <td class="tabular">${r.security_id}</td>
          <td class="dim text-xs">${escapeHtml(r.exchange_segment || "—")}</td>
          <td class="dim text-xs">${escapeHtml(r.instrument_type || "—")}</td>
          <td class="tabular">${r.lot_size}</td>
          <td class="dim text-xs">${formatDateShort(r.updated_at)}</td>
        </tr>`).join("")}</tbody>
      </table>
    </div>`;
}

// -----------------------------------------------------------------------------
// Audit + System tab
// -----------------------------------------------------------------------------
const auditState = { rows: null, view: "log" };
async function renderAuditTab(host, main) {
  host.innerHTML = `
    <div class="card" style="margin-bottom: var(--sp-3);">
      <div class="card-head">
        <h3>Audit &amp; System</h3>
        <div class="flex gap-2">
          ${["log","system"].map(v => `<button class="btn btn-ghost btn-sm ${auditState.view === v ? "active-btn" : ""}" data-audit-view="${v}">${v}</button>`).join("")}
        </div>
      </div>
      <div id="audit-body"></div>
    </div>`;
  host.querySelectorAll("[data-audit-view]").forEach(b => b.addEventListener("click", () => { auditState.view = b.dataset.auditView; renderAuditTab(host, main); }));
  const body = host.querySelector("#audit-body");
  if (auditState.view === "log") return renderAuditLog(body);
  if (auditState.view === "system") return renderSystem(body);
}
async function renderAuditLog(body) {
  body.innerHTML = `<div class="muted">Loading audit log…</div>`;
  try { auditState.rows = auditState.rows || (await adminGet("/api/ai?op=admin-audit-log&limit=500")).rows || []; }
  catch (e) { body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`; return; }
  const rows = auditState.rows;
  if (!rows.length) { body.innerHTML = `<div class="muted text-sm">Audit log is empty. Every future admin write will leave a row.</div>`; return; }
  body.innerHTML = `
    <div class="dim text-xs" style="margin-bottom: 6px;">${rows.length} admin actions</div>
    <div class="flex-col gap-2">
      ${rows.slice(0, 200).map(r => `
        <details class="admin-coach-row">
          <summary>
            <strong>${escapeHtml(r.action)}</strong> · <span class="dim">${escapeHtml(r.target_kind || "—")} ${escapeHtml((r.target_id || "").slice(0, 16))}</span>
            <span class="dim text-xs" style="float:right;">${formatDateShort(r.ts)} · ${escapeHtml(r.actor_ip || "?")}</span>
          </summary>
          <div class="admin-kv"><span>Reason</span><span>${escapeHtml(r.reason || "—")}</span></div>
          ${r.note ? `<div class="admin-kv"><span>Note</span><span>${escapeHtml(r.note)}</span></div>` : ""}
          ${r.target_user_id ? `<div class="admin-kv"><span>Target user</span><span>${escapeHtml(r.target_user_id)}</span></div>` : ""}
          <details><summary class="dim text-xs">Before state</summary><pre class="admin-coach-payload">${escapeHtml(JSON.stringify(r.before_state, null, 2))}</pre></details>
          <details><summary class="dim text-xs">After state</summary><pre class="admin-coach-payload">${escapeHtml(JSON.stringify(r.after_state, null, 2))}</pre></details>
        </details>`).join("")}
    </div>`;
}
function renderSystem(body) {
  body.innerHTML = `
    <div class="admin-user-grid">
      <div class="card">
        <div class="card-head"><h3>Token</h3></div>
        <p class="muted text-sm" style="line-height: 1.6;">Admin token stays in Vercel env (<code>ADMIN_TOKEN</code>). Rotate there + paste new value into this browser's localStorage.</p>
        <button class="btn btn-ghost btn-sm" id="sys-clear-token">Clear local token (force re-auth)</button>
      </div>
      <div class="card">
        <div class="card-head"><h3>Portfolio history backfill</h3></div>
        <p class="muted text-sm" style="line-height: 1.6;">Reseed portfolio_history for every user from their transactions + current holdings. Run once on first deploy; daily snapshot fires automatically from transaction triggers + Vercel cron.</p>
        <div class="flex gap-2">
          <button class="btn btn-ghost btn-sm" id="sys-backfill-today">Today only</button>
          <button class="btn btn-primary btn-sm" id="sys-backfill-full">Full backfill</button>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Live tail health</h3></div>
        <div class="admin-kv"><span>Connected</span><span>${state.tailConnected ? "✓ yes" : "✗ no"}</span></div>
        <div class="admin-kv"><span>Buffered events</span><span class="tabular">${state.activity.length}</span></div>
      </div>
    </div>`;
  body.querySelector("#sys-clear-token").addEventListener("click", () => {
    setToken("");
    closeTail();
    toast({ kind: "success", message: "Token cleared. Reload to re-auth." });
  });
  const doBackfill = async (todayOnly) => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { const r = await adminPost("/api/ai?op=admin-backfill-history", { todayOnly, reason }); toast({ kind: "success", message: `Backfill complete: ${r.result?.rows_inserted || 0} rows for ${r.result?.users || 0} users.` }); }
    catch (e) { toast({ kind: "error", message: e.message }); }
  };
  body.querySelector("#sys-backfill-today").addEventListener("click", () => doBackfill(true));
  body.querySelector("#sys-backfill-full").addEventListener("click", async () => {
    if (!confirm("Full backfill will delete + re-insert every source='backfill' row. Continue?")) return;
    doBackfill(false);
  });
}

// -----------------------------------------------------------------------------
// Utility renderers
// -----------------------------------------------------------------------------
function kv(k, v) { return `<div class="admin-kv"><span>${escapeHtml(k)}</span><span>${escapeHtml(v ?? "—")}</span></div>`; }
// Render the coach section of the user-detail modal. Splits entries into:
//   - chat turns (event_type starts with "chat_") → threaded chat bubbles
//   - other events (trade reflections, crash replays) → collapsible JSON rows
// Chat turns are grouped into time-separated threads so the admin can
// see each session as a single conversation.
function renderCoachSection(coachMessages) {
  const msgs = Array.isArray(coachMessages) ? coachMessages : [];
  if (!msgs.length) {
    return `<div id="sec-coach"><div class="admin-user-section-label">10. Coach chat / messages (0)</div><div class="muted text-sm">No coach messages.</div></div>`;
  }
  // Server returns newest first — reverse for chronological chat order.
  const ordered = [...msgs].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const chatTurns = ordered.filter(m => typeof m.event_type === "string" && m.event_type.startsWith("chat_"));
  const otherEvents = ordered.filter(m => !m.event_type || !m.event_type.startsWith("chat_"));

  // Break chat turns into sessions (gap > 30 min = new session).
  const sessions = [];
  let cur = [];
  let lastTs = 0;
  for (const m of chatTurns) {
    const ts = new Date(m.created_at).getTime();
    if (cur.length && ts - lastTs > 30 * 60_000) {
      sessions.push(cur);
      cur = [];
    }
    cur.push(m);
    lastTs = ts;
  }
  if (cur.length) sessions.push(cur);

  const chatHtml = sessions.length
    ? sessions.reverse().map((session, i) => {
        const first = session[0];
        const last = session[session.length - 1];
        const dur = Math.max(0, new Date(last.created_at) - new Date(first.created_at));
        const durStr = dur < 60_000 ? `${Math.round(dur/1000)}s`
                      : dur < 3600_000 ? `${Math.round(dur/60_000)}m`
                      : `${Math.round(dur/3600_000)}h`;
        return `
          <details class="admin-coach-row" ${i === 0 ? "open" : ""}>
            <summary>
              <strong>💬 Chat session</strong> ·
              <span class="dim">${session.length} msg${session.length === 1 ? "" : "s"}</span> ·
              <span class="dim" style="font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px;">${formatDatePrecise(first.created_at)}</span>
              ${durStr !== "0s" ? `· <span class="dim">${durStr}</span>` : ""}
            </summary>
            <div class="admin-chat-thread">
              ${session.map(m => renderChatTurn(m)).join("")}
            </div>
          </details>
        `;
      }).join("")
    : "";

  const otherHtml = otherEvents.length
    ? `<details class="admin-coach-row"><summary><strong>⚙ Coach events</strong> · <span class="dim">${otherEvents.length} trade / replay reflections</span></summary>
        <div class="flex-col gap-2" style="margin-top: 8px;">
          ${otherEvents.reverse().map(m => `
            <details class="admin-coach-row">
              <summary><strong>${escapeHtml(m.event_type || "—")}</strong> · ${escapeHtml(m.trigger_symbol || "—")} · <span class="dim" style="font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px;">${formatDatePrecise(m.created_at)}</span> · model=${escapeHtml(m.model || "—")}
              <button class="btn btn-ghost btn-sm" data-delete-coach="${escapeAttr(m.id)}" style="float:right;">delete</button></summary>
              <pre class="admin-coach-payload">${escapeHtml(JSON.stringify(m.payload || {}, null, 2))}</pre>
            </details>`).join("")}
        </div>
      </details>`
    : "";

  return `<div id="sec-coach"><div class="admin-user-section-label">10. Coach chat / messages (${msgs.length})</div>
    ${chatHtml || `<div class="muted text-xs" style="margin-bottom: 8px;">No back-and-forth chats yet.</div>`}
    ${otherHtml}
  </div>`;
}

function renderChatTurn(m) {
  const isUser = m.event_type === "chat_user";
  const text = (m.payload && typeof m.payload.text === "string") ? m.payload.text : "";
  const ts = formatDatePrecise(m.created_at);
  // User messages stay plain (no markdown — user typed literal text).
  // Assistant messages render minimal markdown so **bold** looks correct.
  const body = isUser ? escapeHtml(text) : renderChatMarkdown(text);
  return `
    <div class="admin-chat-bubble ${isUser ? "user" : "assistant"}" title="${escapeAttr(ts)}">
      <div class="admin-chat-role">${isUser ? "USER" : "SAATHI"}</div>
      <div class="admin-chat-text">${body}</div>
      <div class="admin-chat-ts">${escapeHtml(ts)}${m.model && !isUser ? ` · ${escapeHtml(m.model)}` : ""}</div>
    </div>
  `;
}

function renderChatMarkdown(text) {
  if (!text) return "";
  let s = escapeHtml(String(text));
  s = s.replace(/\*\*([^\n*][^\n*]*?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^\n*][^\n*]*?)\*(?=[\s.,!?)]|$)/g, "$1<em>$2</em>");
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  return s;
}

function formatDateShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return Math.floor(diff / 60_000) + "m";
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + "h";
  if (diff < 7 * 86400_000) return Math.floor(diff / 86400_000) + "d";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}

// Audit-grade timestamp: "2026-04-22 18:35:42.193 IST" — 24-hour IST with
// millisecond precision. Used on admin fields where knowing the exact
// moment matters (signup, last active, individual coach messages).
function formatDatePrecise(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  // "hour" can be "24" at midnight in some locales; normalise to "00".
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}.${ms} IST`;
}
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
