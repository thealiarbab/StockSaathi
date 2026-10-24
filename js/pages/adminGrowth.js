// =============================================================================
// Admin: Growth tab — retention by sign-up week, time to first trade, what
// retained users did on day one, and feature adoption among active users.
// Data: admin_growth() (migration 2026-10-24a). "Active" = any user_events row.
// =============================================================================
const st = { weeks: 12 };

const esc = (s) => { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; };
const n = (v) => (v == null ? "–" : Number(v).toLocaleString("en-IN"));
const pct = (v) => (v == null ? "–" : `${v}%`);
const share = (a, b) => (b ? `${Math.round((1000 * a) / b) / 10}%` : "–");
const dur = (min) => {
  if (min == null) return "–";
  if (min < 60) return `${Math.round(min)} min`;
  if (min < 48 * 60) return `${Math.round(min / 6) / 10} h`;
  return `${Math.round(min / 144) / 10} d`;
};

export async function renderGrowthTab(host, { adminGet }) {
  host.innerHTML = `<div class="muted">Loading growth data…</div>`;
  let d;
  try { d = await adminGet(`/api/ai?op=admin-growth&weeks=${st.weeks}`); }
  catch (e) { host.innerHTML = `<div style="color:var(--negative);">${esc(e.message)}</div>`; return; }

  const cohorts = d.cohorts || [];
  const fd = d.first_day || {};
  const ad = d.adoption || [];
  const a7 = ad.find((x) => x.days === 7) || {};
  const a30 = ad.find((x) => x.days === 30) || {};
  const FEATURES = [
    ["Traded (market)", "traded"], ["Read the news page", "news"], ["Opened the report card", "report_card"],
    ["AMO orders", "amo_orders"], ["Limit orders", "limit_orders"], ["Asked the coach", "coach"],
    ["  · on /chat", "coach_chat_page"], ["  · in the pop-up", "coach_side_panel"],
    ["Started Time Travel", "time_travel"], ["Finished Time Travel", "time_travel_finished"],
    ["Added to watchlist", "watchlist"], ["Mutual funds", "mutual_funds"],
    ["Rated a coach answer", "gave_feedback"], ["Made a chat project", "chat_projects"],
  ];
  const DAY1 = [["Traded", "trade"], ["Placed a limit/AMO order", "limit_order"], ["Asked the coach", "coach"], ["Time Travel", "time_travel"], ["Watchlist", "watchlist"]];

  host.innerHTML = `
    <div class="card" style="margin-bottom:var(--sp-3);">
      <div class="card-head">
        <h3>Retention by sign-up week</h3>
        <div class="flex gap-2">${[4, 12, 26].map((w) => `<button class="btn btn-ghost btn-sm ${st.weeks === w ? "active-btn" : ""}" data-gw="${w}">${w} weeks</button>`).join("")}</div>
      </div>
      <p class="muted text-sm" style="margin:0 0 var(--sp-2) 0;">D1 = came back the next day. D7 = came back on any of days 7–13. D30 = any of days 30–36. Only users whose window has fully passed are counted. Weeks start Monday (IST).</p>
      <div class="admin-table-wrap" style="overflow:auto"><table class="admin-table">
        <thead><tr><th>Week of</th><th style="text-align:right">Sign-ups</th><th style="text-align:right">D1</th><th style="text-align:right">D7</th><th style="text-align:right">D30</th>
          <th style="text-align:right">Ever traded</th><th style="text-align:right">Traded &lt;1 h</th><th style="text-align:right">Traded &lt;1 day</th><th style="text-align:right">Median time to 1st trade</th></tr></thead>
        <tbody>${cohorts.map((c) => `<tr><td>${esc(c.week)}</td>
          <td class="tabular" style="text-align:right">${n(c.signups)}</td>
          <td class="tabular" style="text-align:right">${pct(c.d1_pct)}</td>
          <td class="tabular" style="text-align:right">${pct(c.d7_pct)}</td>
          <td class="tabular" style="text-align:right">${pct(c.d30_pct)}</td>
          <td class="tabular" style="text-align:right">${share(c.traded, c.signups)}</td>
          <td class="tabular" style="text-align:right">${share(c.traded_1h, c.signups)}</td>
          <td class="tabular" style="text-align:right">${share(c.traded_1d, c.signups)}</td>
          <td class="tabular" style="text-align:right">${dur(c.median_min_to_first_trade)}</td></tr>`).join("") || `<tr><td colspan="9" class="muted">No sign-ups in this window.</td></tr>`}</tbody>
      </table></div>
    </div>
    <div class="card" style="margin-bottom:var(--sp-3);">
      <div class="card-head"><h3>What users did on their first day</h3></div>
      <p class="muted text-sm" style="margin:0 0 var(--sp-2) 0;">Users who came back in week 2 (D7) vs those who did not. A big gap points at the first-day action worth pushing new users towards. Correlation, not proof.</p>
      <div class="admin-table-wrap"><table class="admin-table">
        <thead><tr><th>On day one they…</th><th style="text-align:right">Came back (n=${n(fd.retained?.n)})</th><th style="text-align:right">Did not (n=${n(fd.churned?.n)})</th></tr></thead>
        <tbody>${DAY1.map(([l, k]) => `<tr><td>${l}</td><td class="tabular" style="text-align:right">${pct(fd.retained?.[k])}</td><td class="tabular" style="text-align:right">${pct(fd.churned?.[k])}</td></tr>`).join("")}</tbody>
      </table></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Feature adoption</h3></div>
      <p class="muted text-sm" style="margin:0 0 var(--sp-2) 0;">Share of active signed-in users who used each feature. Active users: ${n(a7.active_users)} (7 days), ${n(a30.active_users)} (30 days).</p>
      <div class="admin-table-wrap"><table class="admin-table">
        <thead><tr><th>Feature</th><th style="text-align:right">Users, 7 d</th><th style="text-align:right">% of active, 7 d</th><th style="text-align:right">Users, 30 d</th><th style="text-align:right">% of active, 30 d</th></tr></thead>
        <tbody>${FEATURES.map(([l, k]) => `<tr><td>${esc(l)}</td>
          <td class="tabular" style="text-align:right">${n(a7[k])}</td><td class="tabular" style="text-align:right">${share(a7[k], a7.active_users)}</td>
          <td class="tabular" style="text-align:right">${n(a30[k])}</td><td class="tabular" style="text-align:right">${share(a30[k], a30.active_users)}</td></tr>`).join("")}</tbody>
      </table></div>
    </div>`;
  host.querySelectorAll("[data-gw]").forEach((b) => b.addEventListener("click", () => { st.weeks = Number(b.dataset.gw); renderGrowthTab(host, { adminGet }); }));
}
