// =============================================================================
// Charts for the admin console.
//
// Drawn at the container's real pixel width (and redrawn when it resizes), so
// axis text never stretches. Every chart has a y-axis with round numbers and a
// hover/touch read-out that shows the exact value under the pointer.
// No library: the admin page stays one request away from working.
// =============================================================================

const STYLE_ID = "admin-charts-style";

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
.axc { position: relative; width: 100%; user-select: none; touch-action: pan-y; }
.axc svg { display: block; overflow: visible; }
.axc .axc-grid { stroke: var(--divider, var(--border)); stroke-width: 1; }
.axc .axc-ylab, .axc .axc-xlab { fill: var(--text-dim); font-size: 10.5px; font-family: var(--font-mono, monospace); }
.axc .axc-guide { stroke: var(--text-dim); stroke-width: 1; stroke-dasharray: 3 3; }
.axc .axc-bar-hi { opacity: 1; }
.axc-tip {
  position: absolute; pointer-events: none; z-index: 20; min-width: 120px;
  background: var(--surface-elev, var(--surface)); color: var(--text);
  border: 1px solid var(--border-strong, var(--border)); border-radius: 8px;
  padding: 6px 9px; font-size: 12px; line-height: 1.45;
  box-shadow: 0 6px 20px rgba(0,0,0,.18); white-space: nowrap;
}
.axc-tip .t { font-weight: 700; margin-bottom: 2px; color: var(--text-strong); }
.axc-tip .r { display: flex; align-items: center; gap: 6px; justify-content: space-between; }
.axc-tip .r b { font-family: var(--font-mono, monospace); }
.axc-tip .dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.axc-legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--text-muted); margin-top: 6px; }
.axc-legend span { display: inline-flex; align-items: center; gap: 5px; }
.axc-legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.axh { display: grid; gap: 2px; font-size: 10.5px; color: var(--text-dim); }
.axh .c { border-radius: 2px; height: 18px; position: relative; }
.axh .c:hover { outline: 2px solid var(--text-strong); outline-offset: -1px; z-index: 1; }
.axh .rl { display: flex; align-items: center; padding-right: 6px; font-family: var(--font-mono, monospace); }
.axh .cl { text-align: center; font-family: var(--font-mono, monospace); }
.axb { display: flex; flex-direction: column; gap: 5px; }
.axb .row { display: grid; grid-template-columns: minmax(80px, 38%) 1fr auto; gap: 8px; align-items: center; font-size: 13px; }
.axb .lab { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.axb .track { height: 10px; background: var(--bg-soft); border-radius: 5px; overflow: hidden; }
.axb .fill { height: 100%; background: var(--brand); border-radius: 5px; }
.axb .num { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--text-muted); text-align: right; min-width: 64px; }
`;
  document.head.appendChild(el);
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export const fmtInt = n => Number(n || 0).toLocaleString("en-IN");

// Round ticks covering [min, max] (for values that sit far from zero).
export function niceRange(min, max, count = 4) {
  if (!(max > min)) return niceTicks(max, count, false);
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}

// Round tick values from 0 to at least `max`.
export function niceTicks(max, count = 4, integer = true) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let steps = [1, 2, 2.5, 5, 10].map(m => m * mag);
  if (integer) steps = steps.map(s => Math.max(1, s)).filter(s => Number.isInteger(s));
  const step = steps.find(s => s >= raw) || steps[steps.length - 1] || 1;
  const ticks = [];
  for (let v = 0; v < max + step - 1e-9; v += step) ticks.push(+v.toFixed(6));
  if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(6));
  return ticks;
}

// Axis labels: one unit for the whole axis, with enough decimals that
// neighbouring ticks never print the same text (1.00L, 1.02L, 1.04L).
function axisLabels(ticks) {
  const top = Math.max(...ticks.map(Math.abs));
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : top || 1;
  const [div, suf] = top >= 1e7 ? [1e7, "Cr"] : top >= 1e5 ? [1e5, "L"] : top >= 1e4 ? [1e3, "k"] : [1, ""];
  // As many decimals as the step itself needs (2.5 -> 1, 0.025 -> 3, 50 -> 0).
  let dec = 0;
  while (dec < 3 && Math.abs(Math.round((step / div) * 10 ** dec) - (step / div) * 10 ** dec) > 1e-6) dec++;
  return ticks.map(t => (t === 0 ? "0" : (t / div).toFixed(dec) + suf));
}

/**
 * Bars and/or lines over one x axis.
 *   labels:  one entry per x slot (used by xTick/tip)
 *   series:  [{ name, values, color, kind: "bar"|"line"|"area", dashed }]
 *   xTick(i) -> short axis label;  tip(i) -> tooltip title
 *   yFmt(v)  -> value text in the tooltip
 *   faded(i) -> true to draw slot i lighter (e.g. today, still running)
 * Returns { destroy }.
 */
export function xyChart(host, cfg) {
  ensureStyle();
  const {
    labels, series, height = 220, xTick = i => labels[i], tip = i => labels[i],
    yFmt = fmtInt, integer = true, faded = () => false, legend = series.length > 1,
    zeroBase = true,
  } = cfg;
  host.classList.add("axc");
  host.innerHTML = "";
  const box = document.createElement("div");
  const tipEl = document.createElement("div");
  tipEl.className = "axc-tip";
  tipEl.style.display = "none";
  host.append(box, tipEl);
  if (legend) {
    const lg = document.createElement("div");
    lg.className = "axc-legend";
    lg.innerHTML = series.map(s => `<span><i style="background:${s.color}"></i>${escapeHtml(s.name)}</span>`).join("");
    host.append(lg);
  }

  const n = labels.length;
  let geo = null;

  function draw() {
    const W = Math.max(240, Math.floor(host.clientWidth || 600));
    const H = height;
    const all = series.flatMap(s => s.values.filter(v => Number.isFinite(v)));
    const vmax = Math.max(0, ...all);
    const ticks = zeroBase ? niceTicks(vmax, H < 160 ? 3 : 4, integer) : niceRange(Math.min(...all), vmax, H < 160 ? 3 : 4);
    const base = ticks[0];
    const top = (ticks[ticks.length - 1] - base) || 1;
    const ylabs = axisLabels(ticks);
    const padL = Math.max(28, 8 + 6.5 * Math.max(...ylabs.map(t => t.length)));
    const padR = 8, padT = 8, padB = 20;
    const pw = W - padL - padR, ph = H - padT - padB;
    const band = pw / Math.max(1, n);
    const y = v => padT + ph - (Math.max(0, v - base) / top) * ph;
    const bars = series.filter(s => s.kind === "bar");
    const gap = band > 8 ? band * 0.18 : band > 3 ? 0.6 : 0;
    const bw = Math.max(0.6, (band - gap * 2) / Math.max(1, bars.length));

    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`;
    ticks.forEach((t, ti) => {
      const yy = Math.round(y(t)) + 0.5;
      svg += `<line class="axc-grid" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/>`;
      svg += `<text class="axc-ylab" x="${padL - 6}" y="${yy + 3.5}" text-anchor="end">${ylabs[ti]}</text>`;
    });
    // X labels: about one per 72 px.
    const every = Math.max(1, Math.ceil(n / Math.max(1, pw / 72)));
    for (let i = 0; i < n; i += every) {
      const lab = xTick(i);
      if (lab == null || lab === "") continue;
      const cx = padL + band * (i + 0.5);
      svg += `<text class="axc-xlab" x="${cx}" y="${H - 5}" text-anchor="middle">${escapeHtml(lab)}</text>`;
    }
    bars.forEach((s, bi) => {
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (!(v > 0)) continue;
        const x = padL + band * i + gap + bw * bi;
        const yy = y(v);
        const op = faded(i) ? 0.45 : 0.9;
        svg += `<rect data-i="${i}" x="${x.toFixed(2)}" y="${yy.toFixed(2)}" width="${bw.toFixed(2)}" height="${(padT + ph - yy).toFixed(2)}" rx="${bw > 6 ? 2 : 0}" style="fill:${s.color};opacity:${op}"/>`;
      }
    });
    for (const s of series.filter(s => s.kind !== "bar")) {
      let d = "", started = false, first = null, last = null;
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v == null || !Number.isFinite(v)) { started = false; continue; }
        const cx = padL + band * (i + 0.5), cy = y(v);
        d += `${started ? "L" : "M"}${cx.toFixed(2)},${cy.toFixed(2)}`;
        if (first == null) first = cx;
        last = cx;
        started = true;
      }
      if (!d) continue;
      if (s.kind === "area" && first != null) {
        svg += `<path d="${d}L${last.toFixed(2)},${padT + ph}L${first.toFixed(2)},${padT + ph}Z" style="fill:${s.color};opacity:.14"/>`;
      }
      svg += `<path d="${d}" style="fill:none;stroke:${s.color};stroke-width:${s.width || 2};stroke-linejoin:round;${s.dashed ? "stroke-dasharray:5 4;" : ""}"/>`;
    }
    svg += `<line class="axc-guide" id="g" x1="0" x2="0" y1="${padT}" y2="${padT + ph}" style="display:none"/>`;
    svg += `<rect id="hit" x="${padL}" y="0" width="${pw}" height="${H}" style="fill:transparent"/>`;
    svg += `</svg>`;
    box.innerHTML = svg;
    geo = { padL, band, W, H, padT, ph };
    const hit = box.querySelector("#hit");
    hit.addEventListener("pointermove", onMove);
    hit.addEventListener("pointerdown", onMove);
    hit.addEventListener("pointerleave", hide);
  }

  function onMove(ev) {
    if (!geo || !n) return;
    const r = box.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const i = Math.min(n - 1, Math.max(0, Math.floor((x - geo.padL) / geo.band)));
    const cx = geo.padL + geo.band * (i + 0.5);
    const g = box.querySelector("#g");
    g.setAttribute("x1", cx); g.setAttribute("x2", cx); g.style.display = "";
    box.querySelectorAll("rect[data-i]").forEach(el => { el.style.filter = el.dataset.i == i ? "brightness(1.25)" : ""; });
    tipEl.innerHTML = `<div class="t">${escapeHtml(tip(i))}</div>` + series.map(s => {
      const v = s.values[i];
      return `<div class="r"><span><span class="dot" style="background:${s.color}"></span> ${escapeHtml(s.name)}</span><b>${v == null || !Number.isFinite(v) ? "—" : escapeHtml(yFmt(v))}</b></div>`;
    }).join("");
    tipEl.style.display = "";
    const tw = tipEl.offsetWidth;
    let left = cx + 12;
    if (left + tw > geo.W) left = cx - tw - 12;
    tipEl.style.left = Math.max(0, left) + "px";
    tipEl.style.top = Math.max(0, (ev.clientY - r.top) - 40) + "px";
  }
  function hide() {
    tipEl.style.display = "none";
    const g = box.querySelector("#g");
    if (g) g.style.display = "none";
    box.querySelectorAll("rect[data-i]").forEach(el => { el.style.filter = ""; });
  }

  draw();
  let lastW = host.clientWidth;
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
    if (Math.abs(host.clientWidth - lastW) < 2) return;
    lastW = host.clientWidth;
    draw();
  }) : null;
  ro?.observe(host);
  return { destroy() { ro?.disconnect(); } };
}

/** Weekday x hour grid. values: rows*cols numbers, row-major. */
export function heatmap(host, { rowLabels, colLabels, values, tip }) {
  ensureStyle();
  const cols = colLabels.length;
  const max = Math.max(1, ...values);
  let html = `<div class="axh" style="grid-template-columns: 34px repeat(${cols}, minmax(0, 1fr));">`;
  html += `<div></div>` + colLabels.map((c, i) => `<div class="cl">${i % 3 === 0 ? escapeHtml(c) : ""}</div>`).join("");
  rowLabels.forEach((rl, r) => {
    html += `<div class="rl">${escapeHtml(rl)}</div>`;
    for (let c = 0; c < cols; c++) {
      const v = values[r * cols + c] || 0;
      const pct = v ? Math.round(12 + 88 * (v / max)) : 0;
      const bg = v ? `color-mix(in srgb, var(--brand) ${pct}%, var(--bg-soft))` : "var(--bg-soft)";
      html += `<div class="c" style="background:${bg}" title="${escapeHtml(tip(r, c, v))}"></div>`;
    }
  });
  html += `</div>`;
  host.innerHTML = html;
}

/** Horizontal bars for "top 10" style lists. rows: [[label, n], ...] */
export function barList(rows, { total = null, fmt = fmtInt, color = "var(--brand)" } = {}) {
  ensureStyle();
  if (!rows?.length) return `<div class="muted text-sm">No data yet.</div>`;
  const max = Math.max(1, ...rows.map(r => r[1]));
  return `<div class="axb">${rows.map(([label, n]) => `
    <div class="row">
      <span class="lab" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      <span class="track"><span class="fill" style="display:block;width:${(100 * n / max).toFixed(1)}%;background:${color}"></span></span>
      <span class="num">${escapeHtml(fmt(n))}${total ? ` <span class="dim">${(100 * n / total).toFixed(n / total < 0.1 ? 1 : 0)}%</span>` : ""}</span>
    </div>`).join("")}</div>`;
}
