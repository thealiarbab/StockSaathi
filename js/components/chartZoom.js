// =============================================================================
// CHART ZOOM — pinch / wheel / pan gesture engine for stockChart().
//
// Wraps a chart-host container and emits two callbacks back to the caller:
//   * onCommit({ scale, centerMs, manualPan }) — fired on gesture-end, after
//     the user has settled on a new zoom/pan state. Caller should update
//     its model state and re-render the chart with the new xAxisRange.
//   * onReset() — fired on double-click (desktop) / two-finger-tap (mobile).
//
// Architecture (from the v1 plan's "hybrid" recommendation):
//
//   Layer A  — DURING an active gesture we DO NOT re-render. Instead we
//              apply a CSS transform="translate(tx) scale(sx, 1)" to the
//              <g class="chart-plot-area"> sub-group inside the SVG, via
//              requestAnimationFrame. That keeps gestures buttery at 60 fps
//              even on low-end mobile — re-rendering stockChart() every
//              frame takes >16 ms on a mid-range phone.
//
//   Layer B  — ON gesture-end we clear the transform and call onCommit(…)
//              with the final state. The caller decides whether to refetch
//              finer-granularity data (e.g. 5m → 1m when zoomed past 3×)
//              and re-render.
//
// Crosshair is hidden during active gestures — re-syncing it with a
// transient transform is cheap but visually distracting (the dot would
// stretch horizontally as the chart does). Hide, restore on commit.
//
// MUST stay in sync with stockChart()'s .chart-plot-area + SVG dataset
// contract (data-w, data-pl, data-pr, data-x-from, data-x-to).
// =============================================================================

// Tuning knobs — calibrated against a ThinkPad trackpad + iPhone 12 pinch.
const WHEEL_SENSITIVITY = 0.0015;    // multiplicative zoom per wheel unit
const COMMIT_DEBOUNCE_MS = 120;       // wait this long after last wheel tick
const MIN_SCALE = 1;                  // cannot zoom out past full session
const MAX_SCALE = 8;                  // 8× = ~47 min visible in 6h15m session

// Defense-in-depth: if no gesture activity fires for N ms while state is
// still "active" (pointerMap has items OR gestureLive is set), force-reset.
// Protects against mobile pointer-capture-loss (phone call, rubber-band
// scroll, OS gesture steal) where no pointerup / pointercancel ever arrives.
// 3 s chosen because no legitimate pinch has a >3 s pause between finger
// movements, and a zombified page recovers before the user rage-closes.
const GESTURE_WATCHDOG_MS = 3000;

// Minimum finger-drag distance (sum of |dx|+|dy|) before a pointerdown
// counts as a PAN (vs. a tap). Without this threshold, a zero-move tap
// at scale>1 would fire commitNow(true) which flips manualPan=true and
// kills sticky-right-edge behaviour for a mere finger wobble.
const PAN_DISTANCE_PX = 4;

// Touch double-tap detector (replaces unreliable native dblclick on touch).
// Two pointerups within TOUCH_DBLTAP_MS and TOUCH_DBLTAP_DIST_PX of each
// other count as a double-tap → onReset.
const TOUCH_DBLTAP_MS = 300;
const TOUCH_DBLTAP_DIST_PX = 20;

/**
 * Attach zoom + pan + reset handlers to a chart container. Returns a cleanup
 * function that removes all listeners.
 *
 * @param {HTMLElement} container       — the #stock-chart-host div
 * @param {object}      opts
 * @param {() => {scale, centerMs, manualPan, fromMs, toMs}} opts.getState
 *        Caller-provided accessor returning the current zoom state + the
 *        FULL session bounds (fromMs, toMs). Must be called per gesture —
 *        state may have changed since last attachment.
 * @param {(next: {scale, centerMs, manualPan}) => void} opts.onCommit
 *        Fired on gesture-end. Receives the new state; caller persists it
 *        and triggers a re-render.
 * @param {() => void} opts.onReset
 *        Fired on double-click / two-finger-tap.
 * @param {(active: boolean) => void} [opts.onGestureActive]
 *        Fired when a gesture starts (true) and ends (false). Used so
 *        refreshHistory can skip rendering mid-gesture.
 */
export function attachChartZoom(container, opts) {
  if (!container) return () => {};
  const svg = container.querySelector(".chart-svg");
  const plotArea = container.querySelector(".chart-plot-area");
  const cursor = container.querySelector(".chart-cursor");
  if (!svg || !plotArea) return () => {};

  const getState = opts.getState || (() => ({ scale: 1, centerMs: null, manualPan: false, fromMs: 0, toMs: 0 }));
  const onCommit = opts.onCommit || (() => {});
  const onReset = opts.onReset || (() => {});
  const setGestureActive = opts.onGestureActive || (() => {});
  // Callers can lower the ceiling: a bar-unit chart of 24 daily NAVs at 8×
  // would show three points.
  const maxScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, opts.maxScale ?? MAX_SCALE));

  // viewBox width (logical, from stockChart's `width` prop). All pixel math
  // goes through this so we stay correct under CSS stretching / high-DPI.
  const W = +svg.dataset.w;
  const PL = +svg.dataset.pl;
  const PR = +svg.dataset.pr;
  const plotW = W - PL - PR;

  // In-flight transient gesture state. Only valid while an action is
  // happening; cleared on commit.
  let gestureLive = null;            // { scale, centerMs, translateVb, scaleFactor }
  let wheelCommitTimer = null;
  let pointerMap = new Map();        // pointerId → { x, y }
  let pinchStart = null;             // { distance, midpointMs, startState }
  let panStart = null;               // { x, startCenterMs }
  let gestureWatchdog = null;        // force-reset timer (pointer-capture-loss recovery)
  let lastTouchUp = null;            // { t, x, y } for single-finger double-tap detection
  let rafPending = false;

  // --- coordinate helpers ----------------------------------------------

  // Client pixel X → viewBox X (mirrors attachStockChartHover's math).
  function clientToVbX(clientX) {
    const rect = svg.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * W;
  }

  // viewBox X → time (ms) on the currently-visible window.
  function vbXToMs(vbX) {
    const s = getState();
    const { scale, centerMs, fromMs, toMs } = s;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
    const totalSpan = toMs - fromMs;
    const span = totalSpan / (scale || 1);
    const center = centerMs ?? (fromMs + totalSpan / 2);
    const vFrom = Math.max(fromMs, center - span / 2);
    const rel = Math.max(0, Math.min(1, (vbX - PL) / plotW));
    return vFrom + rel * span;
  }

  // Clamp a (scale, centerMs) pair to the session window so zoom never
  // slides past 9:15 or 15:30.
  function clampState(scale, centerMs) {
    const { fromMs, toMs } = getState();
    const s = Math.max(MIN_SCALE, Math.min(maxScale, scale));
    const totalSpan = toMs - fromMs;
    const span = totalSpan / s;
    let c = centerMs ?? (fromMs + totalSpan / 2);
    if (c - span / 2 < fromMs) c = fromMs + span / 2;
    if (c + span / 2 > toMs)   c = toMs - span / 2;
    return { scale: s, centerMs: c };
  }

  // --- Layer A: transient CSS transform --------------------------------

  // Given a target (scale, centerMs) relative to the CURRENT state, compute
  // the SVG transform that previews the zoom without re-rendering.
  //
  // Idea: the plot currently spans [curFrom, curTo] across [PL, PL+plotW].
  // After commit it will span [tgtFrom, tgtTo] across the same pixel range.
  // The transient transform maps current-pixel-X to target-pixel-X via a
  // translate+scale about the left edge of the plot area.
  function previewTransform(targetScale, targetCenterMs) {
    const s = getState();
    const totalSpan = s.toMs - s.fromMs;
    if (totalSpan <= 0) return "";
    const curSpan = totalSpan / (s.scale || 1);
    const curCenter = s.centerMs ?? (s.fromMs + totalSpan / 2);
    const curFrom = curCenter - curSpan / 2;

    const { scale: tS, centerMs: tC } = clampState(targetScale, targetCenterMs);
    const tgtSpan = totalSpan / tS;
    const tgtFrom = tC - tgtSpan / 2;

    // scale factor: how much to stretch the current view to become the target
    const scaleFactor = curSpan / tgtSpan;
    // pixel offset: where the current view's left edge lands in the target
    const msOffset = curFrom - tgtFrom;
    const pxOffset = (msOffset / tgtSpan) * plotW;

    // Transform origin at (PL, 0) so scale happens about the plot's left edge.
    return `translate(${pxOffset}, 0) scale(${scaleFactor}, 1) translate(${-PL + PL / scaleFactor}, 0)`;
  }

  function applyPreview(targetScale, targetCenterMs) {
    gestureLive = { scale: targetScale, centerMs: targetCenterMs };
    kickWatchdog();
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!gestureLive) return;
      plotArea.setAttribute("transform", previewTransform(gestureLive.scale, gestureLive.centerMs));
      if (cursor) cursor.style.display = "none";
    });
  }

  function clearPreview() {
    plotArea.removeAttribute("transform");
  }

  // Unified cleanup — single source of truth for "we are NOT in a gesture".
  // Called from finally-blocks, pointercancel, watchdog, resize,
  // orientationchange, and the returned cleanup fn. Idempotent.
  function resetGestureState() {
    gestureLive = null;
    pinchStart = null;
    panStart = null;
    pointerMap.clear();
    clearPreview();
    if (wheelCommitTimer) { clearTimeout(wheelCommitTimer); wheelCommitTimer = null; }
    if (gestureWatchdog) { clearTimeout(gestureWatchdog); gestureWatchdog = null; }
    setGestureActive(false);
  }

  // Arm a 3-second watchdog. Called whenever the gesture machine enters
  // an "active" phase (pointerdown fires setGestureActive(true), or
  // applyPreview sets gestureLive). If the timer fires without the
  // gesture clearing on its own, something went wrong (pointer capture
  // was stolen, event was dropped, browser paused JS during a tab
  // switch) — force-reset so the page isn't permanently zombified.
  function kickWatchdog() {
    if (gestureWatchdog) clearTimeout(gestureWatchdog);
    gestureWatchdog = setTimeout(() => {
      gestureWatchdog = null;
      if (!gestureLive && pointerMap.size === 0) return;  // clean state, no-op
      console.warn("[chartZoom] watchdog fired — forcing gesture reset");
      resetGestureState();
    }, GESTURE_WATCHDOG_MS);
  }

  // --- Layer B: commit -------------------------------------------------

  function commitNow(manualPan) {
    if (!gestureLive) return;
    const { scale, centerMs } = clampState(gestureLive.scale, gestureLive.centerMs);
    gestureLive = null;
    clearPreview();
    setGestureActive(false);
    if (gestureWatchdog) { clearTimeout(gestureWatchdog); gestureWatchdog = null; }
    // Only fire commit if anything actually changed vs current state.
    const cur = getState();
    if (cur.scale === scale && cur.centerMs === centerMs && cur.manualPan === manualPan) return;
    onCommit({ scale, centerMs, manualPan });
  }

  // --- Wheel (desktop) --------------------------------------------------

  function onWheel(e) {
    // Preventing default is critical — otherwise the page scrolls instead
    // of the chart zooming. Honour trackpad pinch gestures too (they come
    // through as wheel events with ctrlKey=true on most browsers).
    e.preventDefault();
    e.stopPropagation();
    setGestureActive(true);
    const s = getState();
    const factor = Math.exp(-e.deltaY * WHEEL_SENSITIVITY);
    const curScale = gestureLive?.scale ?? s.scale ?? 1;
    const targetScale = curScale * factor;
    // Zoom around the cursor's timestamp — so the point under the cursor
    // stays put as the chart stretches around it.
    const vbX = clientToVbX(e.clientX);
    const cursorMs = vbXToMs(vbX);
    // New center shifts so cursorMs stays at vbX after the zoom. This
    // creates the TradingView-style "zoom toward cursor" feel.
    const totalSpan = s.toMs - s.fromMs;
    const newSpan = totalSpan / Math.max(MIN_SCALE, Math.min(maxScale, targetScale));
    const newCenter = cursorMs - (vbX - PL - plotW / 2) * (newSpan / plotW);
    applyPreview(targetScale, newCenter);
    if (wheelCommitTimer) clearTimeout(wheelCommitTimer);
    wheelCommitTimer = setTimeout(() => {
      wheelCommitTimer = null;
      commitNow(s.manualPan);   // wheel-zoom doesn't flip manualPan
    }, COMMIT_DEBOUNCE_MS);
  }

  // --- Pointer / pinch / pan -------------------------------------------

  function distance(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }
  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function onPointerDown(e) {
    // Only track primary pointer events coming from within the SVG area.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    container.setPointerCapture?.(e.pointerId);
    pointerMap.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointerMap.size === 2) {
      // Pinch begin — only NOW flip gesture-active. (A single tap should
      // not freeze the render pipeline for its ~20 ms duration.)
      setGestureActive(true);
      kickWatchdog();
      const [a, b] = [...pointerMap.values()];
      const s = getState();
      const midX = clientToVbX(midpoint(a, b).x);
      const midMs = vbXToMs(midX);
      pinchStart = {
        distance: distance(a, b),
        midpointMs: midMs,
        startScale: s.scale || 1,
        startCenter: s.centerMs ?? ((s.fromMs + s.toMs) / 2),
      };
      panStart = null;   // abandon any in-progress pan
    } else if (pointerMap.size === 1) {
      // Single-pointer drag = pan, but only if already zoomed in.
      const s = getState();
      if ((s.scale || 1) > MIN_SCALE) {
        setGestureActive(true);
        kickWatchdog();
        panStart = {
          x: e.clientX,
          startCenterMs: s.centerMs ?? ((s.fromMs + s.toMs) / 2),
        };
      }
      // If scale is 1, a single tap isn't a gesture — let hover /
      // native tap-through work normally.
    }
  }

  function onPointerMove(e) {
    if (!pointerMap.has(e.pointerId)) return;
    pointerMap.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointerMap.size >= 2 && pinchStart) {
      // Pinch in-flight.
      const [a, b] = [...pointerMap.values()];
      const d = distance(a, b);
      if (pinchStart.distance > 0) {
        const ratio = d / pinchStart.distance;
        const targetScale = pinchStart.startScale * ratio;
        // Keep the midpoint's time pinned in place as scale changes.
        const s = getState();
        const totalSpan = s.toMs - s.fromMs;
        const newSpan = totalSpan / Math.max(MIN_SCALE, Math.min(maxScale, targetScale));
        const midVbX = clientToVbX(midpoint(a, b).x);
        const targetCenter = pinchStart.midpointMs - (midVbX - PL - plotW / 2) * (newSpan / plotW);
        applyPreview(targetScale, targetCenter);
      }
      e.preventDefault();
    } else if (pointerMap.size === 1 && panStart) {
      // Pan in-flight.
      const dx = e.clientX - panStart.x;
      const s = getState();
      const rect = svg.getBoundingClientRect();
      const totalSpan = s.toMs - s.fromMs;
      const curSpan = totalSpan / (s.scale || 1);
      const msPerPx = curSpan / ((plotW / W) * rect.width);
      const targetCenter = panStart.startCenterMs - dx * msPerPx;
      applyPreview(s.scale || 1, targetCenter);
      e.preventDefault();
    }
  }

  function onPointerUp(e) {
    container.releasePointerCapture?.(e.pointerId);
    const hadPinch = !!pinchStart && pointerMap.size >= 2;
    const hadPanStart = !!panStart && pointerMap.size === 1;
    const panDistance = hadPanStart
      ? Math.abs(e.clientX - panStart.x) + Math.abs(e.clientY - panStart.y)
      : 0;
    // Any drag that applied a preview (gestureLive is set) needs to be
    // committed on release — otherwise the finally block clears the
    // preview transform and the chart visibly snaps back to its start
    // position, reading as a "spring" to the user. The PAN_DISTANCE_PX
    // threshold STILL matters, but only for deciding whether to flip
    // manualPan=true (which would kill sticky-right-edge for a stray
    // 1-px finger wobble). Commits with wasExplicitDrag=false inherit
    // the current manualPan flag so sticky-right-edge stays alive.
    const wasExplicitDrag = hadPanStart && panDistance > PAN_DISTANCE_PX;
    const pointerType = e.pointerType;
    const upX = e.clientX, upY = e.clientY;
    pointerMap.delete(e.pointerId);

    if (pointerMap.size === 0) {
      const s = getState();
      try {
        if (hadPinch && gestureLive) {
          commitNow(s.manualPan);
        } else if (hadPanStart && gestureLive) {
          // Preview was applied at some point during this drag. We MUST
          // commit so the transform's visual position becomes the new
          // data-layer state — otherwise resetGestureState below clears
          // the preview and the chart springs back. manualPan flag
          // flips only on explicit drags (> threshold); sub-threshold
          // drags commit with the existing manualPan so a finger
          // wobble doesn't accidentally disable sticky-right-edge.
          commitNow(wasExplicitDrag ? true : s.manualPan);
        }
        // Else (no gestureLive): tap-only, nothing to commit.
      } finally {
        // ALWAYS clear — even if commitNow early-returned on !gestureLive
        // (zero-movement tap). Previously this branch left
        // _gestureActive=true forever and zombified the page.
        resetGestureState();
      }

      // Single-finger double-tap reset — touch equivalent of dblclick.
      // Fires only when neither a pinch nor an explicit drag happened
      // (so genuine taps only). Two taps within TOUCH_DBLTAP_MS and
      // TOUCH_DBLTAP_DIST_PX of each other → reset.
      if (pointerType === "touch" && !hadPinch && !wasExplicitDrag) {
        const now = Date.now();
        if (lastTouchUp
            && now - lastTouchUp.t < TOUCH_DBLTAP_MS
            && Math.abs(upX - lastTouchUp.x) < TOUCH_DBLTAP_DIST_PX
            && Math.abs(upY - lastTouchUp.y) < TOUCH_DBLTAP_DIST_PX) {
          lastTouchUp = null;
          onReset();
        } else {
          lastTouchUp = { t: now, x: upX, y: upY };
        }
      }
    } else if (pointerMap.size === 1 && hadPinch) {
      // One finger lifted during pinch → keep the other as a pan base.
      const [remainingId] = pointerMap.keys();
      const remaining = pointerMap.get(remainingId);
      const sNow = getState();
      panStart = {
        x: remaining.x,
        startCenterMs: gestureLive?.centerMs ?? sNow.centerMs ?? ((sNow.fromMs + sNow.toMs) / 2),
      };
      pinchStart = null;
    }
  }

  function onPointerCancel(e) {
    // Pointer capture was yanked (phone-call interrupt, rubber-band
    // scroll, OS gesture handler took over, tab backgrounded). Do NOT
    // commit partial state — just flush. Any in-flight zoom/pan is
    // abandoned; user can redo the gesture. Previously this path
    // routed to onPointerUp which attempted a commit of half-moved
    // state, producing a jarring snap.
    pointerMap.delete(e.pointerId);
    if (pointerMap.size === 0) resetGestureState();
  }

  // --- Reset (double-click / two-finger-tap) ---------------------------

  function onDoubleClick(e) {
    e.preventDefault();
    clearPreview();
    gestureLive = null;
    pinchStart = null;
    panStart = null;
    pointerMap.clear();
    setGestureActive(false);
    onReset();
  }

  // Wire up --------------------------------------------------------------
  //
  // Reset triggers:
  //   * Mouse desktop: dblclick (fires natively)
  //   * Touch devices: single-finger double-tap (detected inside onPointerUp
  //     via lastTouchUp state). Previously we had a fragile two-finger-tap
  //     detector; single-finger dbltap is what users actually do anyway.
  //
  // Rotation/resize safety:
  //   getBoundingClientRect() dimensions change when the device rotates
  //   or the window is resized. Captured pinchStart.distance / panStart.x
  //   become stale and produce a visible snap. Flush in-flight state so
  //   the user starts fresh.
  const onResize = () => {
    if (pointerMap.size > 0 || gestureLive) resetGestureState();
  };

  svg.addEventListener("wheel", onWheel, { passive: false });
  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", onPointerUp);
  container.addEventListener("pointercancel", onPointerCancel);
  svg.addEventListener("dblclick", onDoubleClick);
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);

  return () => {
    svg.removeEventListener("wheel", onWheel);
    container.removeEventListener("pointerdown", onPointerDown);
    container.removeEventListener("pointermove", onPointerMove);
    container.removeEventListener("pointerup", onPointerUp);
    container.removeEventListener("pointercancel", onPointerCancel);
    svg.removeEventListener("dblclick", onDoubleClick);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("orientationchange", onResize);
    // Flush gesture state so a stranded _gestureActive=true can't
    // survive a detach. Previously the cleanup only cleared the wheel
    // timer and left gestureActive/gestureLive/pointerMap intact —
    // if the next render attached a fresh engine, the old stuck flag
    // blocked every subsequent render forever.
    resetGestureState();
  };
}

// Exposed as a helper for stockDetail.js to map scale → interval.
//
// Hotfix62c: was a 5m → 2m → 1m ladder back when the 1D base was 5m and
// we needed to fetch finer data on zoom-in. Now that base is already 1m
// (Yahoo's finest intraday tier for ranges ≤ 7d), there's nothing finer
// to ladder to — zooming in just narrows the viewport over the existing
// candles. Always returns "1m" so the upstream "interval changed →
// refetch" path never fires unnecessarily on a 1D zoom.
export function intervalForScale(_scale) {
  return "1m";
}
