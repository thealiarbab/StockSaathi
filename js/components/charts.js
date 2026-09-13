// =============================================================================
// CHART PRIMITIVES — Pure SVG. No deps.
// Exports:
//   sparkline(closes, opts) → SVG string
//   lineChart(series, opts) → SVG string
//   dualLineChart(series1, series2, opts) → SVG string
//   candleChart(ohlcArray, opts) → SVG string
//   areaChart(series, opts) → SVG string
// Every chart works at any width; they use viewBox for responsiveness.
// =============================================================================

function minMax(arr) {
  let min = Infinity, max = -Infinity;
  for (const v of arr) {
    // Skip null/undefined AND any non-finite number (NaN, +/-Infinity).
    // Without the isFinite check a single bad value (e.g. a hand-rolled
    // synthetic series with a div-by-zero) would propagate NaN through
    // every downstream coordinate and yield SVG attributes like
    // `cx="NaN"` that the browser silently drops, leaving an invisible
    // chart that's near-impossible to debug.
    if (v == null || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return { min: 0, max: 1 };
  if (min === max) { min -= 1; max += 1; }
  return { min, max };
}

function pad(n) {
  return Math.max(0, Math.min(1, n));
}

function buildPath(values, width, height, { min, max, paddingTop = 6, paddingBottom = 6 } = {}) {
  if (!values.length) return "";
  const range = max - min || 1;
  const plotH = height - paddingTop - paddingBottom;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  let d = "";
  let started = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    // Drop non-finite samples — a single NaN here would produce
    // `M..L NaN,NaN L..` and the browser silently bins the entire
    // sparkline. We "lift the pen" instead, breaking the line into
    // segments around the gap (effectively a polyline of valid points).
    if (v == null || !Number.isFinite(v)) continue;
    const x = i * stepX;
    const y = paddingTop + plotH - ((v - min) / range) * plotH;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    d += (!started ? "M" : "L") + x.toFixed(2) + "," + y.toFixed(2) + " ";
    started = true;
  }
  return d.trim();
}

function buildAreaPath(values, width, height, opts) {
  const linePath = buildPath(values, width, height, opts);
  if (!linePath) return "";
  return linePath + ` L${width},${height} L0,${height} Z`;
}

// ---- SPARKLINE (small, stock-card) --------------------------------------
export function sparkline(closes, { width = 220, height = 40, color = "#10B981", strokeWidth = 1.5 } = {}) {
  if (!closes || closes.length < 2) return "";
  // Filter to finite numbers only — Tier-2 stub fallback occasionally
  // emits a NaN when the seeded walk hits a div-by-zero against a near-
  // zero seed price (e.g. some illiquid micro-caps). Rather than letting
  // that NaN poison the entire SVG, we strip it here and only render
  // when at least 2 valid samples remain.
  const cleaned = closes.filter(v => Number.isFinite(v));
  if (cleaned.length < 2) return "";
  const { min, max } = minMax(cleaned);
  const trend = cleaned[cleaned.length - 1] - cleaned[0];
  const useColor = trend >= 0 ? "var(--green, #10B981)" : "var(--red, #EF4444)";
  const path = buildPath(cleaned, width, height, { min, max, paddingTop: 2, paddingBottom: 2 });
  if (!path) return "";    // buildPath bailed — emit nothing rather than empty <path d="">
  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${path}" fill="none" stroke="${useColor}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `;
}

// ---- LINE CHART (full) ---------------------------------------------------
// `rupees: true` — values are already in rupees (not paise), so y-axis labels
// get a ₹ prefix. Use this when the caller has converted NAV/price values
// from paise (÷100) before invoking lineChart. Without this, y-axis labels
// for an MF NAV chart showed "49.8k" (paise raw) instead of "₹498.62".
export function lineChart(values, {
  width = 800, height = 300, color = "var(--brand)",
  showGrid = true, showAxes = true, areaFill = true,
  min: minArg = null, max: maxArg = null,
  paddingTop = 20, paddingBottom = 28, paddingLeft = 52, paddingRight = 20,
  rupees = false,
} = {}) {
  if (!values.length) return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}"></svg>`;
  const { min: autoMin, max: autoMax } = minMax(values);
  // Hotfix44b: tightened from 0.08 -> 0.03 to match dualLineChart fix.
  // Same reason: 8% padding made y-axis labels overshoot the actual
  // peak/trough values by enough to be misleading on charts that
  // already have small absolute ranges (portfolio P&L vs. â‚¹1L start).
  let min = minArg != null ? minArg : autoMin - (autoMax - autoMin) * 0.03;
  let max = maxArg != null ? maxArg : autoMax + (autoMax - autoMin) * 0.03;
  // v275: a perfectly flat series (every value identical) gives max === min,
  // so toY() divides by zero and every path coordinate becomes NaN. The
  // browser then discards the whole <path> and the chart renders BLANK —
  // indistinguishable from "no data". 11 of the 42 users with portfolio
  // history have a flat series (one trade, never re-valued), so this was
  // the second reason the portfolio chart looked empty. Open the band to
  // +/-1% of the value (or +/-1 unit at zero) and draw the flat line.
  if (!(max > min)) {
    const mid = Number.isFinite(autoMin) ? autoMin : 0;
    const pad = Math.abs(mid) > 0 ? Math.abs(mid) * 0.01 : 1;
    min = mid - pad;
    max = mid + pad;
  }
  const plotW = width - paddingLeft - paddingRight;
  const plotH = height - paddingTop - paddingBottom;

  const toX = (i) => paddingLeft + (values.length > 1 ? (i / (values.length - 1)) * plotW : plotW / 2);
  const toY = (v) => paddingTop + plotH - ((v - min) / (max - min)) * plotH;

  let gridLines = "";
  if (showGrid) {
    for (let i = 0; i <= 4; i++) {
      const y = paddingTop + (i / 4) * plotH;
      gridLines += `<line x1="${paddingLeft}" x2="${width - paddingRight}" y1="${y}" y2="${y}" />`;
    }
  }

  let yLabels = "";
  if (showAxes) {
    for (let i = 0; i <= 4; i++) {
      const y = paddingTop + (i / 4) * plotH;
      const v = max - (i / 4) * (max - min);
      const label = rupees ? `₹${formatAxisNumber(v)}` : formatAxisNumber(v);
      yLabels += `<text class="chart-axis-label" x="${paddingLeft - 8}" y="${y + 4}" text-anchor="end">${label}</text>`;
    }
  }

  let pathD = "";
  for (let i = 0; i < values.length; i++) {
    pathD += (i === 0 ? "M" : "L") + toX(i).toFixed(2) + "," + toY(values[i]).toFixed(2) + " ";
  }
  const areaD = pathD + ` L${toX(values.length - 1)},${paddingTop + plotH} L${toX(0)},${paddingTop + plotH} Z`;

  // Hotfix64d: explicit width/height + preserveAspectRatio="none" so the
  // SVG actually stretches to fill its parent on mobile. Without these,
  // iOS Safari falls back to the SVG's intrinsic 800-unit width when the
  // parent has a fixed pixel height, overflowing the viewport. sparkline
  // and stockChart both already do this — lineChart was the straggler
  // and was the source of the portfolio hero "chart overflows to the
  // right" report. dualLineChart fixed identically below.
  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true">
      ${showGrid ? `<g class="chart-grid">${gridLines}</g>` : ""}
      ${areaFill ? `<path d="${areaD}" fill="${color}" class="chart-area" opacity="0.14" />` : ""}
      <path d="${pathD.trim()}" class="chart-line" stroke="${color}" />
      ${yLabels}
    </svg>
  `;
}

// ---- DUAL LINE CHART — for crash replay (held vs panic-sold) ------------
//
// Streaming-look revamp: when `animate: true` (the default for first
// render after navigation), both lines DRAW IN over 1.5s instead of
// appearing instantly. Held line uses pathLength=1 + stroke-dashoffset
// (canonical SVG draw-in trick). Panic line is dashed visually so we
// can't reuse stroke-dasharray for animation — it's wrapped in a
// clipPath whose <rect> sweeps from scaleX(0) to scaleX(1) over the
// same duration. Axis labels, scrubber, legend fade in at 1.55s.
// On scrubber drag the caller passes animate:false so the chart
// re-renders instantly without replaying the intro animation.
export function dualLineChart({ held, panic, height = 280, width = 800, currentIndex = null, animate = false }) {
  if (!held.length) return "";
  const all = [...held, ...panic];
  const { min: dataMin, max: dataMax } = minMax(all);
  const range = dataMax - dataMin;
  // Hotfix44a: was 0.08 (8%) on each side. User-reported on the YES Bank
  // Moratorium replay: y-axis MAX label said ₹1.74L while the actual
  // peak value was ₹1.64L. 3% feels right.
  const min = dataMin - range * 0.03;
  const max = dataMax + range * 0.03;
  const paddingLeft = 60, paddingRight = 20, paddingTop = 20, paddingBottom = 28;
  const plotW = width - paddingLeft - paddingRight;
  const plotH = height - paddingTop - paddingBottom;
  const toX = (i) => paddingLeft + (held.length > 1 ? (i / (held.length - 1)) * plotW : 0);
  const toY = (v) => paddingTop + plotH - ((v - min) / (max - min)) * plotH;

  let heldPath = "", panicPath = "";
  for (let i = 0; i < held.length; i++) {
    heldPath += (i === 0 ? "M" : "L") + toX(i).toFixed(1) + "," + toY(held[i]).toFixed(1) + " ";
    panicPath += (i === 0 ? "M" : "L") + toX(i).toFixed(1) + "," + toY(panic[i]).toFixed(1) + " ";
  }

  const startY = toY(held[0]);
  let gridLines = "";
  for (let i = 0; i <= 4; i++) {
    const y = paddingTop + (i / 4) * plotH;
    gridLines += `<line x1="${paddingLeft}" x2="${width - paddingRight}" y1="${y}" y2="${y}" />`;
  }
  let yLabels = "";
  for (let i = 0; i <= 4; i++) {
    const y = paddingTop + (i / 4) * plotH;
    const v = max - (i / 4) * (max - min);
    yLabels += `<text class="chart-axis-label" x="${paddingLeft - 8}" y="${y + 4}" text-anchor="end">₹${formatAxisNumber(v)}</text>`;
  }

  let scrubber = "";
  if (currentIndex != null && currentIndex >= 0 && currentIndex < held.length) {
    const x = toX(currentIndex);
    const hy = toY(held[currentIndex]);
    const py = toY(panic[currentIndex]);
    scrubber = `
      <line x1="${x}" x2="${x}" y1="${paddingTop}" y2="${paddingTop + plotH}" stroke="var(--brand)" stroke-dasharray="3 3" stroke-width="1" opacity="0.6" />
      <circle cx="${x}" cy="${hy}" r="5" fill="var(--positive)" stroke="var(--bg)" stroke-width="2" />
      <circle cx="${x}" cy="${py}" r="5" fill="var(--negative)" stroke="var(--bg)" stroke-width="2" />
    `;
  }

  // Generate a stable id so multiple charts on one page don't clip-fight.
  const uid = "ss" + Math.floor(Math.random() * 1e9).toString(36);
  const animClass = animate ? "ss-chart-anim" : "";
  const styleBlock = animate ? `
    <style>
      .ss-chart-anim .ss-line-held {
        stroke-dasharray: 1; stroke-dashoffset: 1;
        animation: ss-draw-line 1.5s cubic-bezier(0.22, 1, 0.36, 1) 0s forwards;
      }
      .ss-chart-anim .ss-panic-clip-${uid} rect {
        transform: scaleX(0); transform-origin: ${paddingLeft}px center;
        animation: ss-sweep-x-${uid} 1.5s cubic-bezier(0.22, 1, 0.36, 1) 0.2s forwards;
      }
      .ss-chart-anim .ss-area-fill {
        opacity: 0;
        animation: ss-chart-fadein 0.6s ease-out 1.2s forwards;
      }
      .ss-chart-anim .ss-axis,
      .ss-chart-anim .ss-scrubber,
      .ss-chart-anim .ss-legend,
      .ss-chart-anim .ss-startline {
        opacity: 0;
        animation: ss-chart-fadein 0.5s ease-out 1.55s forwards;
      }
      @keyframes ss-draw-line { to { stroke-dashoffset: 0; } }
      @keyframes ss-sweep-x-${uid} { to { transform: scaleX(1); } }
      @keyframes ss-chart-fadein { to { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) {
        .ss-chart-anim .ss-line-held, .ss-chart-anim .ss-panic-clip-${uid} rect,
        .ss-chart-anim .ss-area-fill, .ss-chart-anim .ss-axis,
        .ss-chart-anim .ss-scrubber, .ss-chart-anim .ss-legend,
        .ss-chart-anim .ss-startline {
          animation: none; stroke-dashoffset: 0; transform: none; opacity: 1;
        }
      }
    </style>
  ` : "";

  return `
    <svg class="chart-svg ${animClass}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true">
      ${styleBlock}
      <defs>
        <linearGradient id="heldFill_${uid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--positive)" stop-opacity="0.25" />
          <stop offset="100%" stop-color="var(--positive)" stop-opacity="0" />
        </linearGradient>
        <linearGradient id="panicFill_${uid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--negative)" stop-opacity="0.2" />
          <stop offset="100%" stop-color="var(--negative)" stop-opacity="0" />
        </linearGradient>
        <clipPath id="panicClip_${uid}" class="ss-panic-clip-${uid}">
          <rect x="${paddingLeft}" y="0" width="${plotW}" height="${height}" />
        </clipPath>
      </defs>
      <g class="chart-grid">${gridLines}</g>
      <line class="ss-startline" x1="${paddingLeft}" x2="${width - paddingRight}" y1="${startY}" y2="${startY}" stroke="var(--text-faint)" stroke-dasharray="4 4" stroke-width="1" opacity="0.6" />
      <text class="chart-axis-label ss-startline" x="${width - paddingRight}" y="${startY - 4}" text-anchor="end">Start: ₹${formatAxisNumber(held[0])}</text>

      <path class="ss-area-fill" d="${heldPath} L${toX(held.length - 1)},${paddingTop + plotH} L${toX(0)},${paddingTop + plotH} Z" fill="url(#heldFill_${uid})" />
      <path class="ss-area-fill" d="${panicPath} L${toX(panic.length - 1)},${paddingTop + plotH} L${toX(0)},${paddingTop + plotH} Z" fill="url(#panicFill_${uid})" />
      <path class="ss-line-held" d="${heldPath.trim()}" pathLength="1" fill="none" stroke="var(--positive)" stroke-width="2.5" stroke-linecap="round" />
      <g clip-path="url(#panicClip_${uid})">
        <path d="${panicPath.trim()}" fill="none" stroke="var(--negative)" stroke-width="2.5" stroke-dasharray="4 3" stroke-linecap="round" />
      </g>

      <g class="ss-scrubber">${scrubber}</g>
      <g class="ss-axis">${yLabels}</g>

      <g class="ss-legend">
        <circle cx="${paddingLeft + 8}" cy="${paddingTop - 4}" r="5" fill="var(--positive)" />
        <text x="${paddingLeft + 20}" y="${paddingTop}" class="chart-axis-label" fill="var(--text-muted)">If you held</text>
        <circle cx="${paddingLeft + 110}" cy="${paddingTop - 4}" r="5" fill="var(--negative)" />
        <text x="${paddingLeft + 122}" y="${paddingTop}" class="chart-axis-label" fill="var(--text-muted)">If you panic-sold</text>
      </g>
    </svg>
  `;
}

// ---- STOCK CHART (candle / area modes, X-axis, hover crosshair) ---------
//
// Usage:
//   container.innerHTML = stockChart(ohlc, { mode: "candle" | "area" });
//   attachStockChartHover(container, ohlc, { mode });
//
// The chart emits a live-price overlay (last close dashed line + rightmost
// label) and leaves two empty <g> slots (#chart-crosshair, #chart-tooltip)
// that attachStockChartHover populates on mousemove. No external deps;
// still all SVG so it works offline + in the SW cache.
// =========================================================================

export function stockChart(ohlc, {
  width = 800, height = 360,
  mode = "candle",          // "candle" | "area"
  max: maxArg = null, min: minArg = null,
  showVolume = false,       // reserved for later
  // OPTIONAL time-axis. When set, candles are positioned by their actual
  // timestamp inside [fromMs, toMs] instead of the default index-mapping.
  // For 1D intraday charts this means the x-axis ALWAYS spans 09:15 to
  // 15:30 IST regardless of how much of the session has actually elapsed,
  // so the chart "draws itself" left → right as the day progresses
  // instead of stretching today's 1.5 hours of candles to fill the
  // whole plot. Other timeframes (1W/1M/etc.) leave this null and use
  // the original index-based mapping.
  xAxisRange = null,
  // v276: optional override for the green last-value badge. Stock charts
  // want "Rs 1365.40"; the portfolio chart carries six-figure rupee values
  // that blow straight out of a 52px pill, so it passes a compact
  // formatter ("Rs 1.02L"). Returns the badge string for a paise value.
  lastLabelFormat = null,
  // v277: "span" picks one unit + precision for the whole y-axis from the
  // visible range (see makeAxisFormatter). Opt-in rather than default: stock
  // charts are a separate surface and are left on the existing per-value
  // formatting until that change can be looked at on its own.
  axisFormat = null,
} = {}) {
  if (!ohlc.length) return "";
  const useTimeAxis = xAxisRange && Number.isFinite(xAxisRange.fromMs) && Number.isFinite(xAxisRange.toMs) && xAxisRange.toMs > xAxisRange.fromMs;
  // Y-AXIS AUTO-FIT: when xAxisRange narrows the visible time window (user
  // has zoomed in), compute dataMin/dataMax from ONLY the candles in that
  // window — not the whole day. Without this, zooming into a 30-minute
  // slice where prices ranged ₹1340–₹1350 leaves the Y axis stretched to
  // cover the whole day's ₹1300–₹1400 range and the zoomed candles
  // collapse into 10% of the plot height. Every mainstream chart
  // (TradingView, Yahoo Finance, Groww, Zerodha Kite) auto-fits Y this
  // way. Fallback: if the visible window has fewer than 2 candles (e.g.
  // pre-market dead space, or the user panned into a data-less region),
  // use the full array so the axis is still sensible.
  let visibleOhlc = ohlc;
  if (useTimeAxis) {
    const filtered = ohlc.filter(k => k.t >= xAxisRange.fromMs && k.t <= xAxisRange.toMs);
    if (filtered.length >= 2) visibleOhlc = filtered;
  }
  const allHighs = visibleOhlc.map(k => k.h ?? k.c);
  const allLows  = visibleOhlc.map(k => k.l ?? k.c);
  const dataMax = Math.max(...allHighs);
  const dataMin = Math.min(...allLows);
  // Hotfix44c: tightened from 0.08 -> 0.03 (same fix as 44a/b on
  // dualLineChart + lineChart). Used by every stock detail page
  // candlestick. The fallback `dataMax * 0.01` (1% of max) only kicks
  // in when the visible candles are perfectly flat (range = 0) â€”
  // unchanged.
  const pad = (dataMax - dataMin) * 0.03 || dataMax * 0.01;
  const min = minArg != null ? minArg : dataMin - pad;
  const max = maxArg != null ? maxArg : dataMax + pad;

  const paddingLeft = 60, paddingRight = 56, paddingTop = 16, paddingBottom = 30;
  const plotW = width - paddingLeft - paddingRight;
  const plotH = height - paddingTop - paddingBottom;
  // Two coordinate-mapping functions:
  //   toXi(i) — index-based (original behaviour, used for non-time-axis).
  //   toXt(t) — time-based (used when xAxisRange is set).
  // Code below picks one based on useTimeAxis.
  const toXi = (i) => paddingLeft + (ohlc.length > 1 ? (i / (ohlc.length - 1)) * plotW : 0);
  const toXt = (t) => {
    const r = xAxisRange.toMs - xAxisRange.fromMs;
    return paddingLeft + ((t - xAxisRange.fromMs) / r) * plotW;
  };
  const toXk = useTimeAxis ? (k) => toXt(k.t) : (k, i) => toXi(i);
  const toY = (v) => paddingTop + plotH - ((v - min) / (max - min)) * plotH;

  // Y gridlines + labels
  const fmtAxis = axisFormat === "span" ? makeAxisFormatter(min / 100, max / 100) : formatAxisNumber;
  let grid = "", yLabels = "";
  for (let i = 0; i <= 4; i++) {
    const y = paddingTop + (i / 4) * plotH;
    const v = max - (i / 4) * (max - min);
    grid += `<line x1="${paddingLeft}" x2="${width - paddingRight}" y1="${y}" y2="${y}" />`;
    yLabels += `<text class="chart-axis-label" x="${paddingLeft - 8}" y="${y + 4}" text-anchor="end">₹${fmtAxis(v / 100)}</text>`;
  }

  // X-axis ticks.
  let xLabels = "";
  const fmtTime = (tms) => new Date(tms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
  const fmtDate = (tms) => new Date(tms).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" });
  if (useTimeAxis) {
    // Five fixed wall-clock ticks across the trading day. The 09:15 →
    // 11:15 → 12:30 → 14:30 → 15:30 sequence picks human-friendly round
    // times (open, mid-morning, lunch, late-afternoon, close).
    const dayMs = 24 * 60 * 60 * 1000;
    const open = xAxisRange.fromMs;
    const close = xAxisRange.toMs;
    const isFullDayWindow = (close - open) <= dayMs;
    if (isFullDayWindow) {
      const day = new Date(open);
      day.setMinutes(0, 0, 0);
      const tickTimes = [
        open,
        open + 2 * 60 * 60 * 1000,        // +2h ≈ 11:15 from 09:15
        open + 3 * 60 * 60 * 1000 + 15 * 60 * 1000, // +3h15 ≈ 12:30
        close - 60 * 60 * 1000,           // -1h ≈ 14:30
        close,
      ];
      for (const t of tickTimes) {
        const x = toXt(t);
        xLabels += `<text class="chart-axis-label" x="${x}" y="${height - 10}" text-anchor="middle">${fmtTime(t)}</text>`;
      }
    } else {
      // Multi-day xAxisRange (rare) — evenly-spaced fallback.
      for (let i = 0; i < 5; i++) {
        const t = xAxisRange.fromMs + (i / 4) * (xAxisRange.toMs - xAxisRange.fromMs);
        const x = toXt(t);
        xLabels += `<text class="chart-axis-label" x="${x}" y="${height - 10}" text-anchor="middle">${fmtDate(t)}</text>`;
      }
    }
  } else {
    // Original: 5 evenly-spaced labels keyed off the data array.
    const nTicks = Math.min(5, ohlc.length);
    const spanMs = ohlc[ohlc.length - 1].t - ohlc[0].t;
    const isIntraday = spanMs > 0 && spanMs < 3 * 86400000;
    for (let i = 0; i < nTicks; i++) {
      const idx = Math.round(i * (ohlc.length - 1) / (nTicks - 1 || 1));
      const x = toXi(idx);
      const k = ohlc[idx];
      xLabels += `<text class="chart-axis-label" x="${x}" y="${height - 10}" text-anchor="middle">${isIntraday ? fmtTime(k.t) : fmtDate(k.t)}</text>`;
    }
  }

  // Body
  let body = "";
  if (mode === "area") {
    let d = "";
    for (let i = 0; i < ohlc.length; i++) {
      // Plot each bucket's CLOSE at the bucket's stamp. This is the
      // convention every Indian broker uses (Groww, Zerodha, Google
      // Finance) — at 9:15 their chart reads the CLOSE of the [9:15,
      // 9:16) 1m bucket, not the OPEN of it. With 1m granularity (TF
      // post-Hotfix62c) each bucket is 60s wide, so plotting C-at-
      // bucket-start vs C-at-bucket-end is a single-pixel shift no one
      // perceives.
      //
      // Hotfix62f: was briefly using ohlc[0].o for the first point
      // (Hotfix62d) thinking that fixed the user's "opening price
      // discrepancies" gripe — actually what they wanted was Groww
      // parity, which means matching .c-at-stamp. The 1m switch in
      // Hotfix62c had already done the heavy lifting; v224's open-
      // anchored variant pushed us back out of sync. Reverted.
      d += (i === 0 ? "M" : "L") + toXk(ohlc[i], i).toFixed(2) + "," + toY(ohlc[i].c).toFixed(2) + " ";
    }
    // Bottom edge of the fill polygon: anchor to the FIRST and LAST
    // candle's actual x positions, not the plot edges. Otherwise the
    // fill would extend rightward into empty future space when the
    // time axis is wider than the data.
    const xFirst = toXk(ohlc[0], 0);
    const xLast  = toXk(ohlc[ohlc.length - 1], ohlc.length - 1);
    const areaD = d + ` L${xLast.toFixed(2)},${paddingTop + plotH} L${xFirst.toFixed(2)},${paddingTop + plotH} Z`;
    const firstClose = ohlc[0].c;
    const lastClose = ohlc[ohlc.length - 1].c;
    const up = lastClose >= firstClose;
    const color = up ? "var(--positive)" : "var(--negative)";
    body = `
      <path d="${areaD}" fill="${color}" opacity="0.12" />
      <path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
    `;
  } else {
    // Candles. When using a time axis, derive candleW from the time-step
    // between consecutive candles so adjacent candles abut without
    // overlapping. For index axis: keep the original even-spacing math.
    let candleW;
    if (useTimeAxis && ohlc.length > 1) {
      const stepMs = ohlc[1].t - ohlc[0].t || (5 * 60 * 1000);
      const stepPx = (stepMs / (xAxisRange.toMs - xAxisRange.fromMs)) * plotW;
      candleW = Math.max(1.5, stepPx * 0.6);
    } else {
      candleW = Math.max(1.5, plotW / ohlc.length * 0.6);
    }
    for (let i = 0; i < ohlc.length; i++) {
      const k = ohlc[i];
      const x = toXk(k, i);
      const up = k.c >= k.o;
      const cls = up ? "chart-candle-up" : "chart-candle-down";
      const yH = toY(k.h), yL = toY(k.l), yO = toY(k.o), yC = toY(k.c);
      const bodyY = Math.min(yO, yC);
      const bodyH = Math.max(1, Math.abs(yO - yC));
      body += `
        <line class="${cls}" x1="${x}" x2="${x}" y1="${yH}" y2="${yL}" stroke-width="1" />
        <rect class="${cls}" x="${x - candleW / 2}" y="${bodyY}" width="${candleW}" height="${bodyH}" />
      `;
    }
  }

  // Previous-close baseline (first candle's open as anchor) — spans the
  // full plot width regardless of axis mode (it's a horizontal reference).
  const baseY = toY(ohlc[0].o ?? ohlc[0].c);
  const baseline = `<line x1="${paddingLeft}" x2="${width - paddingRight}" y1="${baseY}" y2="${baseY}" stroke="var(--text-dim, #878E9C)" stroke-width="1" stroke-dasharray="3,4" opacity="0.4" />`;

  // Last-price label — anchors to the LAST candle's actual x position
  // (not the plot's right edge) so when the time axis extends past
  // current data the badge hugs the latest candle, leaving the empty
  // future space cleanly empty.
  const lastIdx = ohlc.length - 1;
  const lastY = toY(ohlc[lastIdx].c);
  const lastX = toXk(ohlc[lastIdx], lastIdx);
  const labelOffset = useTimeAxis ? 4 : (width - paddingRight + 2 - lastX);
  const lastLabelText = lastLabelFormat
    ? lastLabelFormat(ohlc[lastIdx].c)
    : `₹${(ohlc[lastIdx].c / 100).toFixed(2)}`;
  // Was a hard-coded 52px pill. Fine for a 4-digit share price, but it
  // clipped anything longer, so measure off the string instead.
  const lastLabelW = Math.max(52, lastLabelText.length * 6.6 + 10);
  const lastLabel = `
    <g transform="translate(${lastX + labelOffset}, ${lastY})">
      <rect x="0" y="-10" width="${lastLabelW.toFixed(1)}" height="20" rx="4" fill="var(--brand, #00B386)" />
      <text x="${(lastLabelW / 2).toFixed(1)}" y="4" text-anchor="middle" font-size="11" font-weight="700" fill="#fff" font-family="var(--font-mono, monospace)">${lastLabelText}</text>
    </g>`;

  // Subtle "paper trading" watermark — sits behind the chart at very low
  // opacity so it's effectively invisible while using the chart but is
  // legible in screenshots. Labels the image as a simulator in case a
  // screenshot is shared out of context.
  const wmY = paddingTop + plotH / 2 + 6;
  const wmX = paddingLeft + plotW / 2;
  const watermark = `<text class="chart-watermark" x="${wmX}" y="${wmY}" text-anchor="middle" font-size="${Math.round(height * 0.055)}" font-weight="700" fill="currentColor" opacity="0.055" style="pointer-events:none; user-select:none; letter-spacing:0.12em;">PAPER TRADING · VIRTUAL MONEY</text>`;

  // Time-axis range exposed via data-attrs so attachStockChartHover can
  // read them without us having to plumb the value through a second arg.
  const xAxisAttrs = useTimeAxis
    ? `data-x-from="${xAxisRange.fromMs}" data-x-to="${xAxisRange.toMs}"`
    : "";
  return `
    <div class="stock-chart" style="position:relative;">
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"
           data-w="${width}" data-h="${height}"
           data-pl="${paddingLeft}" data-pr="${paddingRight}"
           data-pt="${paddingTop}" data-pb="${paddingBottom}"
           ${xAxisAttrs}
           data-min="${min}" data-max="${max}" data-n="${ohlc.length}">
        <!-- chart-plot-area wraps the zoomable/pannable plot content. The
             zoom gesture engine (chartZoom.js) applies a transient
             transform="translate(tx) scale(sx, 1)" to THIS group during a
             gesture so Y-axis labels and the watermark stay crisp and
             un-stretched. On gesture-commit the transform is cleared and
             stockChart re-renders with the new xAxisRange. -->
        <g class="chart-plot-area">
          <g class="chart-grid">${grid}</g>
          ${baseline}
          ${body}
          ${lastLabel}
        </g>
        ${watermark}
        ${yLabels}
        ${xLabels}
        <g class="chart-cursor" style="display:none;">
          <!-- Single vertical line tracks the cursor X. In candle mode
               the dot snaps to the nearest bar's (x, close) so the mark
               is never "off" relative to the numbers next to it. In
               area mode the dot slides smoothly along the line via
               interpolated close. Halo pulses by animating r directly
               (not transform:scale) — scale-on-SVG is inconsistent
               across browsers. -->
          <line class="chart-cursor-x" x1="0" x2="0" y1="${paddingTop}" y2="${paddingTop + plotH}"
                stroke="var(--text, #E2E5EC)" stroke-width="1.5" opacity="0.7" />
          <circle class="chart-dot-halo breathing" cx="-50" cy="-50" r="10" fill="currentColor" />
          <circle class="chart-dot-core breathing" cx="-50" cy="-50" r="4.5" fill="currentColor" stroke="var(--surface, #13161E)" stroke-width="2" />
        </g>
      </svg>
      <div class="chart-tooltip" style="position:absolute; pointer-events:none; display:none; background:var(--surface-elev, #191C26); border:1px solid var(--border, #262A36); border-radius:8px; padding:8px 10px; font-size:11px; font-family:var(--font-mono, monospace); line-height:1.5; box-shadow:var(--sh-md); white-space:normal; max-width:min(60vw, 240px); z-index:2;"></div>
    </div>
  `;
}

// Back-compat aliases — existing callers of candleChart() still work.
export function candleChart(ohlc, opts = {}) { return stockChart(ohlc, { ...opts, mode: "candle" }); }

// ---- HOVER INTERACTION --------------------------------------------------
// Call AFTER the chart HTML has been inserted into `container`.
// Re-call on every re-render. Cleans up automatically when container empties.
export function attachStockChartHover(container, ohlc, {
  mode = "candle",
  // v276: optional replacement for the O/H/L/C tooltip body. The portfolio
  // chart reuses every bit of this function's geometry, cursor snapping and
  // dead-space handling, but O/H/L/C is meaningless for a portfolio-value
  // series (o === h === l === c by construction) and the 5-paise tick
  // quantisation below is an NSE equity rule that has no business rounding
  // somebody's net worth. Given the hover context it returns the lines to
  // show; null keeps the original stock behaviour.
  tooltipRows = null,
} = {}) {
  if (!container || !ohlc?.length) return () => {};
  const svg = container.querySelector(".chart-svg");
  const tooltip = container.querySelector(".chart-tooltip");
  const cursor = container.querySelector(".chart-cursor");
  const cursorX = container.querySelector(".chart-cursor-x");
  const dotHalo = container.querySelector(".chart-dot-halo");
  const dotCore = container.querySelector(".chart-dot-core");
  if (!svg || !tooltip || !cursor || !cursorX) return () => {};

  const W = +svg.dataset.w, H = +svg.dataset.h;
  const PL = +svg.dataset.pl, PR = +svg.dataset.pr;
  const PT = +svg.dataset.pt, PB = +svg.dataset.pb;
  const MIN = +svg.dataset.min, MAX = +svg.dataset.max;
  const N = +svg.dataset.n;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;
  // Read the time-axis range directly from the SVG data-attrs that
  // stockChart() set. If absent, use null and fall back to index mode.
  const xFromAttr = +svg.dataset.xFrom;
  const xToAttr   = +svg.dataset.xTo;
  const useTimeAxis = Number.isFinite(xFromAttr) && Number.isFinite(xToAttr) && xToAttr > xFromAttr;
  const xFromMs = useTimeAxis ? xFromAttr : ohlc[0].t;
  const xToMs   = useTimeAxis ? xToAttr   : ohlc[N - 1].t;
  // Last candle's actual x position. When using time-axis with the cursor
  // BEYOND this point, we're hovering over future/empty space and must
  // not pretend a price exists there.
  const lastDataMs = ohlc[N - 1].t;
  const firstDataMs = ohlc[0].t;
  const toY = (v) => PT + plotH - ((v - MIN) / (MAX - MIN)) * plotH;
  let lastColor = "";

  // Map cursor x-pixel → timestamp on the chart's x-axis.
  function pxToMs(px) {
    const rel = Math.max(0, Math.min(1, (px - PL) / plotW));
    return xFromMs + rel * (xToMs - xFromMs);
  }
  // Find the nearest candle index for a given timestamp.
  function nearestIdxAt(tMs) {
    if (!useTimeAxis) {
      // Original index-based mode.
      const rel = Math.max(0, Math.min(1, (tMs - xFromMs) / (xToMs - xFromMs)));
      return Math.max(0, Math.min(N - 1, Math.round(rel * (N - 1))));
    }
    // Time-based: binary search for closest by absolute delta.
    let lo = 0, hi = N - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ohlc[mid].t < tMs) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(ohlc[lo - 1].t - tMs) < Math.abs(ohlc[lo].t - tMs)) lo--;
    return lo;
  }
  // Mirror the X mapping used by stockChart() so the dot can snap to a
  // candle's actual plotted X position. Must stay in sync with toXk in
  // stockChart — index-based for non-time-axis, timestamp-based for the
  // 1D intraday window.
  function candleXAt(idx) {
    if (useTimeAxis) {
      return PL + ((ohlc[idx].t - xFromMs) / (xToMs - xFromMs)) * plotW;
    }
    return PL + (N > 1 ? (idx / (N - 1)) * plotW : 0);
  }

  function onMove(e) {
    const rect = svg.getBoundingClientRect();
    // map client coords → viewBox coords (chart uses preserveAspectRatio="none")
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const py = ((e.clientY - rect.top) / rect.height) * H;
    if (px < PL || px > W - PR || py < PT || py > H - PB) {
      hide();
      return;
    }

    // Cursor's exact timestamp (always — independent of candle snap).
    const cursorMs = pxToMs(px);
    // Detect "no data at this time" — cursor in dead space (future or
    // pre-history). Skip the price interpolation + hide the dot.
    const beforeData = cursorMs < firstDataMs;
    const afterData  = cursorMs > lastDataMs;
    const noDataHere = useTimeAxis && (beforeData || afterData);

    let interpClose, idx, k;
    if (noDataHere) {
      idx = afterData ? N - 1 : 0;
      k = ohlc[idx];
      interpClose = null;
    } else {
      // Interpolate close along the RENDERED line at this cursor position.
      // When !useTimeAxis (non-1D at scale=1), the line is drawn at
      // evenly-spaced INDEX positions via toXi(i) — weekend/holiday gaps
      // compress trading time unevenly across candle indices, so
      // interpolating by TIME at pixel 50% produces a Y that differs from
      // what the rendered line shows at pixel 50%. The fix: interpolate
      // by continuous INDEX so the dot's Y tracks the line pixel-for-pixel.
      // When useTimeAxis (1D always, or any TF zoomed in), the line IS
      // time-positioned, so time-interpolation remains correct.
      //
      // Hotfix62f reverted the open-anchored first-point logic
      // (Hotfix62d/62e) — line and dot both use .c at every index now,
      // matching Groww/Zerodha convention.
      if (!useTimeAxis) {
        const rel = Math.max(0, Math.min(1, (px - PL) / plotW));
        const contIdx = rel * (N - 1);
        const i0 = Math.max(0, Math.min(N - 2, Math.floor(contIdx)));
        const i1 = i0 + 1;
        const frac = contIdx - i0;
        interpClose = ohlc[i0].c + (ohlc[i1].c - ohlc[i0].c) * frac;
        idx = Math.round(contIdx);
      } else {
        idx = nearestIdxAt(cursorMs);
        // Find adjacent candles that bracket cursorMs and linear-interpolate
        // along the time axis.
        let i0 = idx, i1 = idx;
        if (idx > 0 && ohlc[idx].t > cursorMs) { i0 = idx - 1; i1 = idx; }
        else if (idx < N - 1 && ohlc[idx].t < cursorMs) { i0 = idx; i1 = idx + 1; }
        const span = ohlc[i1].t - ohlc[i0].t;
        const frac = span > 0 ? (cursorMs - ohlc[i0].t) / span : 0;
        interpClose = ohlc[i0].c + (ohlc[i1].c - ohlc[i0].c) * frac;
      }
      k = ohlc[idx];
    }

    // Vertical cursor line always tracks the cursor — even in dead space.
    cursorX.setAttribute("x1", px);
    cursorX.setAttribute("x2", px);
    if (noDataHere || interpClose == null) {
      // Hide the dot completely — no price exists at this cursor point.
      if (dotHalo) { dotHalo.setAttribute("cx", -100); dotHalo.setAttribute("cy", -100); }
      if (dotCore) { dotCore.setAttribute("cx", -100); dotCore.setAttribute("cy", -100); }
    } else {
      // Candle mode: dot snaps to the NEAREST candle's (x, close) so it
      //   visually sits on the candle body — matches what the tooltip
      //   reports as O/H/L/C. Previously the dot used the interpolated
      //   (px, interpClose) which made it float in the gaps between
      //   discrete candles, reading as "misaligned with the graph".
      // Area/line mode: dot stays at (cursor X, interpolated close) so
      //   it slides smoothly along the continuous price line.
      let dotX, dotY, dotClose;
      if (mode === "area") {
        dotX = px;
        dotClose = interpClose;
        dotY = toY(interpClose);
      } else {
        dotX = candleXAt(idx);
        dotClose = k.c;
        dotY = toY(k.c);
      }
      if (dotHalo) { dotHalo.setAttribute("cx", dotX); dotHalo.setAttribute("cy", dotY); }
      if (dotCore) { dotCore.setAttribute("cx", dotX); dotCore.setAttribute("cy", dotY); }
      // Dot color anchors on first-bucket CLOSE — matches the area
      // path's up/down baseline (Hotfix62f reverted both back to .c
      // for Groww parity).
      const dotColor = dotClose >= ohlc[0].c
        ? "var(--positive, #00B386)"
        : "var(--negative, #EB5757)";
      if (dotColor !== lastColor) {
        lastColor = dotColor;
        if (dotHalo) dotHalo.setAttribute("fill", dotColor);
        if (dotCore) dotCore.setAttribute("fill", dotColor);
      }
    }
    cursor.style.display = "";

    // Cursor-time format. For intraday we show HH:MM precise to the
    // pixel cursor (e.g. "11:32"), not the candle's snapped timestamp.
    // Date format only when the chart spans multiple days.
    const cursorDate = new Date(cursorMs);
    const totalSpan = xToMs - xFromMs;
    const isIntraday = totalSpan > 0 && totalSpan < 3 * 86400000;
    const cursorTimeStr = isIntraday
      ? cursorDate.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })
      : cursorDate.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
    const cursorDateStr = isIntraday
      ? cursorDate.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" })
      : "";
    const fmt = (p) => "₹" + (p / 100).toFixed(2);

    // Tooltip layout (identical in candle mode and line/area mode — the
    // underlying OHLC data exists either way, so suppressing it in line
    // mode was a deliberate-but-unjustified asymmetry that users asked
    // about):
    //   Row 1: cursor's exact time
    //   Row 2: price — interpolated close in line/area mode (smooth
    //          tracking along the line), nearest-candle close in candle
    //          mode (matches what the dot snaps to, no off-by-one read)
    //   Row 3: O/H (green for high)
    //   Row 4: L (red for low)/C
    //   Row 5: Volume of the nearest candle
    //   No-data state: rows 2–5 collapse to "(no candle yet)".
    const headerRow = isIntraday
      ? `<span style="color:var(--text-dim)">${cursorTimeStr} IST · ${cursorDateStr}</span>`
      : `<span style="color:var(--text-dim)">${cursorTimeStr}</span>`;
    let tipLines;
    if (tooltipRows) {
      tipLines = tooltipRows({
        k, idx, interpClose, cursorMs, noDataHere, isIntraday,
        headerRow, first: ohlc[0], last: ohlc[N - 1], fmt,
      }).filter(Boolean);
    } else if (noDataHere) {
      tipLines = [
        headerRow,
        `<span style="color:var(--text-dim); font-style: italic;">(no candle yet)</span>`,
      ];
    } else {
      // In candle mode the dot sits on the candle's close, so report that
      // same number on row 2. In area mode the dot tracks the cursor
      // smoothly along the line — the interpolated close would be shown
      // raw, which produces sub-tick values like ₹1365.44 that never
      // traded on NSE (equity tick size is 5 paise). Quantise to the
      // nearest 5 paise for display so users only ever see prices that
      // could have been real market ticks. Dot Y position stays at the
      // raw interpolated value so the mark continues to slide smoothly
      // along the rendered line.
      const quantToTick = (p) => Math.round(p / 5) * 5;
      const priceRow = (mode === "area") ? quantToTick(interpClose) : k.c;
      tipLines = [
        headerRow,
        `<strong style="font-size:13px;">${fmt(priceRow)}</strong>`,
        `<span>O <strong>${fmt(k.o)}</strong>  H <strong style="color:var(--positive)">${fmt(k.h)}</strong></span>`,
        `<span>L <strong style="color:var(--negative)">${fmt(k.l)}</strong>  C <strong>${fmt(k.c)}</strong></span>`,
        k.v ? `<span style="color:var(--text-dim)">Vol ${k.v.toLocaleString("en-IN")}</span>` : "",
      ].filter(Boolean);
    }

    tooltip.innerHTML = tipLines.join("<br>");
    tooltip.style.display = "";
    // Position the tooltip next to the cursor — NOT snapped to the bar, so
    // it tracks 1:1 with the pointer. Reading the price never requires the
    // eye to leave the line the user is tracing.
    const containerRect = container.getBoundingClientRect();
    const cursorPxX = e.clientX - containerRect.left;
    const cursorPxY = e.clientY - containerRect.top;
    const tipW = tooltip.offsetWidth || 160;
    const tipH = tooltip.offsetHeight || 60;
    const GAP = 14;
    // Prefer right of cursor; flip left if we'd overflow the container.
    let leftPx = cursorPxX + GAP;
    if (leftPx + tipW > containerRect.width - 4) leftPx = cursorPxX - tipW - GAP;
    if (leftPx < 4) leftPx = 4;
    // Final clamp: on 280-px folded devices, even the flipped tooltip
    // can exceed half the viewport, leaving it still clipped off the
    // right edge. Guarantee it sits fully inside containerRect.
    leftPx = Math.max(4, Math.min(leftPx, containerRect.width - tipW - 4));
    // Vertically center on cursor; clamp inside container.
    let topPx = cursorPxY - tipH / 2;
    if (topPx < 4) topPx = 4;
    if (topPx + tipH > containerRect.height - 4) topPx = containerRect.height - tipH - 4;
    tooltip.style.left = leftPx + "px";
    tooltip.style.top = topPx + "px";
  }

  function hide() {
    cursor.style.display = "none";
    tooltip.style.display = "none";
    lastColor = "";
  }

  container.addEventListener("mousemove", onMove);
  container.addEventListener("mouseleave", hide);
  // Pointer-event path covers touch uniformly. The legacy `touchmove`
  // approach (that we used to have here) breaks on Android Chrome
  // whenever chartZoom.js calls setPointerCapture on a multi-touch
  // gesture — capture suppresses follow-on touchmove dispatch to the
  // container, leaving the crosshair frozen mid-pinch. Pointer events
  // keep firing regardless of capture ownership, so the hover tracks
  // the user's finger smoothly in both single-touch and during-pinch.
  //
  // Guard: skip secondary pointers (the non-primary finger in a pinch)
  // and skip mouse events (mousemove handles those with higher fidelity).
  const onPointerMoveHover = (e) => {
    if (!e.isPrimary || e.pointerType === "mouse") return;
    onMove({ clientX: e.clientX, clientY: e.clientY });
  };
  const onPointerLeaveHover = (e) => {
    if (e.pointerType === "mouse") return;
    hide();
  };
  container.addEventListener("pointermove", onPointerMoveHover);
  container.addEventListener("pointerleave", onPointerLeaveHover);
  container.addEventListener("pointercancel", onPointerLeaveHover);

  return () => {
    container.removeEventListener("mousemove", onMove);
    container.removeEventListener("mouseleave", hide);
    container.removeEventListener("pointermove", onPointerMoveHover);
    container.removeEventListener("pointerleave", onPointerLeaveHover);
    container.removeEventListener("pointercancel", onPointerLeaveHover);
  };
}

// ---- AREA CHART (portfolio over time) -----------------------------------
export function areaChart(values, opts = {}) {
  return lineChart(values, { ...opts, areaFill: true });
}

/**
 * v277: build ONE formatter shared by all five y-ticks, chosen from the SPAN
 * being displayed rather than from each value's own magnitude.
 *
 * formatAxisNumber() below decides per value, which breaks in two ways once a
 * portfolio (lakh-scale value, small day-to-day spread) is plotted:
 *   - a Rs 1,300 spread at lakh scale renders "1.01L" four times running,
 *     because toFixed(2) on lakhs cannot resolve it;
 *   - the unit flips mid-axis at exactly 1e5, so one tick reads "100.0k" and
 *     the tick above it reads "1.01L" -- the same quantity, two units.
 * Both were visible on #/portfolio's 1M range.
 *
 * Picking the unit from the span keeps every tick in the same unit, and
 * picking decimals from the tick step keeps adjacent ticks distinct.
 */
function makeAxisFormatter(min, max) {
  const span = Math.abs(max - min) || Math.abs(max) || 1;
  let div = 1, suffix = "";
  if (span >= 1e7)      { div = 1e7; suffix = "Cr"; }
  else if (span >= 1e5) { div = 1e5; suffix = "L"; }
  else if (span >= 1e3) { div = 1e3; suffix = "k"; }
  const step = span / 4 / div;
  const decimals = step >= 10 ? 0 : step >= 1 ? 1 : step >= 0.1 ? 2 : 3;
  return (v) => (v / div).toFixed(decimals) + suffix;
}

function formatAxisNumber(v) {
  const abs = Math.abs(v);
  // Enough precision that 5 ticks spanning a typical stock-price range never
  // collapse to duplicate labels. Previous rounded-to-"k" logic meant a chart
  // spanning ₹1,267–₹1,612 rendered as "1k, 1k, 1k, 2k, 2k" — unreadable.
  if (abs >= 1e7) return (v / 1e7).toFixed(2) + "Cr";
  if (abs >= 1e5) return (v / 1e5).toFixed(2) + "L";
  if (abs >= 1e4) return (v / 1e3).toFixed(1) + "k";   // 10k–99.9k
  if (abs >= 1e3) return (v / 1e3).toFixed(2) + "k";   // 1.00k–9.99k
  if (abs >= 100) return v.toFixed(0);                  // 100–999
  return v.toFixed(2);                                  // <100
}
