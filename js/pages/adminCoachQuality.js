// =============================================================================
// Admin: Coach quality tab. admin_coach_quality() (migration 2026-10-24b).
// Per IST day: questions, thumbs, regenerate/edit taps, which model answered,
// failures, cut-off replies and first-token time. Haiku leads from ~20 Oct.
// =============================================================================
const st = { days: 30 };

const esc = (s) => { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; };
const n = (v) => (v == null ? "–" : Number(v).toLocaleString("en-IN"));
const ms = (v) => (v == null ? "–" : v >= 1000 ? (v / 1000).toFixed(1) + " s" : v + " ms");
const rate = (a, b) => (b ? `${Math.round((1000 * a) / b) / 10}%` : "–");

export async function renderCoachQualityTab(host, { adminGet }) {
  host.innerHTML = `<div class="muted">Loading coach quality…</div>`;
  let d;
  try { d = await adminGet(`/api/ai?op=admin-coach-quality&days=${st.days}`); }
  catch (e) { host.innerHTML = `<div style="color:var(--negative);">${esc(e.message)}</div>`; return; }
  const days = d.days || [];
  const sum = (k) => days.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  const asked = sum("asked_chat_page") + sum("asked_side_panel");

  host.innerHTML = `
    <div class="card" style="margin-bottom:var(--sp-3);">
      <div class="card-head">
        <h3>Coach quality</h3>
        <div class="flex gap-2">${[7, 30, 90].map((v) => `<button class="btn btn-ghost btn-sm ${st.days === v ? "active-btn" : ""}" data-cq="${v}">${v} days</button>`).join("")}</div>
      </div>
      <p class="muted text-sm" style="margin:0 0 var(--sp-3) 0;">
        Thumbs are rare (${n(sum("up") + sum("down"))} in this window), so the regenerate and edit rates are the better signal: a student who taps
        regenerate or rewrites the question did not get what they wanted. Tap tracking started 24 Oct; model and failure columns 23 Oct; Haiku leads since ~20 Oct.
      </p>
      <div class="sg-tiles">
        <div class="stat-tile sg-tile"><div class="l">Questions</div><div class="v tabular">${n(asked)}</div></div>
        <div class="stat-tile sg-tile"><div class="l">Regenerate rate</div><div class="v tabular">${rate(sum("regenerate"), asked)}</div><div class="sg-sub">${n(sum("regenerate"))} taps</div></div>
        <div class="stat-tile sg-tile"><div class="l">Edit rate</div><div class="v tabular">${rate(sum("edit"), asked)}</div><div class="sg-sub">${n(sum("edit"))} edits</div></div>
        <div class="stat-tile sg-tile"><div class="l">Thumbs</div><div class="v tabular">👍 ${n(sum("up"))} · 👎 ${n(sum("down"))}</div></div>
        <div class="stat-tile sg-tile"><div class="l">Answered by Gemini (fallback)</div><div class="v tabular">${rate(sum("answered_gemini"), sum("answered_gemini") + sum("answered_haiku"))}</div></div>
        <div class="stat-tile sg-tile"><div class="l">Failed attempts</div><div class="v tabular">${n(sum("failed_attempts"))}</div><div class="sg-sub">${n(sum("refusals"))} refusals · ${n(sum("cut_off"))} cut off</div></div>
      </div>
    </div>
    <div class="card" style="margin-bottom:var(--sp-3);"><div class="card-head"><h3>By day (IST)</h3></div>
      <div class="admin-table-wrap" style="max-height:520px;overflow:auto"><table class="admin-table">
        <thead><tr><th>Day</th><th style="text-align:right">Questions (/chat · pop-up)</th><th style="text-align:right">Askers</th><th style="text-align:right">Regen</th><th style="text-align:right">Edit</th>
          <th style="text-align:right">👍 / 👎</th><th style="text-align:right">Haiku / Gemini</th><th style="text-align:right">Failed</th><th style="text-align:right">First token p50 / p90</th></tr></thead>
        <tbody>${days.map((x) => `<tr><td>${esc(x.day)}</td>
          <td class="tabular" style="text-align:right">${n(x.asked_chat_page)} · ${n(x.asked_side_panel)}</td>
          <td class="tabular" style="text-align:right">${n(x.askers)}</td>
          <td class="tabular" style="text-align:right">${n(x.regenerate)}</td>
          <td class="tabular" style="text-align:right">${n(x.edit)}</td>
          <td class="tabular" style="text-align:right">${n(x.up)} / ${n(x.down)}</td>
          <td class="tabular" style="text-align:right">${n(x.answered_haiku)} / ${n(x.answered_gemini)}</td>
          <td class="tabular" style="text-align:right">${n(x.failed_attempts)}</td>
          <td class="tabular" style="text-align:right">${ms(x.p50_first_token_ms)} / ${ms(x.p90_first_token_ms)}</td></tr>`).join("") || `<tr><td colspan="9" class="muted">No data.</td></tr>`}</tbody>
      </table></div>
    </div>
    <div class="card"><div class="card-head"><h3>Recent 👎 answers</h3></div>
      ${(d.recent_down || []).map((r) => `<details class="admin-coach-row"><summary>${esc(new Date(r.created_at).toLocaleString("en-IN"))} · ${r.pop_up ? "pop-up" : "/chat"}${r.reason ? ` · ${esc(r.reason)}` : ""}</summary><pre class="admin-coach-payload">${esc(r.reply)}</pre></details>`).join("") || '<div class="muted text-sm">None in this window.</div>'}
    </div>`;
  host.querySelectorAll("[data-cq]").forEach((b) => b.addEventListener("click", () => { st.days = Number(b.dataset.cq); renderCoachQualityTab(host, { adminGet }); }));
}
