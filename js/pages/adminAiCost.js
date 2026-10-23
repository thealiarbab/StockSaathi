// =============================================================================
// Admin: AI cost tab.
//
// Reads public.llm_usage through admin_llm_usage() (one row per model call or
// AI-cache hit, written by api/_usage.js). Costs are priced from
// public.llm_prices; a model with no price shows tokens and "no price".
// =============================================================================
import { xyChart } from "./adminCharts.js";

const st = { days: 7, data: null, charts: [] };

const esc = (s) => { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; };
const n = (v) => (v == null ? "–" : Number(v).toLocaleString("en-IN"));
const inr = (v) => (v == null ? "no price" : "₹" + Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const ms = (v) => (v == null ? "–" : v >= 1000 ? (v / 1000).toFixed(1) + " s" : v + " ms");
const tile = (l, v, sub = "") =>
  `<div class="stat-tile sg-tile"><div class="l">${l}</div><div class="v tabular">${v}</div>${sub ? `<div class="sg-sub">${sub}</div>` : ""}</div>`;

function table(cols, rows) {
  return `<div class="admin-table-wrap" style="max-height:480px;overflow:auto"><table class="admin-table">
    <thead><tr>${cols.map(([h, , r]) => `<th${r ? ' style="text-align:right"' : ""}>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${cols.map(([, f, r]) => `<td${r ? ' class="tabular" style="text-align:right"' : ""}>${f(row)}</td>`).join("")}</tr>`).join("")
      || `<tr><td colspan="${cols.length}" class="muted">Nothing recorded in this window.</td></tr>`}</tbody>
  </table></div>`;
}

export async function renderAiCostTab(host, { adminGet }) {
  st.charts.forEach((c) => c?.destroy?.());
  st.charts = [];
  host.innerHTML = `<div class="muted">Loading AI usage…</div>`;
  try {
    st.data = await adminGet(`/api/ai?op=admin-llm-usage&days=${st.days}`);
  } catch (e) {
    host.innerHTML = `<div style="color:var(--negative);">${esc(e.message)}</div>`;
    return;
  }
  const d = st.data || {};
  const t = d.totals || {};
  const days = d.by_day || [];
  const perDay = days.length ? (t.inr || 0) / days.length : null;
  const hitRate = (t.calls || t.cache_hits) ? Math.round((100 * (t.cache_hits || 0)) / ((t.calls || 0) + (t.cache_hits || 0))) : null;

  host.innerHTML = `
    <div class="card" style="margin-bottom:var(--sp-3);">
      <div class="card-head">
        <h3>AI cost &amp; usage</h3>
        <div class="flex gap-2">
          ${[1, 7, 30].map((v) => `<button class="btn btn-ghost btn-sm ${st.days === v ? "active-btn" : ""}" data-ai-days="${v}">${v === 1 ? "24 h" : v + " days"}</button>`).join("")}
        </div>
      </div>
      <p class="muted text-sm" style="margin:0 0 var(--sp-3) 0;">
        Every model call and AI-cache hit since logging began (23 Oct 2026). Prices: <code>llm_prices</code>
        (₹ at ${esc(d.usd_inr)} per $, <code>llm_settings.usd_inr</code>). Gemini has no price until one is entered there.
      </p>
      <div class="sg-tiles">
        ${tile("Spend (priced calls)", inr(t.inr), perDay != null ? `≈ ${inr(perDay)} / day` : "")}
        ${tile("Model calls", n(t.calls), `${n(t.calls - t.ok_calls)} failed`)}
        ${tile("AI-cache hits", n(t.cache_hits), hitRate != null ? `${hitRate}% of requests served free` : "")}
        ${tile("Input tokens", n(t.input_tokens), `+ ${n(t.cache_read_tokens)} cached reads`)}
        ${tile("Output tokens", n(t.output_tokens), "includes thinking")}
        ${tile("Calls without token data", n(t.calls_without_tokens), `${n(t.unpriced_calls)} with tokens but no price`)}
      </div>
    </div>
    <div class="card" style="margin-bottom:var(--sp-3);"><div class="card-head"><h3>Spend per day (IST)</h3></div><div id="ai-day"></div></div>
    <div class="card" style="margin-bottom:var(--sp-3);"><div class="card-head"><h3>Calls by hour of day (IST)</h3></div><div id="ai-hour"></div></div>
    <div class="card" style="margin-bottom:var(--sp-3);"><div class="card-head"><h3>By feature</h3></div>
      ${table([
        ["Feature", (r) => `<strong>${esc(r.feature || r.op)}</strong><div class="dim text-xs">${esc(r.route)} · ${esc(r.op)}</div>`],
        ["Spend", (r) => inr(r.inr), 1],
        ["Calls", (r) => n(r.calls), 1],
        ["Failed", (r) => n(r.failed), 1],
        ["Cache hits", (r) => n(r.cache_hits), 1],
        ["Avg in", (r) => n(r.avg_in), 1],
        ["Avg cached", (r) => n(r.avg_cache_read), 1],
        ["Avg out", (r) => n(r.avg_out), 1],
        ["p50 first token", (r) => ms(r.p50_ttft_ms), 1],
        ["p50 / p90 total", (r) => `${ms(r.p50_ms)} / ${ms(r.p90_ms)}`, 1],
      ], d.by_feature || [])}
    </div>
    <div class="card" style="margin-bottom:var(--sp-3);"><div class="card-head"><h3>Effort comparison (Haiku, successful calls)</h3></div>
      <p class="muted text-sm" style="margin:0 0 var(--sp-2) 0;">Same feature at different effort levels, side by side: the cost and speed of a change in effort.</p>
      ${table([
        ["Feature / lane", (r) => esc(r.op)],
        ["Effort", (r) => `<strong>${esc(r.effort)}</strong>`],
        ["Calls", (r) => n(r.calls), 1],
        ["Avg out", (r) => n(r.avg_out), 1],
        ["Avg prompt", (r) => n(r.avg_prompt), 1],
        ["p50 first token", (r) => ms(r.p50_ttft_ms), 1],
        ["p50 / p90 total", (r) => `${ms(r.p50_ms)} / ${ms(r.p90_ms)}`, 1],
        ["₹ per 1,000 calls", (r) => (r.inr_per_1k_calls == null ? "–" : "₹" + r.inr_per_1k_calls), 1],
      ], d.by_effort || [])}
    </div>
    <div class="card" style="margin-bottom:var(--sp-3);"><div class="card-head"><h3>By model</h3></div>
      ${table([
        ["Model", (r) => `${esc(r.model)}<div class="dim text-xs">${esc(r.upstream)}</div>`],
        ["Spend", (r) => (r.priced ? inr(r.inr) : "no price"), 1],
        ["Calls", (r) => n(r.calls), 1],
        ["Failed", (r) => n(r.failed), 1],
        ["Input", (r) => n(r.input_tokens), 1],
        ["Cached reads", (r) => n(r.cache_read_tokens), 1],
        ["Cache writes", (r) => n(r.cache_write_tokens), 1],
        ["Output", (r) => n(r.output_tokens), 1],
      ], d.by_model || [])}
    </div>
    <div class="card" style="margin-bottom:var(--sp-3);"><div class="card-head"><h3>Failures</h3></div>
      ${table([
        ["Upstream", (r) => esc(r.upstream)],
        ["Status", (r) => esc(r.status)],
        ["Feature / lane", (r) => esc(r.op)],
        ["Count", (r) => n(r.n), 1],
      ], d.failures || [])}
    </div>
    <div class="card"><div class="card-head"><h3>Prices in use (USD per 1M tokens)</h3></div>
      ${table([
        ["Model", (r) => esc(r.model)],
        ["Input", (r) => r.in_usd ?? "–", 1],
        ["Output", (r) => r.out_usd ?? "–", 1],
        ["Cache read", (r) => r.cache_read_usd ?? "–", 1],
        ["Cache write", (r) => r.cache_write_usd ?? "–", 1],
        ["Note", (r) => `<span class="dim text-xs">${esc(r.note)}</span>`],
      ], d.prices || [])}
    </div>`;

  host.querySelectorAll("[data-ai-days]").forEach((b) => b.addEventListener("click", () => {
    st.days = Number(b.dataset.aiDays);
    renderAiCostTab(host, { adminGet });
  }));

  if (days.length) {
    st.charts.push(xyChart(host.querySelector("#ai-day"), {
      labels: days.map((x) => x.day),
      series: [{ name: "₹ spend", values: days.map((x) => Number(x.inr) || 0), color: "var(--accent, #00B386)", kind: "bar" }],
      height: 200, legend: false, integer: false,
      yFmt: (v) => "₹" + Math.round(v),
      tip: (i) => `${days[i].day} · ${n(days[i].calls)} calls · ${n(days[i].cache_hits)} cache hits`,
    }));
  }
  const hours = d.by_hour || [];
  if (hours.length) {
    const full = Array.from({ length: 24 }, (_, h) => hours.find((x) => x.hour === h) || { hour: h, calls: 0, inr: 0 });
    st.charts.push(xyChart(host.querySelector("#ai-hour"), {
      labels: full.map((x) => String(x.hour).padStart(2, "0") + ":00"),
      series: [{ name: "Calls", values: full.map((x) => x.calls), color: "var(--info, #3B82F6)", kind: "bar" }],
      height: 180, legend: false,
      tip: (i) => `${full[i].hour}:00 IST · ${n(full[i].calls)} calls · ${inr(full[i].inr)}`,
    }));
  }
}
