// =============================================================================
// ADMIN · FUNNEL — every new browser from first visit to a confirmed account,
// and for the ones who gave up: the step, the page, the last field touched,
// the last error and the exact time they stopped. One row per browser (vid);
// clicking it opens that browser's full event trail.
//
// Data: /api/ai?op=admin-signup-funnel → admin_funnel_cached (pg_cron
// signup-funnel-cache refreshes 1 day every ~4 min, 7 days every ~10 min,
// 30 days hourly). Browsers already tied to an older account are left out:
// they are returning students on a new device, not new visitors.
// =============================================================================

import { escapeHtml, fmtInt } from "./adminCharts.js";
import { renderJourney } from "./adminBehaviour.js";

const e = escapeHtml;
const PREF_KEY = "ss.adminFunnelPrefs.v1";
const STEPS = [
  { label: "Visited", stop: "left without opening sign-up" },
  { label: "Saw sign-up", stop: "looked at the sign-up form, never typed" },
  { label: "Started the form", stop: "typed in the form, never pressed sign up" },
  { label: "Pressed sign up", stop: "pressed sign up, no account was made" },
  { label: "Account made", stop: "account made, never reached the code screen" },
  { label: "Code screen", stop: "never entered the emailed code" },
  { label: "Confirmed", stop: "signed up" },
];

const st = { days: 7, show: "dropped", data: null, open: null };
try { Object.assign(st, JSON.parse(localStorage.getItem(PREF_KEY) || "{}"), { data: null, open: null }); } catch {}
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify({ days: st.days, show: st.show })); } catch {} }

const ist = (iso) => iso ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "—";
function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const fieldName = (f) => (f || "").replace(/^reg-form · /, "").replace(/^otp-form · /, "code: ").replace("r-terms", "terms box").replace("otp-input", "code box");

export function renderFunnelTab(host, { adminGet, onOpenUser }) {
  ensureStyle();
  host.innerHTML = `<div class="fn-root"><div class="muted text-sm">Loading…</div></div>`;
  const root = host.querySelector(".fn-root");
  const load = async () => {
    root.innerHTML = `<div class="muted text-sm">Loading…</div>`;
    try { st.data = await adminGet(`/api/ai?op=admin-signup-funnel&days=${st.days}`); }
    catch (err) { root.innerHTML = `<div style="color:var(--negative)">${e(err.message || err)}</div>`; return; }
    paint(root, { adminGet, onOpenUser, load });
  };
  load();
}

function paint(root, ctx) {
  const d = st.data || {};
  const seg = `<div class="fn-seg">${[1, 7, 30].map(n => `<button data-days="${n}" class="${st.days === n ? "on" : ""}">${n === 1 ? "24 h" : n + " days"}</button>`).join("")}</div>`;
  if (d.pending) {
    root.innerHTML = `<div class="fn-top">${seg}</div><div class="fn-card muted">The ${st.days}-day figures are being worked out (every few minutes). Try again shortly.</div>`;
    wire(root, ctx); return;
  }
  const steps = (d.steps || []).map(s => s.n);
  const top = Math.max(1, steps[0] || 1);
  const people = (d.people || []).filter(p => st.show === "all" ? true : st.show === "signed" ? p.step === 6 : p.step < 6);
  const drops = (k, key) => (d[key] || []).filter(r => r[0] === k);

  root.innerHTML = `
    <div class="fn-top">
      <div>
        <h2 style="margin:0">Visit → sign-up</h2>
        <div class="dim text-sm">New browsers first seen in the last ${st.days === 1 ? "24 hours" : st.days + " days"} · figures from ${e(ist(d.computedAt || d.generatedAt))} (${e(ago(d.computedAt || d.generatedAt))}) · ${fmtInt(d.google || 0)} used Google</div>
      </div>
      ${seg}
    </div>

    <div class="fn-card">
      ${STEPS.map((s, k) => {
        const n = steps[k] ?? 0, next = steps[k + 1];
        const lost = k < 6 && next != null ? n - next : 0;
        return `<div class="fn-row">
          <div class="fn-lab">${e(s.label)}</div>
          <div class="fn-track"><div class="fn-fill" style="width:${(100 * n / top).toFixed(1)}%"></div></div>
          <div class="fn-num tabular">${fmtInt(n)} <span class="dim">${(100 * n / top).toFixed(1)}%</span></div>
          <div class="fn-lost tabular">${k < 6 ? `−${fmtInt(lost)} <span class="dim">${n ? (100 * lost / n).toFixed(0) : 0}% stop here</span>` : ""}</div>
        </div>`;
      }).join("")}
    </div>

    <div class="fn-grid">
      ${[1, 2, 3, 4, 5].map(k => {
        const f = drops(k, "dropFields"), er = drops(k, "dropErrors"), pg = drops(k, "dropPages");
        if (!f.length && !er.length && !pg.length) return "";
        return `<div class="fn-card">
          <div class="fn-h">Stopped: ${e(STEPS[k].stop)} <span class="dim">(${fmtInt((steps[k] ?? 0) - (steps[k + 1] ?? 0))})</span></div>
          ${f.length ? `<div class="fn-sub">Last box they touched</div>${f.map(r => `<div class="fn-li"><span>${e(fieldName(r[1]))}</span><b class="tabular">${fmtInt(r[2])}</b></div>`).join("")}` : ""}
          ${er.length ? `<div class="fn-sub">Last error they saw</div>${er.map(r => `<div class="fn-li"><span>${e(r[1])}</span><b class="tabular">${fmtInt(r[2])}</b></div>`).join("")}` : ""}
          ${pg.length ? `<div class="fn-sub">Last page open</div>${pg.map(r => `<div class="fn-li"><span>${e(r[1])}</span><b class="tabular">${fmtInt(r[2])}</b></div>`).join("")}` : ""}
        </div>`;
      }).join("")}
    </div>

    <div class="fn-card">
      <div class="fn-top" style="margin-bottom:6px">
        <div class="fn-h" style="margin:0">People, latest first <span class="dim">(newest 300 who reached the sign-up form)</span></div>
        <div class="fn-seg">${[["dropped", "Gave up"], ["signed", "Signed up"], ["all", "All"]].map(([k, l]) => `<button data-show="${k}" class="${st.show === k ? "on" : ""}">${l}</button>`).join("")}</div>
      </div>
      <div class="fn-table">
        <div class="fn-tr fn-th"><span>Stopped</span><span>Where they got to</span><span>Page · last box · last error</span><span>Came from</span><span>Time on site</span></div>
        ${people.map(p => `
          <div class="fn-tr" data-vid="${e(p.vid)}">
            <span><b>${e(ist(p.lastTs))}</b><br><span class="dim">${e(ago(p.lastTs))}</span></span>
            <span>${p.step === 6 ? `<span class="fn-ok">Signed up</span>` : e(STEPS[p.step]?.stop || "")}${p.acctAt && p.step < 6 ? `<br><span class="dim">account ${e(ist(p.acctAt))}</span>` : ""}</span>
            <span>${e(p.lastPage || "")}${p.lastField ? ` · <b>${e(fieldName(p.lastField))}</b>` : ""}${p.lastError ? `<br><span class="fn-err">${e(p.lastError)}</span>` : ""}${p.errors > 1 ? ` <span class="dim">(${p.errors} errors)</span>` : ""}</span>
            <span>${e(p.src || "direct")}<br><span class="dim">${e(p.landing || "")} · ${e([p.dev, p.os, p.cc].filter(Boolean).join(" "))}</span></span>
            <span class="tabular">${p.mins != null ? `${p.mins} min` : ""}<br><span class="dim">${fmtInt(p.pages || 0)} pages · ${fmtInt(p.sessions || 0)} visits</span></span>
          </div>
          ${st.open === p.vid ? `<div class="fn-journey" data-journey="${e(p.vid)}">${p.uid ? `<button class="btn btn-ghost btn-sm" data-user="${e(p.uid)}">Open account</button>` : ""}<div class="fn-jbody"></div></div>` : ""}`).join("") || `<div class="muted text-sm" style="padding:8px">Nobody here.</div>`}
      </div>
    </div>`;
  wire(root, ctx);
  if (st.open) {
    const box = root.querySelector(`[data-journey="${CSS.escape(st.open)}"] .fn-jbody`);
    if (box) renderJourney(box, { adminGet: ctx.adminGet, vid: st.open });
  }
}

function wire(root, ctx) {
  root.querySelectorAll("[data-days]").forEach(b => b.addEventListener("click", () => {
    st.days = Number(b.dataset.days); st.open = null; savePrefs(); ctx.load();
  }));
  root.querySelectorAll("[data-show]").forEach(b => b.addEventListener("click", () => {
    st.show = b.dataset.show; st.open = null; savePrefs(); paint(root, ctx);
  }));
  root.querySelectorAll(".fn-tr[data-vid]").forEach(r => r.addEventListener("click", () => {
    st.open = st.open === r.dataset.vid ? null : r.dataset.vid; paint(root, ctx);
  }));
  root.querySelectorAll("[data-user]").forEach(b => b.addEventListener("click", (ev) => {
    ev.stopPropagation(); ctx.onOpenUser?.(b.dataset.user);
  }));
}

function ensureStyle() {
  if (document.getElementById("admin-funnel-style")) return;
  const s = document.createElement("style");
  s.id = "admin-funnel-style";
  s.textContent = `
.fn-root { display: flex; flex-direction: column; gap: 12px; }
.fn-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.fn-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.fn-seg button { background: none; border: 0; padding: 5px 10px; color: var(--text-dim, inherit); cursor: pointer; font: inherit; font-size: 13px; }
.fn-seg button.on { background: var(--surface-2, rgba(127,127,127,.15)); color: var(--text, inherit); font-weight: 600; }
.fn-card { border: 1px solid var(--border); border-radius: 4px; padding: 12px; background: var(--surface, transparent); }
.fn-row { display: grid; grid-template-columns: 140px 1fr 110px 150px; gap: 10px; align-items: center; padding: 4px 0; font-size: 14px; }
.fn-track { height: 14px; background: var(--surface-2, rgba(127,127,127,.12)); border-radius: 2px; overflow: hidden; }
.fn-fill { height: 100%; background: var(--accent, #16a34a); }
.fn-lost { color: var(--negative, #dc2626); font-size: 13px; }
.fn-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.fn-h { font-weight: 600; margin-bottom: 6px; }
.fn-sub { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-dim, #888); margin: 8px 0 2px; }
.fn-li { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; padding: 2px 0; border-bottom: 1px dashed var(--border); }
.fn-li span { overflow-wrap: anywhere; }
.fn-table { display: flex; flex-direction: column; }
.fn-tr { display: grid; grid-template-columns: 120px 1.2fr 1.6fr 1.2fr 110px; gap: 10px; padding: 7px 4px; border-bottom: 1px solid var(--border); font-size: 13px; cursor: pointer; }
.fn-tr:hover { background: var(--surface-2, rgba(127,127,127,.08)); }
.fn-th { font-weight: 600; cursor: default; font-size: 12px; color: var(--text-dim, #888); }
.fn-th:hover { background: none; }
.fn-err { color: var(--negative, #dc2626); }
.fn-ok { color: var(--positive, #16a34a); font-weight: 600; }
.fn-journey { padding: 8px 4px 12px; border-bottom: 1px solid var(--border); }
@media (max-width: 760px) {
  .fn-row { grid-template-columns: 1fr 70px; }
  .fn-row .fn-track { grid-column: 1 / -1; order: 3; }
  .fn-lost { grid-column: 1 / -1; order: 4; }
  .fn-tr { grid-template-columns: 1fr 1fr; }
  .fn-th { display: none; }
}`;
  document.head.appendChild(s);
}
