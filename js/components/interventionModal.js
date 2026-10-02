// =============================================================================
// INTERVENTION MODAL — Appears before a panic-sell. Shows historical analog.
// Two choices: "Sell anyway" (proceeds) or "Hold and breathe" (cancels).
//
// Hardening vs the original version:
//   - Sell-anyway button is disabled for 3 s so teens must read the analog.
//   - Escape and overlay-click no longer silently cancel — they just ignore,
//     making the modal a deliberate read instead of a click-through.
//   - Focus is trapped inside the modal for the duration; the previously
//     focused element is restored on close.
//   - All interpolated user/instrument strings are escaped (XSS-safe).
// =============================================================================

import { formatAnalog } from "../coach/historicalAnalog.js";

const HOLD_BEFORE_PROCEED_MS = 3000;

export function showInterventionModal({ analog, biasResult, instrument, trade }, { onProceed, onHold }) {
  const modalRoot = document.getElementById("modal-root");
  if (!modalRoot) return;

  const sev = biasResult?.severity ?? 0;
  // The recent move (real closes, from the detector), not the fall from the
  // all-time high; the analog block below states that one separately.
  const ev = biasResult?.evidence || {};
  const dropPct = Math.max(Math.abs(ev.drop_3d_pct ?? 0), Math.abs(ev.drop_intraday_pct ?? 0));
  const instName = escapeHtml(instrument?.name || "this stock");
  const instSym = escapeHtml(instrument?.symbol || "");

  modalRoot.innerHTML = `
    <div class="modal-overlay" id="intervention-overlay" role="dialog" aria-modal="true" aria-labelledby="intervention-title" tabindex="-1">
      <div class="modal" role="document">
        <div class="modal-head">
          <div class="modal-icon ${sev >= 0.7 ? "danger" : "warn"}" aria-hidden="true">${sev >= 0.7 ? "🛑" : "⚠"}</div>
          <div>
            <div class="modal-kicker">Pattern detected · Panic-sell signal</div>
            <h2 id="intervention-title">Before you sell, a moment of data.</h2>
          </div>
        </div>
        <div class="modal-body">
          <p>
            You are about to sell <strong>${instName}</strong> after
            a <strong>${Number(dropPct).toFixed(1)}%</strong> drop in recent sessions, within
            <strong>${daysSince(trade?.holding?.firstBoughtAt)}</strong> of buying it.
          </p>
          ${analog ? analogBlock(analog, instName) : ""}
          <p class="dim intervention-fineprint">
            This is not advice. This is pattern-matched history.
            If your thesis for owning ${instSym || instName} hasn't changed, the drop itself isn't the signal to sell.
            If your thesis has changed — that's a different conversation.
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-outline" id="intervention-proceed" disabled aria-disabled="true">
            <span id="intervention-proceed-label">Sell anyway (${HOLD_BEFORE_PROCEED_MS / 1000}s)</span>
          </button>
          <button class="btn btn-primary" id="intervention-hold">Hold and breathe</button>
        </div>
      </div>
    </div>
  `;

  const overlay = modalRoot.querySelector("#intervention-overlay");
  const modal = modalRoot.querySelector(".modal");
  const proceedBtn = modalRoot.querySelector("#intervention-proceed");
  const proceedLabel = modalRoot.querySelector("#intervention-proceed-label");
  const holdBtn = modalRoot.querySelector("#intervention-hold");

  const prevFocus = document.activeElement;
  let remaining = Math.round(HOLD_BEFORE_PROCEED_MS / 1000);
  const ticker = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      proceedLabel.textContent = "Sell anyway";
      proceedBtn.disabled = false;
      proceedBtn.setAttribute("aria-disabled", "false");
      clearInterval(ticker);
    } else {
      proceedLabel.textContent = `Sell anyway (${remaining}s)`;
    }
  }, 1000);

  const close = () => {
    clearInterval(ticker);
    document.removeEventListener("keydown", onKey, true);
    modalRoot.innerHTML = "";
    if (prevFocus && typeof prevFocus.focus === "function") {
      try { prevFocus.focus(); } catch {}
    }
  };

  // Ignore overlay clicks — deliberate choice makes the modal a real
  // decision, not a dismiss-to-skip interstitial.
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) e.preventDefault();
  });

  // Focus trap: keep Tab inside the modal. Escape is a no-op (users must
  // pick one of the two buttons).
  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      // shake the Hold button to signal "make a real choice"
      holdBtn.classList.add("shake");
      setTimeout(() => holdBtn.classList.remove("shake"), 300);
      return;
    }
    if (e.key === "Tab") {
      const focusable = modal.querySelectorAll(
        "button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }
  }
  document.addEventListener("keydown", onKey, true);

  proceedBtn.addEventListener("click", () => {
    if (proceedBtn.disabled) return;
    close();
    onProceed?.();
  });
  holdBtn.addEventListener("click", () => {
    close();
    onHold?.();
  });

  setTimeout(() => holdBtn.focus(), 50);
}

function daysSince(ts) {
  if (!ts) return "a short time";
  const d = Math.max(1, Math.floor((Date.now() - ts) / 86400000));
  return `${d} day${d === 1 ? "" : "s"}`;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}

function fmtDay(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Recovered falls AND the ones that never recovered, never the median alone.
function analogBlock(a, instName) {
  const n = (v) => escapeHtml(String(v));
  const who = a.source === "nifty" ? "the Nifty 50 index" : instName;
  const where = a.source === "symbol" && a.peak
    ? `<p>${instName} is <strong>${n(a.drawdownPct)}% below its highest close</strong>
         (₹${n(Number(a.peak).toLocaleString("en-IN"))} on ${n(fmtDay(a.peakDate))}).</p>`
    : `<p>We don't have reliable long-term prices for ${instName}. For reference, here is ${who}.</p>`;
  const back = a.sampleSize
    ? `It climbed back ${n(a.sampleSize)} of those times: median <strong>${n(a.recoveryDays)} trading days</strong>, slowest ${n(a.maxRecoveryDays)}.`
    : `It has not climbed back from any of them yet.`;
  const open = a.openDays
    ? ` The current fall has lasted ${n(a.openDays)} trading days so far${a.asOf ? ` (to ${n(fmtDay(a.asOf))})` : ""}.`
    : "";
  return `
            ${where}
            <div class="intervention-data">
              <div class="dim intervention-caption">Past falls of ${n(a.bucket)}% or more that recovered</div>
              <div class="big-num tabular">${n(a.sampleSize)} of ${n(a.falls)}</div>
              <div class="sublabel">
                Since ${n(a.sinceYear || "listing")}, ${who} has fallen ${n(a.bucket)}% or more below a previous high
                ${n(a.falls)} time${a.falls === 1 ? "" : "s"}. ${back}${open}
                Past recoveries don't guarantee this one.
              </div>
            </div>`;
}
