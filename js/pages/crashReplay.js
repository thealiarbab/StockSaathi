// =============================================================================
// CRASH REPLAY — THE WOW MOMENT
// Drag slider across COVID / GFC / Demonetisation. Dual lines (held vs panic-sold)
// animate. Coach narration card fades in at key frames. Offline-safe.
// =============================================================================

import { CRASHES, getCrashById, registerCustomCrash } from "../data/crashes.js";
import { dualLineChart } from "../components/charts.js";
import { formatRupees, formatPct, deltaClass } from "../money.js";
import { coach } from "../coach/orchestrator.js";
import { recordCoachMessage, setState, getState } from "../state.js";
import { navigate } from "../router.js";
import { generateCustomCrash, existingScenarioForQuery } from "../features/customCrash.js";

// Featured replays — canonical phrasings that scripts/pregen-crashes.mjs
// has populated into the cross-user cache. Clicking any of these calls
// generateCustomCrash with the exact phrasing → cache hit → instant
// load. MUST stay in sync with EVENTS in scripts/pregen-crashes.mjs.
// If pregen hasn't run yet, the click still works but pays full
// generation cost on first user.
const FEATURED_PHRASINGS = [
  { phrase: "Harshad Mehta 1992",            blurb: "Bombay's first big stock-broker scam — Sensex doubled then halved.", range: "Apr 1992 → Aug 1992" },
  { phrase: "Dot Com 2000",                  blurb: "Indian IT pulled into the global tech bust.",                          range: "Mar 2000 → Jun 2000" },
  { phrase: "Global Financial Crisis 2008",  blurb: "Lehman → Nifty fell 60% over six months.",                             range: "Sep 2008 → Mar 2009" },
  { phrase: "Satyam scandal 2009",           blurb: "Ramalinga Raju's confession letter, IT sector circuit-breakers.",     range: "Jan 2009 → Apr 2009" },
  { phrase: "IL&FS collapse 2018",           blurb: "AAA-rated NBFC defaults trigger a credit-market freeze.",              range: "Sep 2018 → Jan 2019" },
  { phrase: "DHFL crisis 2019",              blurb: "Housing finance giant unravels live.",                                  range: "Jun 2019 → Dec 2019" },
  { phrase: "YES Bank moratorium 2020",      blurb: "RBI freezes withdrawals, retail equity-holder gets wiped to ₹0.",     range: "Mar 2020 → Jul 2020" },
  { phrase: "COVID March 2020",              blurb: "Fastest 35% drop in Nifty history. Recovered in 5 months.",            range: "Feb 2020 → Aug 2020" },
  { phrase: "Paytm IPO Nov 2021",            blurb: "Listed at ₹2150, fell 27% on debut day. Six months in: -75%.",        range: "Nov 2021 → Apr 2022" },
  { phrase: "Adani Hindenburg Jan 2023",     blurb: "Short-seller report wipes ₹10 lakh crore from group market cap.",     range: "Jan 2023 → Jun 2023" },
];

// Hotfix45b: post-process narration text to fix common LLM mis-phrasings.
// Today's known issue: the LLM sometimes writes 'opens at â‚¹X' when the
// startIndex/troughIndex/endIndex values are CLOSING prices (closes[0]
// from Yahoo's daily series). For after-hours news events (RBI moratorium,
// regulatory bans, results announcements) the day-0 price is the LAST CLOSE
// before the news â€” not an open. Fix by rewriting these patterns at
// display time so already-cached scenarios get the correct wording without
// regenerating (LLM tokens, latency).
function sanitizeNarration(text) {
  if (!text || typeof text !== "string") return text;
  return text
    // 'opens at â‚¹X' / 'opens at Rs X' / 'opens at 36.80'  -> 'closes at â‚¹X'
    .replace(/\bopens\s+at\b/gi, "closes at")
    .replace(/\bopened\s+at\b/gi, "closed at")
    .replace(/\bopening\s+(price|level)\s+(of\s+)?/gi, "closing $1 $2")
    // 'opens to â‚¹X' (less common but appears) -> 'closes at â‚¹X'
    .replace(/\bopens\s+to\b/gi, "closes at")
    // 'on the open' / 'at the open' -> 'on the close' / 'at the close'
    .replace(/\b(at|on)\s+the\s+open\b/gi, "$1 the close");
}

export function renderCrashReplay(main, params) {
  const scenarioId = params?.scenario;

  if (!scenarioId) {
    renderSelector(main);
    return;
  }
  const scenario = getCrashById(scenarioId);
  if (!scenario) {
    main.innerHTML = `<div class="empty-state"><span class="emoji">🔍</span><h3>Scenario not found</h3><a href="/crash-replay" class="btn btn-primary">Back</a></div>`;
    return;
  }
  renderReplay(main, scenario);
}

function renderSelector(main) {
  main.innerHTML = `
    <section class="crash-hero">
      <div style="margin-bottom: var(--sp-3);">
        <span class="pill pill-brand">⏱ Time Travel</span>
      </div>
      <h1 class="tight">Live through a real crash.<br />Without losing a rupee.</h1>
      <p class="muted" style="max-width: 640px; margin: 0 auto; font-size: var(--text-lg);">
        Scrub through real moments of Indian market panic.
        Watch a ₹1,00,000 portfolio split: if you held, vs if you panic-sold on day 3.
      </p>
    </section>

    <div class="card" id="custom-crash-card" style="margin-top: var(--sp-6); margin-bottom: var(--sp-6);">
      <h3 style="margin-bottom: var(--sp-2);">✨ Ask about any Indian market event</h3>
      <p class="muted" style="margin-bottom: var(--sp-3); font-size: var(--text-sm); line-height: 1.6;">
        Harshad Mehta 1992. Satyam scandal. Adani short-seller report. YES Bank 2020. 1MDB-era crypto panic. Anything — specific, niche, white or black money. The coach pulls what it knows, builds a day-by-day replay, and drops you into it.
      </p>
      <div class="flex gap-3 wrap" style="align-items:flex-start;">
        <input id="custom-crash-input" class="input" style="flex:1; min-width: 240px;" type="text" maxlength="200" placeholder="e.g. Harshad Mehta 1992 securities scam" />
        <button id="custom-crash-btn" class="btn btn-primary">Generate replay</button>
      </div>
      <div id="custom-crash-suggestions" class="custom-crash-suggestions"></div>
      <div id="custom-crash-status" class="muted text-xs" style="margin-top: var(--sp-2); min-height: 1.2em;"></div>
    </div>

    <div style="margin-bottom: var(--sp-3);">
      <h3 style="margin: 0;">Curated replays</h3>
      <p class="muted text-sm">Hand-tuned with real historical Nifty values.</p>
    </div>
    <div class="crash-scenarios">
      ${CRASHES.map(c => `
        <button class="crash-scenario" data-id="${c.id}">
          <div class="flex items-center justify-between">
            <h4>${c.title}</h4>
            <span class="pill ${c.finalDelta > 0 ? "pill-green" : "pill-red"}">
              ${c.finalDelta > 0 ? "+" : ""}${c.finalDelta.toFixed(1)}% delta
            </span>
          </div>
          <div class="desc">${c.description}</div>
          <div class="meta">${c.startLabel} → ${c.endLabel}</div>
        </button>
      `).join("")}
    </div>

    <div style="margin-top: var(--sp-6); margin-bottom: var(--sp-3);">
      <h3 style="margin: 0;">Featured replays</h3>
      <p class="muted text-sm">Pre-generated for instant load. Real Yahoo data, AI-built narration.</p>
    </div>
    <div class="crash-scenarios" id="featured-replays">
      ${FEATURED_PHRASINGS.map(p => `
        <button class="crash-scenario" data-featured="${escapeAttr(p.phrase)}">
          <div class="flex items-center justify-between">
            <h4>${escapeHtml(p.phrase)}</h4>
            <span class="pill pill-brand">⚡ instant</span>
          </div>
          <div class="desc">${escapeHtml(p.blurb)}</div>
          <div class="meta">${escapeHtml(p.range)}</div>
        </button>
      `).join("")}
    </div>

    <div class="card" style="margin-top: var(--sp-8); text-align: center;">
      <h3 style="margin-bottom: var(--sp-2);">Tip</h3>
      <p class="muted">
        The COVID 2020 replay is the most visceral — 35% drop in 33 days.
        The held portfolio recovers entirely within 5 months. The panic-seller sits on cash for the whole rally.
      </p>
    </div>
  `;

  main.querySelectorAll(".crash-scenario[data-id]").forEach(btn => {
    btn.addEventListener("click", () => {
      navigate("/crash-replay/" + btn.dataset.id);
    });
  });

  const input = main.querySelector("#custom-crash-input");
  const button = main.querySelector("#custom-crash-btn");
  const status = main.querySelector("#custom-crash-status");

  // Featured-replay click → run the same generateCustomCrash flow as
  // typing the phrase manually. Cache-hit when scripts/pregen-crashes.mjs
  // has populated the row; falls back to live generation otherwise.
  main.querySelectorAll(".crash-scenario[data-featured]").forEach(btn => {
    btn.addEventListener("click", () => {
      input.value = btn.dataset.featured;
      trigger();
    });
  });

  async function trigger() {
    const q = (input.value || "").trim();
    if (!q) {
      status.textContent = "Type a crash or event to replay.";
      input.focus();
      return;
    }
    // FAST PATH: local-cache hit. existingScenarioForQuery returns a
    // scenario id only when the user has previously generated this exact
    // query AND the cached payload's _promptVersion still matches the
    // current code's CURRENT_PROMPT_VERSION. In that case, navigation is
    // instant — there is genuinely zero work to visualise. Skip the
    // generating-stage entirely so we don't show a fake "loading" UI
    // for ~250ms when the user could have been on the replay page.
    const localId = existingScenarioForQuery(q);
    if (localId) {
      navigate("/crash-replay/" + localId);
      return;
    }
    // REVAMP: replace the entire selector main with the generating-stage
    // visualisation. The intro animation that used to play AFTER the
    // replay loaded is replaced by this — it runs DURING the actual
    // Phase A/B/C work, not after, so the visualisation overlaps real
    // latency instead of stacking on top of it.
    renderGeneratingStage(main, q);
    advanceGeneratingStage(main, "cache", "active");

    // Track real Phase B / Phase C state so the live feed can switch
    // from "ticker prices" to "narrative streaming" at the right moment.
    let phaseBPricesShown = false;
    let phaseCStarted = false;

    const onProgress = (stage, payload) => {
      if (stage === "cache-check") {
        advanceGeneratingStage(main, "cache", "active");
      } else if (stage === "phase-a") {
        advanceGeneratingStage(main, "cache", "done", "miss");
        advanceGeneratingStage(main, "phaseA", "active");
      } else if (stage === "phase-b") {
        advanceGeneratingStage(main, "phaseA", "done");
        advanceGeneratingStage(main, "phaseB", "active");
      } else if (stage === "phase-c") {
        advanceGeneratingStage(main, "phaseB", "done");
        advanceGeneratingStage(main, "phaseC", "active");
        if (!phaseCStarted) {
          phaseCStarted = true;
          startGenFeedNarrative(main);
        }
      } else if (stage === "phase-c-streaming") {
        // First byte arrived — placeholder swap to indicate streaming
        // has begun. The actual text will arrive via phase-c-chunk.
      } else if (stage === "phase-b-source" && payload && typeof payload === "object") {
        // Surface which data source served Phase B in the stage detail.
        const src = payload.source;
        const tried = Array.isArray(payload.sources_tried) ? payload.sources_tried : [];
        let label = "";
        if (src === "cache") label = "via cache";
        else if (src === "fallback") label = `via curated (${payload.fallback_reason || "yahoo failed"})`;
        else if (tried.length > 1) label = `via ${tried.join(" → ")}`;
        else label = "via Yahoo";
        const node = main.querySelector(`.gen-flow-node[data-stage="phaseB"] .gen-flow-detail`);
        if (node) node.textContent = label;
      } else if (stage === "phase-c-chunk" && typeof payload === "string") {
        // Extract the in-flight description value (regex matches the
        // closed string OR the open one we're still streaming into).
        const m = payload.match(/"description"\s*:\s*"((?:\\.|[^"\\])*)"?/);
        const txt = m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, "\"") : "";
        if (txt) updateGenFeedNarrative(main, txt);
      }
    };

    // After Phase B completes we have real prices in stub.frames. Stream
    // them into the live feed as a tape ticker AND build the mini-spark.
    const onChartReady = (stubScenario) => {
      if (phaseBPricesShown) return;
      phaseBPricesShown = true;
      const closes = stubScenario.frames.map(f => f.nifty);
      const total = closes.length;
      // Sample ~6 evenly-spaced days for the tape (compact view).
      const step = Math.max(1, Math.floor(total / 6));
      let prevClose = closes[0];
      for (let i = 0; i < total; i += step) {
        const c = closes[i];
        const delta = i === 0 ? 0 : ((c - prevClose) / prevClose) * 100;
        const dCls = delta >= 0 ? "delta-up" : "delta-down";
        const dStr = i === 0 ? "" : `<span class="${dCls}">${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%</span>`;
        appendGenFeedRow(main,
          `<span class="day">D${i}</span>` +
          `<span class="px">₹${Math.round(c).toLocaleString("en-IN")}</span>` +
          dStr
        );
        prevClose = c;
      }
      // Build the mini-spark from the FULL closes array so the visual is
      // a true preview of the final chart's shape.
      drawGenSparkline(main, closes);
      advanceGeneratingStage(main, "phaseB", "done", `${total} days`);
    };

    const triggerStartedAt = performance.now();
    try {
      const scenario = await generateCustomCrash(q, { onProgress, onChartReady });
      registerCustomCrash(scenario);
      advanceGeneratingStage(main, "phaseC", "done");
      // FAST-SNAP: if the whole generation resolved in under 600ms (a
      // cross-user cache hit, basically), the user barely had time to
      // see the stage at all. Skip the fade entirely and snap-navigate.
      // For real generations (~3s+) we keep the fade because the user
      // needs the visual cue that we're done.
      const elapsed = performance.now() - triggerStartedAt;
      const FAST_THRESHOLD = 600;
      const FADE_MS = elapsed < FAST_THRESHOLD ? 0 : 80;
      if (FADE_MS > 0) {
        const stage = main.querySelector("#gen-stage");
        if (stage) stage.classList.add("gen-fading-out");
      }
      setTimeout(() => {
        navigate("/crash-replay/" + scenario.id);
      }, FADE_MS);
    } catch (e) {
      const msg = String(e?.message || "unknown error");
      // Mark current active stage as error. NOTE: the inline-overlay flow
      // uses .gen-flow-node, NOT .gen-stage-row (the old full-takeover
      // selector). Earlier code used the wrong selector so the error
      // state never showed.
      const activeNode = main.querySelector(".gen-flow-node[data-state='active']");
      if (activeNode) advanceGeneratingStage(main, activeNode.dataset.stage, "error");
      const stage = main.querySelector("#gen-stage");
      if (stage) {
        // Inline error message + actionable suggestions.
        const err = document.createElement("p");
        err.style.cssText = "margin: var(--sp-3) 0 var(--sp-2) 0; color: var(--negative); font-size: var(--text-sm);";
        const isAuthIssue = /quota|key|rate-?limit/i.test(msg);
        const extra = isAuthIssue ? "" : " Pick an event below, or rephrase.";
        err.textContent = msg + extra;
        stage.appendChild(err);
        // Suggestion chips for events that DO have data.
        const chips = document.createElement("div");
        chips.style.cssText = "display: flex; flex-wrap: wrap; gap: 8px; margin: var(--sp-2) 0 var(--sp-3) 0;";
        const SUGGESTIONS = [
          "Harshad Mehta 1992",
          "Dot Com 2000",
          "Global Financial Crisis 2008",
          "COVID March 2020",
          "Adani Hindenburg Jan 2023",
        ];
        for (const s of SUGGESTIONS) {
          const c = document.createElement("button");
          c.type = "button";
          c.className = "crash-sugg-chip";
          c.textContent = s;
          c.addEventListener("click", () => {
            // Re-render the selector first (so input + chips are back in
            // their original DOM), then prefill input + click Generate.
            renderSelector(main);
            const newInput = main.querySelector("#custom-crash-input");
            const newBtn = main.querySelector("#custom-crash-btn");
            if (newInput && newBtn) {
              newInput.value = s;
              newInput.dispatchEvent(new Event("input", { bubbles: true }));
              newBtn.click();
            }
          });
          chips.appendChild(c);
        }
        stage.appendChild(chips);
        // "Back to scenarios" button. CRITICAL: navigating to the URL we are
        // already on (/crash-replay) is a no-op, so a bare navigate() here
        // would do nothing.
        // Re-call renderSelector(main) directly to restore the page.
        const back = document.createElement("button");
        back.className = "btn btn-primary btn-sm";
        back.style.cssText = "margin-top: var(--sp-2);";
        back.textContent = "← Back to scenarios";
        back.addEventListener("click", () => {
          renderSelector(main);
        });
        stage.appendChild(back);
      }
    }
  }

  button.addEventListener("click", trigger);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") trigger(); });

  // Populate AI-generated suggestion chips. One LLM call per week for the
  // whole site — cached server-side.
  const suggHost = main.querySelector("#custom-crash-suggestions");
  fetch("/api/ai?op=crash-suggestions").then(r => r.ok ? r.json() : null).then(d => {
    if (!d?.suggestions?.length || !suggHost) return;
    suggHost.innerHTML = d.suggestions.slice(0, 8).map(s =>
      `<button class="crash-sugg-chip" data-sugg="${escapeAttr(s)}">${escapeHtml(s)}</button>`
    ).join("");
    suggHost.querySelectorAll("[data-sugg]").forEach(chip => {
      chip.addEventListener("click", () => {
        input.value = chip.dataset.sugg;
        input.focus();
      });
    });
    // Also rotate through as placeholder text every 4s until the user types.
    let i = 0;
    const rotate = () => {
      if (input.value) return;
      input.placeholder = "e.g. " + d.suggestions[i % d.suggestions.length];
      i++;
    };
    rotate();
    const h = setInterval(rotate, 4000);
    window.addEventListener("ss:navigate", () => clearInterval(h), { once: true });
  }).catch(() => {});
}

function renderReplay(main, scenario) {
  // PERF: chart-first render. If we navigated here with a partial scenario
  // (Phase B done, Phase C still streaming), wire two listeners:
  //   1. 'crash-scenario-streaming' — fires on every SSE chunk with the
  //      partial accumulated text. Extract title / description as soon
  //      as those JSON keys close, render them in place so the user
  //      sees the narrative being written word-by-word.
  //   2. 'crash-scenario-updated' — fires when Phase C finishes, the
  //      full scenario is registered, and we should re-render with the
  //      complete data (key moments, etc.).
  if (scenario._partial) {
    const onStreaming = (ev) => {
      const partial = ev?.detail?.partialText;
      if (typeof partial !== "string") return;
      _patchPartialFromStream(main, partial);
    };
    const onUpdated = (ev) => {
      if (ev?.detail?.scenarioId !== scenario.id) return;
      const fullScenario = getCrashById(scenario.id);
      if (fullScenario && !fullScenario._partial) {
        window.removeEventListener("crash-scenario-streaming", onStreaming);
        window.removeEventListener("crash-scenario-updated", onUpdated);
        renderReplay(main, fullScenario);
      }
    };
    window.addEventListener("crash-scenario-streaming", onStreaming);
    window.addEventListener("crash-scenario-updated", onUpdated);
    // Also clear the listeners if user navigates away.
    window.addEventListener("ss:navigate", () => {
      window.removeEventListener("crash-scenario-streaming", onStreaming);
      window.removeEventListener("crash-scenario-updated", onUpdated);
    }, { once: true });
  }

  const totalFrames = scenario.frames.length;

  // Interpolate frames to a uniform 0..N index. We use scenario.frames[i].day as
  // "trading day offset" — but the frames array itself already holds every day
  // we want to render.
  const frames = scenario.frames;
  let currentIdx = 0;

  // Derive "mood markers" from frames: pick ~5 interesting moments
  const markers = buildMarkers(scenario);

  main.innerHTML = `
    <div class="replay-topbar">
      <a href="/crash-replay" class="btn btn-ghost btn-sm">← Scenarios</a>
      <div class="replay-title-inline">
        <span class="pill pill-brand">⏱ ${escapeHtml(scenario.subtitle || "Time travel")}</span>
        <strong>${escapeHtml(scenario.title)}</strong>
        <span class="mood-indicator calm" id="mood-indicator">🧘 Calm</span>
      </div>
      <div class="replay-controls replay-controls-top">
        <button class="btn btn-primary btn-sm" id="play-btn">▶ Play (15s)</button>
        <button class="btn btn-ghost btn-sm" id="play-slow-btn">🐢 Slow</button>
        <button class="btn btn-ghost btn-sm" id="reset-btn">⟲ Reset</button>
        <button class="btn btn-ghost btn-sm" id="jump-bottom-btn">📉 Bottom</button>
        <button class="btn btn-ghost btn-sm" id="jump-end-btn">⏭ End</button>
        <button class="btn btn-ghost btn-sm" id="skip-anim-btn" hidden>⏭ Skip animation</button>
      </div>
    </div>

    <div class="replay-panel">
      <div class="replay-stats">
        <div class="replay-stat held">
          <div class="header"><span>● If you held</span><span class="dim" id="held-days-label">Day 0</span></div>
          <div class="big tabular" id="held-val">₹1,00,000</div>
          <div class="delta tabular" id="held-delta">+0.00%</div>
        </div>
        <div class="replay-stat panic">
          <div class="header"><span>● If you panic-sold on day 3</span><span class="dim">Locked at day 3</span></div>
          <div class="big tabular" id="panic-val">₹1,00,000</div>
          <div class="delta tabular" id="panic-delta">+0.00%</div>
        </div>
      </div>

      <div class="replay-slider-wrap">
        <div class="replay-slider-meta">
          <span>${scenario.startLabel}</span>
          <span id="slider-pos">Day 0</span>
          <span>${scenario.endLabel}</span>
        </div>
        <div class="replay-markers" id="markers-wrap">
          ${markers.map(mk => `
            <button class="replay-marker" data-idx="${mk.idx}" title="${escapeAttr(mk.label)}" style="left: ${(mk.idx / (totalFrames - 1)) * 100}%;">
              ${escapeHtml(mk.short)}
            </button>
          `).join("")}
        </div>
        <input type="range" min="0" max="${totalFrames - 1}" value="0" class="replay-slider" id="scrubber" step="1" aria-label="Time travel scrubber" />
      </div>

      <div style="height: 340px; margin: var(--sp-4) 0 0;" id="replay-chart"></div>

      <div class="replay-narration" id="narration">
        ${escapeHtml(sanitizeNarration(scenario.narrations[frames[0].n]) || "Move the slider or click a date marker to begin.")}
      </div>

      <div id="dynamic-callout"></div>

      <div id="final-banner" style="display: none;">
        <div class="replay-final-banner">
          <div>${scenario.finalDelta > 0 ? "Holding outperformed panic-selling by" : "Panic-seller came out ahead by"}</div>
          <span class="num tabular">${Math.abs(scenario.finalDelta).toFixed(1)}%</span>
          <div style="font-size: var(--text-sm); font-weight: 500; margin-top: var(--sp-2); opacity: 0.9;">
            Index dropped ${Math.abs(scenario.indexDrop)}% at its worst · Recovery took ${scenario.recoveryDays} trading days
          </div>
        </div>
      </div>
    </div>

    <details class="replay-context-details" open>
      <summary>${scenario._partial ? "Narrative streaming in…" : "What this scenario is"}</summary>
      <div class="replay-context-body">
        ${scenario._partial ? `<div class="replay-streaming-pulse">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          <span style="margin-left:8px;color:var(--muted);font-size:var(--text-sm);">Writing the day-by-day story now…</span>
        </div>` : ""}
        ${renderDescriptionParagraphs(scenario.description)}
        ${scenario.indexDrop != null ? `<div class="replay-context-stats">
          <div><span class="rc-key">Peak drop</span><span class="rc-val negative">${Math.abs(scenario.indexDrop).toFixed(1)}%</span></div>
          <div><span class="rc-key">Recovery</span><span class="rc-val">${scenario.recoveryDays ? scenario.recoveryDays + " trading days" : "within the plotted window"}</span></div>
          <div><span class="rc-key">Window</span><span class="rc-val">${escapeHtml(scenario.startLabel)} → ${escapeHtml(scenario.endLabel)}</span></div>
          <div><span class="rc-key">Held vs panic delta</span><span class="rc-val ${scenario.finalDelta >= 0 ? "positive" : "negative"}">${scenario.finalDelta >= 0 ? "+" : ""}${scenario.finalDelta.toFixed(1)}%</span></div>
        </div>` : ""}
        ${renderKeyMomentsTimeline(scenario)}
      </div>
    </details>

    <div class="grid" style="grid-template-columns: 1fr 1fr; gap: var(--sp-4); margin-top: var(--sp-6);">
      <div class="card">
        <h4 style="font-size: var(--text-sm); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">What this replay holds constant</h4>
        <ul style="margin-top: var(--sp-3); color: var(--text); line-height: 1.7; font-size: var(--text-sm); padding-left: 18px;">
          <li>A ₹1,00,000 portfolio across 5 diversified Indian large-caps</li>
          <li>The panic-sold line assumes sell-everything on day 3, then stay in cash</li>
          <li>Prices are real historical close values from the actual crash window</li>
          <li>No brokerage or tax drag applied (would widen the held advantage further)</li>
        </ul>
      </div>
      <div class="card">
        <h4 style="font-size: var(--text-sm); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">What this replay teaches</h4>
        <p style="margin-top: var(--sp-3); color: var(--text); line-height: 1.7; font-size: var(--text-sm);">
          The held investor doesn't "beat the crash" — they survive it.
          The panic-seller crystallises a paper loss into a real one and then waits for "the right moment" to re-enter. That moment almost never comes cheaper than where they sold.
        </p>
      </div>
    </div>
  `;

  const scrubber = main.querySelector("#scrubber");
  const sliderPos = main.querySelector("#slider-pos");
  const heldVal = main.querySelector("#held-val");
  const panicVal = main.querySelector("#panic-val");
  const heldDelta = main.querySelector("#held-delta");
  const panicDelta = main.querySelector("#panic-delta");
  const heldDaysLabel = main.querySelector("#held-days-label");
  const narration = main.querySelector("#narration");
  const finalBanner = main.querySelector("#final-banner");
  const chartRoot = main.querySelector("#replay-chart");
  const playBtn = main.querySelector("#play-btn");
  const playSlowBtn = main.querySelector("#play-slow-btn");
  const resetBtn = main.querySelector("#reset-btn");
  const jumpEndBtn = main.querySelector("#jump-end-btn");
  const jumpBottomBtn = main.querySelector("#jump-bottom-btn");
  const moodEl = main.querySelector("#mood-indicator");
  const calloutEl = main.querySelector("#dynamic-callout");

  // Pre-fire the CRASH_SIMULATION_START coach message once
  const state = getState();
  const already = state.coachMessages.some(m => m.eventType === "CRASH_SIMULATION_START" && m.triggerSymbol === scenario.id);
  if (!already) {
    coach({ type: "CRASH_SIMULATION_START", symbol: scenario.id, days: frames.length }).then(msg => {
      msg.triggerSymbol = scenario.id;
      recordCoachMessage(msg);
    });
  }

  let lastNarrationKey = null;
  let playHandle = null;

  function renderAt(idx) {
    currentIdx = Math.max(0, Math.min(frames.length - 1, idx));
    const f = frames[currentIdx];
    const startHeld = frames[0].held;
    const startPanic = frames[0].panic;

    // Update counters (animate last digits via data-atts)
    heldVal.textContent = "₹" + indianNumber(f.held);
    panicVal.textContent = "₹" + indianNumber(f.panic);

    const hd = (f.held - startHeld) / startHeld;
    const pd = (f.panic - startPanic) / startPanic;
    heldDelta.textContent = (hd > 0 ? "+" : "") + (hd * 100).toFixed(1) + "%";
    panicDelta.textContent = (pd > 0 ? "+" : "") + (pd * 100).toFixed(1) + "%";

    heldDaysLabel.textContent = `Day ${f.day}`;
    sliderPos.textContent = `Day ${f.day}`;

    // Apply colors to deltas
    heldDelta.className = "delta tabular " + (hd > 0 ? "up" : hd < 0 ? "down" : "");
    panicDelta.className = "delta tabular " + (pd > 0 ? "up" : pd < 0 ? "down" : "");

    // Narration (only when key changes)
    const activeNarKey = pickActiveNarration(frames, currentIdx);
    if (activeNarKey !== lastNarrationKey) {
      narration.classList.add("fading");
      setTimeout(() => {
        narration.textContent = sanitizeNarration(scenario.narrations[activeNarKey]) || "";
        narration.classList.remove("fading");
      }, 150);
      lastNarrationKey = activeNarKey;
    }

    // Chart — we supply interpolated series up to currentIdx full range.
    // The 1.5s chart-draw animation was redundant after the generating-
    // stage's mini-sparkline already showed the user the chart shape
    // live during generation. Replaying the same line over 1.5s on
    // arrival just made every replay feel ~1.5s slower for nothing.
    // Render the chart in its final state immediately.
    const heldSeries = frames.map(f => f.held);
    const panicSeries = frames.map(f => f.panic);
    chartRoot.innerHTML = dualLineChart({
      held: heldSeries, panic: panicSeries, height: 340, width: 900,
      currentIndex: currentIdx,
    });

    // Show final banner at end
    finalBanner.style.display = currentIdx >= frames.length - 1 ? "" : "none";

    // Mood meter — based on current drawdown from start
    const drawdownPct = (f.held - startHeld) / startHeld;
    const mood = drawdownPct >= 0.05 ? { cls: "euphoric", label: "🎉 Euphoric" }
               : drawdownPct >= -0.03 ? { cls: "calm", label: "🧘 Calm" }
               : drawdownPct >= -0.12 ? { cls: "nervous", label: "😰 Nervous" }
               : { cls: "panic", label: "😱 Peak panic" };
    if (moodEl) {
      moodEl.className = "mood-indicator " + mood.cls;
      moodEl.textContent = mood.label;
    }

    // Dynamic callouts at key thresholds
    if (calloutEl) {
      const callouts = [];
      if (drawdownPct <= -0.10 && drawdownPct > -0.20) {
        callouts.push(`<div class="replay-callout"><strong>−10% mark.</strong> Most people start googling "is the market crashing?" here. Heart-rate up. But historically, this is still the normal-correction zone — happens ~1-2 times a year.</div>`);
      } else if (drawdownPct <= -0.20 && drawdownPct > -0.30) {
        callouts.push(`<div class="replay-callout"><strong>−20% — bear market territory.</strong> This is where most retail panic-selling happens. The discomfort is real. But recovery data says: the bigger the drop, the faster (and larger) the eventual bounce tends to be.</div>`);
      } else if (drawdownPct <= -0.30) {
        callouts.push(`<div class="replay-callout"><strong>−30%+ drawdown.</strong> You're looking at a generational buying opportunity — but it won't feel like one. It'll feel like the world is ending. Every single time in history, it wasn't.</div>`);
      } else if (drawdownPct >= 0.05 && currentIdx > frames.length / 2) {
        callouts.push(`<div class="replay-callout"><strong>Back above start.</strong> Notice the gap between the green and red lines — that's the cost of the day-3 panic. You can't re-live it, but you can learn from it.</div>`);
      }
      calloutEl.innerHTML = callouts.join("");
    }

    // Active marker
    const markersWrap = main.querySelector("#markers-wrap");
    if (markersWrap) {
      markersWrap.querySelectorAll(".replay-marker").forEach(mk => {
        const d = parseInt(mk.dataset.idx, 10);
        mk.classList.toggle("active", Math.abs(d - currentIdx) <= 1);
      });
    }
  }

  renderAt(0);

  // The old playReplayIntroAnimation (typewriter / counters / stagger)
  // was meaningful when the replay page loaded INSTANTLY from cache and
  // we needed an artificial sense of work. Now the generating-stage
  // covers that need DURING real generation, so the post-load animation
  // is redundant. We do still keep the chart's SVG draw-in (1.5s) since
  // the scrubber-tick gate makes it run only on first paint and it's a
  // cheap visual win on direct /crash-replay/<id> hits (e.g. shared
  // links). For now, no JS-driven typewriter — the chart's CSS-only
  // draw-in is the only intro effect.

  // PERF — first-paint mark closes the cold-start clock that customCrash.js
  // started with cc:start. Only fired for genuinely-fresh generations
  // (cc:start exists in the perf buffer); cached scenarios skip the report.
  // The report is gated on ?perf or localStorage["ss.perf"]; see PERF_AUDIT §1.
  try {
    const startMark = performance.getEntriesByName("cc:start", "mark").pop();
    if (startMark) {
      performance.mark("cc:first-paint");
      try { performance.measure("cc:total", "cc:start", "cc:first-paint"); } catch {}
      // Defer the report so it lands AFTER the browser commits the paint —
      // requestAnimationFrame fires before paint, so chain a microtask.
      requestAnimationFrame(() => {
        setTimeout(() => {
          try { window.__ccPerfReport && window.__ccPerfReport(); } catch {}
        }, 0);
      });
    }
  } catch {}

  scrubber.addEventListener("input", (e) => {
    const idx = parseInt(e.target.value, 10);
    renderAt(idx);
    stopPlayback();
  });

  resetBtn.addEventListener("click", () => {
    stopPlayback();
    scrubber.value = "0";
    renderAt(0);
  });
  jumpEndBtn.addEventListener("click", () => {
    stopPlayback();
    scrubber.value = String(frames.length - 1);
    renderAt(frames.length - 1);
    fireEndMessage();
  });
  function startPlayback(durationMs, btnEl) {
    if (playHandle) { stopPlayback(); return; }
    const startTime = performance.now();
    if (btnEl) btnEl.textContent = "⏸ Pause";
    function step(now) {
      const elapsed = now - startTime;
      const pct = Math.min(1, elapsed / durationMs);
      const idx = Math.floor(pct * (frames.length - 1));
      scrubber.value = String(idx);
      renderAt(idx);
      if (pct < 1) playHandle = requestAnimationFrame(step);
      else { stopPlayback(); fireEndMessage(); }
    }
    playHandle = requestAnimationFrame(step);
  }

  playBtn.addEventListener("click", () => startPlayback(15000, playBtn));
  playSlowBtn?.addEventListener("click", () => startPlayback(30000, playSlowBtn));
  jumpBottomBtn?.addEventListener("click", () => {
    stopPlayback();
    // Jump to the lowest held value frame
    let minIdx = 0, minVal = Infinity;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].held < minVal) { minVal = frames[i].held; minIdx = i; }
    }
    scrubber.value = String(minIdx);
    renderAt(minIdx);
  });

  // Marker clicks
  main.querySelectorAll(".replay-marker").forEach(mk => {
    mk.addEventListener("click", () => {
      const idx = parseInt(mk.dataset.idx, 10);
      stopPlayback();
      scrubber.value = String(idx);
      renderAt(idx);
    });
  });

  function stopPlayback() {
    if (playHandle) {
      cancelAnimationFrame(playHandle);
      playHandle = null;
      playBtn.textContent = "▶ Auto-play (15s)";
      if (playSlowBtn) playSlowBtn.textContent = "🐢 Slow (30s)";
    }
  }

  let endFired = false;
  function fireEndMessage() {
    if (endFired) return;
    endFired = true;
    // Mark completed
    setState(s => ({
      ...s,
      demo: {
        ...s.demo,
        crashReplayCompleted: s.demo.crashReplayCompleted.includes(scenario.id)
          ? s.demo.crashReplayCompleted
          : [...s.demo.crashReplayCompleted, scenario.id],
      },
    }));
    coach({
      type: "CRASH_SIMULATION_END",
      symbol: scenario.id,
      heldBeat: scenario.finalDelta > 0,
      delta: scenario.finalDelta,
      crashTitle: scenario.title,
      indexDrop: `${scenario.indexDrop}%`,
      recoveryDays: scenario.recoveryDays,
    }).then(msg => {
      msg.triggerSymbol = scenario.id;
      recordCoachMessage(msg);
    });
  }

  // Cleanup when leaving page
  const cleanup = () => {
    stopPlayback();
    window.removeEventListener("ss:navigate", cleanup);
  };
  window.addEventListener("ss:navigate", cleanup, { once: true });
}

function pickActiveNarration(frames, idx) {
  for (let i = idx; i >= 0; i--) {
    if (frames[i].n) return frames[i].n;
  }
  return null;
}

// =============================================================================
// REPLAY INTRO ANIMATION
//
// "Streaming-look" UX: every replay load (cache hit OR live) plays a 5-7s
// orchestrated reveal so the page feels alive instead of dumping a fully-
// rendered scenario instantly. Sequence:
//   t=0s    chart starts SVG draw-in (1.5s, handled by chart's animate flag)
//           stats card numbers count UP to real values (1.2s, ease-out cubic)
//   t=0.2s  title fades in
//   t=0.5s  typewriter starts on description paragraphs (~22ms/char)
//   t=4-6s  key-moment cards stagger in (150ms between each)
// The Skip Animation button cancels mid-flight and snaps to final state.
// Per-scenario one-shot guard: a re-render of the same scenario.id won't
// replay (so when the partial→full re-render fires after streaming, the
// animation doesn't double-fire).
// =============================================================================
const _replayAnimPlayed = new Set();
function playReplayIntroAnimation(main, scenario) {
  if (!scenario || !scenario.id) return;
  if (_replayAnimPlayed.has(scenario.id)) return;
  // Skip on _partial — the partial→full re-render will trigger this fresh
  // with the complete scenario.
  if (scenario._partial) return;
  _replayAnimPlayed.add(scenario.id);

  const skipBtn = main.querySelector("#skip-anim-btn");
  const titleEl = main.querySelector(".replay-title-inline strong");
  const heldVal = main.querySelector("#held-val");
  const heldDelta = main.querySelector("#held-delta");
  const paraEls = main.querySelectorAll(".replay-context-para");
  const timelineRows = main.querySelectorAll(".replay-timeline-row");

  // Snapshot final values + hide. Only the FIRST paragraph gets the
  // caret — subsequent paragraphs are completely empty (no caret) so
  // they don't visually compete with the active typing line.
  paraEls.forEach((p, i) => {
    p.dataset.full = p.textContent;
    p.textContent = "";
    if (i === 0) p.classList.add("ss-typewriter-caret");
  });
  timelineRows.forEach(r => r.classList.add("ss-anim-hidden"));
  if (titleEl) titleEl.classList.add("ss-anim-hidden");

  let cancelled = false;
  const timers = [];
  let raf = null;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    timers.forEach(clearTimeout);
    if (raf) cancelAnimationFrame(raf);
    paraEls.forEach(p => {
      p.textContent = p.dataset.full || "";
      p.classList.remove("ss-typewriter-caret");
    });
    timelineRows.forEach(r => r.classList.remove("ss-anim-hidden"));
    if (titleEl) titleEl.classList.remove("ss-anim-hidden");
    if (heldVal) heldVal.textContent = "₹1,00,000";
    if (heldDelta) {
      heldDelta.textContent = "+0.00%";
      heldDelta.className = "delta tabular";
    }
    skipBtn?.setAttribute("hidden", "");
  };
  if (skipBtn) {
    skipBtn.removeAttribute("hidden");
    skipBtn.addEventListener("click", cancel, { once: true });
  }
  // Cancel on hashchange so navigating away doesn't leave timers running.
  const onHashChange = () => cancel();
  window.addEventListener("ss:navigate", onHashChange, { once: true });

  // Stats counter (t=0): held starts at 100k, drops to peak-trough.
  // Day-0 is always 100k so the counter "ticks up" visually from 0.
  const peakDrop = Math.abs(scenario.indexDrop || 0);
  const counterStart = performance.now();
  const counterDur = 1200;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const tick = (now) => {
    if (cancelled) return;
    const t = Math.min(1, (now - counterStart) / counterDur);
    const v = ease(t);
    if (heldVal) heldVal.textContent = "₹" + indianNumber(Math.round(100000 * v));
    if (heldDelta) heldDelta.textContent = "0.00%";
    if (t < 1) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  // Title fade-in (t=200ms).
  timers.push(setTimeout(() => {
    if (cancelled || !titleEl) return;
    titleEl.classList.remove("ss-anim-hidden");
    titleEl.classList.add("ss-anim-fade");
  }, 200));

  // Typewriter (t=500ms). Sized for a 1200-char description to type out
  // in ~2s. 6ms tick × 5 chars per tick = 1.2ms/char effective.
  // Caret moves with the active paragraph so only one cursor is visible
  // at any moment. The key-moments stagger fires INDEPENDENTLY at t=2.2s
  // (running parallel with the typewriter tail) so the whole experience
  // wraps in ~3s end-to-end.
  timers.push(setTimeout(() => {
    if (cancelled || !paraEls.length) return;
    let pIdx = 0, cIdx = 0;
    const PER_TICK_MS = 6;
    const CHARS_PER_TICK = 5;
    const PARA_PAUSE = 80;
    const step = () => {
      if (cancelled) return;
      const p = paraEls[pIdx];
      if (!p) return finish();
      const full = p.dataset.full || "";
      if (cIdx <= full.length) {
        p.textContent = full.slice(0, cIdx);
        cIdx = Math.min(full.length + 1, cIdx + CHARS_PER_TICK);
        timers.push(setTimeout(step, PER_TICK_MS));
      } else {
        // Move caret from finished paragraph to next one.
        p.classList.remove("ss-typewriter-caret");
        pIdx++; cIdx = 0;
        if (paraEls[pIdx]) {
          paraEls[pIdx].classList.add("ss-typewriter-caret");
          timers.push(setTimeout(step, PARA_PAUSE));
        } else {
          finish();
        }
      }
    };
    const finish = () => {
      if (cancelled) return;
      // Hide skip button when typewriter completes.
      timers.push(setTimeout(() => {
        skipBtn?.setAttribute("hidden", "");
      }, 200));
    };
    step();
  }, 500));

  // Key-moments stagger fires INDEPENDENTLY at t=2.2s — runs in parallel
  // with the typewriter tail. By the time typing finishes (~2.5-3s) the
  // user has already seen the bottom of the page populate. Total intro
  // is ~3s end-to-end instead of 5-7s.
  timers.push(setTimeout(() => {
    if (cancelled) return;
    timelineRows.forEach((row, i) => {
      timers.push(setTimeout(() => {
        if (cancelled) return;
        row.classList.remove("ss-anim-hidden");
        row.classList.add("ss-anim-slide-up");
      }, i * 90));
    });
  }, 2200));
}

function buildMarkers(scenario) {
  const frames = scenario.frames;
  const markers = [];
  // Start
  markers.push({ idx: 0, short: "Start", label: scenario.startLabel });
  // Bottom (lowest held value)
  let minIdx = 0, minVal = Infinity;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].held < minVal) { minVal = frames[i].held; minIdx = i; }
  }
  if (minIdx > 0 && minIdx < frames.length - 1) {
    markers.push({ idx: minIdx, short: "Bottom", label: `Lowest point — day ${frames[minIdx].day}` });
  }
  // A mid-point between start and bottom (the "peak panic" moment)
  if (minIdx > 4) {
    const midPanicIdx = Math.floor(minIdx * 0.75);
    markers.push({ idx: midPanicIdx, short: "−20%", label: "Peak retail panic zone" });
  }
  // Recovery marker — first frame after bottom that's materially higher
  for (let i = minIdx + 1; i < frames.length; i++) {
    if (frames[i].held > frames[minIdx].held * 1.08) {
      markers.push({ idx: i, short: "Recovery", label: "+8% off the low — trend shift" });
      break;
    }
  }
  // End
  markers.push({ idx: frames.length - 1, short: "End", label: scenario.endLabel });
  // Dedupe by idx + sort by position.
  const seen = new Set();
  const sorted = markers.filter(m => {
    if (seen.has(m.idx)) return false;
    seen.add(m.idx);
    return true;
  }).sort((a, b) => a.idx - b.idx);
  // Collapse markers that are too close on the slider — within 6% of total
  // frames they'll visually overlap their labels (e.g. Bottom + Recovery
  // when recovery happens just after the trough). Priority order keeps
  // Start, End, and Bottom; drops Recovery and -20% when they collide.
  const minGap = Math.max(2, Math.floor(frames.length * 0.06));
  const PRIORITY = { Start: 5, End: 5, Bottom: 4, "−20%": 2, Recovery: 3 };
  const out = [];
  for (const m of sorted) {
    const prev = out[out.length - 1];
    if (prev && m.idx - prev.idx < minGap) {
      // Conflict — keep the higher-priority one.
      if ((PRIORITY[m.short] || 1) > (PRIORITY[prev.short] || 1)) {
        out[out.length - 1] = m;
      }
      // Otherwise drop m by not pushing.
    } else {
      out.push(m);
    }
  }
  return out;
}

function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

// =============================================================================
// GENERATING STAGE — replaces selector main during replay generation.
// Renders 4 stage rows + a live feed area + progress bar. The caller
// drives state transitions via advanceGeneratingStage(main, stageId, opts).
// =============================================================================
const GEN_STAGES = [
  { id: "cache",  label: "Looking up cached replay",            shortLabel: "Cache" },
  { id: "phaseA", label: "Identifying event + dates",            shortLabel: "Identify" },
  { id: "phaseB", label: "Fetching real prices from Yahoo Finance", shortLabel: "Prices" },
  { id: "phaseC", label: "Writing narrative",                    shortLabel: "Narrate" },
];
// Mark a stage node as pending|active|done|error with optional detail.
// Also lights up the connecting flow-link to the next stage when this
// one becomes done. Idempotent.
function advanceGeneratingStage(main, stageId, state, detail) {
  const node = main.querySelector(`.gen-flow-node[data-stage="${stageId}"]`);
  if (!node) return;
  node.dataset.state = state;
  const detailEl = node.querySelector(".gen-flow-detail");
  if (detailEl && detail != null) detailEl.textContent = detail;
  // Light up the link AFTER this node when it goes done.
  const allNodes = Array.from(main.querySelectorAll(".gen-flow-node"));
  const idx = allNodes.indexOf(node);
  if (state === "done" && idx >= 0 && idx < allNodes.length - 1) {
    const link = main.querySelector(`.gen-flow-link[data-link="${idx}"]`);
    if (link) link.classList.add("gen-link-done");
  }
}

// Append a row to the live feed area. Used to stream Phase B prices
// as they arrive so the user sees a tape ticker effect. Auto-scrolls
// to keep the latest visible. Trim past 8 rows.
function appendGenFeedRow(main, html) {
  const feed = main.querySelector("#gen-feed");
  if (!feed) return;
  const empty = feed.querySelector(".gen-feed-empty");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = "gen-feed-row";
  row.innerHTML = html;
  feed.appendChild(row);
  const rows = feed.querySelectorAll(".gen-feed-row");
  if (rows.length > 8) rows[0].remove();
  feed.scrollTop = feed.scrollHeight;
}

// Build the mini-sparkline progressively from a series of close prices.
// Called after Phase B with the full closes array — animates each point
// in over ~600ms so the spark visibly "draws" rather than appearing all
// at once. Auto-scales to viewBox.
function drawGenSparkline(main, closes) {
  if (!Array.isArray(closes) || closes.length < 2) return;
  const path = main.querySelector("#gen-spark-path");
  const fill = main.querySelector("#gen-spark-fill");
  if (!path) return;
  const w = 200, h = 60, pad = 2;
  const min = Math.min(...closes), max = Math.max(...closes);
  const range = max - min || 1;
  const toX = (i) => pad + (i / (closes.length - 1)) * (w - pad * 2);
  const toY = (v) => pad + (h - pad * 2) - ((v - min) / range) * (h - pad * 2);
  // Animate by progressively building the path.
  const totalSteps = Math.min(closes.length, 30);
  const stride = closes.length / totalSteps;
  let step = 0;
  const draw = () => {
    if (step > totalSteps) return;
    let d = "", lastX = 0, lastY = 0;
    for (let i = 0; i <= step; i++) {
      const realIdx = Math.min(closes.length - 1, Math.floor(i * stride));
      const x = toX(realIdx);
      const y = toY(closes[realIdx]);
      d += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1) + " ";
      lastX = x; lastY = y;
    }
    path.setAttribute("d", d.trim());
    if (fill) {
      // Close the path down to baseline for the gradient fill.
      fill.setAttribute("d", d.trim() + ` L${lastX.toFixed(1)},${(h - pad).toFixed(1)} L${pad},${(h - pad).toFixed(1)} Z`);
    }
    step++;
    if (step <= totalSteps) setTimeout(draw, 18);
  };
  draw();
}

// Replace the live feed with a single narrative-streaming text block.
// Called when Phase C starts. Caller updates .textContent as SSE chunks
// arrive — caret is via CSS ::after so no JS animation needed.
function startGenFeedNarrative(main) {
  const feed = main.querySelector("#gen-feed");
  if (!feed) return;
  feed.innerHTML = `<div class="gen-feed-narrative" id="gen-feed-narrative"></div>`;
}
function updateGenFeedNarrative(main, text) {
  const el = main.querySelector("#gen-feed-narrative");
  if (!el) return;
  el.textContent = text;
}

// REVAMP v2: render the generating UI INSIDE the existing input card,
// preserving the selector page context (hero text, featured cards, etc.
// stay visible). Visual: stage-dots (4 connected circles + glowing
// progress line), a real-time mini-sparkline that builds as Phase B
// prices arrive, and a compact source-chain detail line. Far less
// "bland separate page" and more "live console below the input".
function renderGeneratingStage(main, queryText) {
  const safeQuery = escapeHtml(queryText);
  // Find the input card and inject the generating UI into it,
  // collapsing the input area but keeping the rest of the page intact.
  const card = main.querySelector("#custom-crash-card");
  if (!card) {
    // Fallback if structure isn't there — inject at top of main.
    const stub = document.createElement("div");
    main.insertBefore(stub, main.firstChild);
    stub.innerHTML = `<div class="card" id="custom-crash-card"></div>`;
    return renderGeneratingStage(main, queryText);
  }
  // Cache the original card HTML so trigger()'s catch can restore on
  // error if needed (currently we render inline error inside the stage).
  card.innerHTML = `
    <div class="generating-stage gen-inline" id="gen-stage">
      <div class="gen-header">
        <span class="gen-pulse"></span>
        <strong>Generating</strong>
        <span class="gen-query">"${safeQuery}"</span>
      </div>
      <div class="gen-flow" role="progressbar">
        ${GEN_STAGES.map((s, i) => `
          <div class="gen-flow-node" data-stage="${s.id}" data-state="pending">
            <span class="gen-flow-dot"></span>
            <span class="gen-flow-label">${escapeHtml(s.shortLabel || s.label)}</span>
            <span class="gen-flow-detail"></span>
          </div>
          ${i < GEN_STAGES.length - 1 ? `<div class="gen-flow-link" data-link="${i}"></div>` : ""}
        `).join("")}
      </div>
      <div class="gen-body">
        <div class="gen-feed-col">
          <div class="gen-feed-label">LIVE FEED</div>
          <div class="gen-feed" id="gen-feed">
            <div class="gen-feed-empty">Waiting for data…</div>
          </div>
        </div>
        <div class="gen-spark-col">
          <div class="gen-feed-label">PRICE TRAJECTORY</div>
          <div class="gen-spark" id="gen-spark">
            <svg viewBox="0 0 200 60" preserveAspectRatio="none" width="100%" height="60" aria-hidden="true">
              <path id="gen-spark-path" fill="none" stroke="var(--brand)" stroke-width="2" stroke-linecap="round" />
              <path id="gen-spark-fill" fill="url(#genSparkGrad)" opacity="0.35" />
              <defs>
                <linearGradient id="genSparkGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="var(--brand)" stop-opacity="0.5" />
                  <stop offset="100%" stop-color="var(--brand)" stop-opacity="0" />
                </linearGradient>
              </defs>
            </svg>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Extract title + description from in-flight Phase C JSON and patch
// the live page DOM as those keys close. The partial text is mid-stream
// JSON like `{"title":"COVID-19 Crash","startLabel":"Mar 11, 2020"...`
// We do NOT try to JSON.parse — it would fail until the closing brace.
// Instead, simple string-search for the closed key; once we see the
// terminating quote of the value, we render. Idempotent: re-renders
// only when the captured text actually changes.
const _streamPatchState = { lastTitle: "", lastDesc: "" };
function _patchPartialFromStream(main, partialText) {
  // Title: matches "title": "...something..."
  const titleMatch = partialText.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (titleMatch && titleMatch[1] && titleMatch[1] !== _streamPatchState.lastTitle) {
    _streamPatchState.lastTitle = titleMatch[1];
    const titleEl = main.querySelector(".replay-title-inline strong");
    if (titleEl) titleEl.textContent = _unescapeJsonStr(titleMatch[1]);
  }
  // Description: matches "description": "...long text..."
  const descMatch = partialText.match(/"description"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (descMatch && descMatch[1] && descMatch[1] !== _streamPatchState.lastDesc) {
    _streamPatchState.lastDesc = descMatch[1];
    const body = main.querySelector(".replay-context-body");
    if (body) {
      const txt = _unescapeJsonStr(descMatch[1]);
      // Replace just the pulse + paragraphs, leave the stats/timeline alone.
      const pulse = body.querySelector(".replay-streaming-pulse");
      const existingParas = body.querySelectorAll(".replay-context-para");
      existingParas.forEach(p => p.remove());
      const html = renderDescriptionParagraphs(txt);
      if (pulse) {
        pulse.insertAdjacentHTML("afterend", html);
      } else {
        body.insertAdjacentHTML("afterbegin", html);
      }
    }
  }
}
function _unescapeJsonStr(s) {
  // Minimal JSON string unescape: \\ \" \n \r \t \uXXXX
  return String(s).replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (m, esc) => {
    if (esc === "\"") return "\"";
    if (esc === "\\") return "\\";
    if (esc === "/") return "/";
    if (esc === "b") return "\b";
    if (esc === "f") return "\f";
    if (esc === "n") return "\n";
    if (esc === "r") return "\r";
    if (esc === "t") return "\t";
    if (esc[0] === "u") return String.fromCharCode(parseInt(esc.slice(1), 16));
    return m;
  });
}


// Render description as separate <p> tags on blank-line / double-newline
// paragraph breaks. Tolerates single-paragraph inputs too.
function renderDescriptionParagraphs(desc) {
  const s = String(desc || "").trim();
  if (!s) return "";
  const paragraphs = s.split(/\n\s*\n|\.\s+(?=[A-Z])/).reduce((acc, chunk, i, arr) => {
    // We split on period-then-capital to catch prose that uses single newlines.
    // Re-attach the trailing period we consumed in the split, but only when the
    // next chunk starts with a capital.
    if (i === arr.length - 1) acc.push(chunk);
    else acc.push(chunk.endsWith(".") || chunk.endsWith("!") || chunk.endsWith("?") ? chunk : chunk + ".");
    return acc;
  }, []);
  // Merge short fragments to keep paragraphs meaningful (>= 3 sentences each).
  const merged = [];
  let buf = "";
  for (const p of paragraphs) {
    buf = buf ? buf + " " + p : p;
    if (buf.split(/[.!?]\s/).length >= 3) {
      merged.push(buf);
      buf = "";
    }
  }
  if (buf) {
    if (merged.length === 0) merged.push(buf);
    else merged[merged.length - 1] += " " + buf;
  }
  return merged.map(p => `<p class="replay-context-para">${escapeHtml(p.trim())}</p>`).join("");
}

// Render the scenario's key moments as a mini timeline beneath the prose.
function renderKeyMomentsTimeline(scenario) {
  const frames = scenario.frames || [];
  if (!frames.length) return "";
  // A key moment is any frame carrying an `n` (narration id)
  const moments = frames
    .filter(f => f.n && scenario.narrations?.[f.n])
    .map(f => ({
      day: f.day,
      narration: sanitizeNarration(scenario.narrations[f.n]),
      heldDelta: (f.held - frames[0].held) / frames[0].held,
    }));
  if (!moments.length) return "";
  return `
    <div class="replay-timeline">
      <div class="replay-timeline-head">Key moments in this replay</div>
      ${moments.map(m => `
        <div class="replay-timeline-row">
          <div class="replay-timeline-day">Day ${m.day}${m.heldDelta !== 0 ? ` · <span class="${m.heldDelta >= 0 ? "positive" : "negative"}">${m.heldDelta >= 0 ? "+" : ""}${(m.heldDelta * 100).toFixed(1)}%</span>` : ""}</div>
          <div class="replay-timeline-body">${escapeHtml(m.narration)}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function indianNumber(n) {
  if (n == null) return "0";
  const abs = Math.abs(Math.round(n));
  const sign = n < 0 ? "-" : "";
  if (abs < 1000) return sign + abs.toString();
  const str = String(abs);
  const last3 = str.slice(-3);
  const rest = str.slice(0, -3);
  return sign + rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
}
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}
