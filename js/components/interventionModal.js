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
  const dropPct = analog?.drawdownPct ?? Math.abs(biasResult?.evidence?.drop_3d_pct ?? 0);
  const recoveryDays = analog?.recoveryDays;
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
          ${recoveryDays ? `
            <div class="intervention-data">
              <div class="dim intervention-caption">Historical analog</div>
              <div class="big-num tabular">${recoveryDays}</div>
              <div class="sublabel">
                Median trading days to get back to the previous high, across <strong>${escapeHtml(String(analog.sampleSize))} dips of ${escapeHtml(String(analog.bucket))}% or more</strong>
                on ${analog.source === "nifty" ? "the Nifty 50 index" : instName}${analog.sinceYear ? ` since ${escapeHtml(String(analog.sinceYear))}` : ""}.
                Slowest: ${escapeHtml(String(analog.maxRecoveryDays))} days. Past recoveries don't guarantee this one.
              </div>
            </div>
          ` : ""}
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
