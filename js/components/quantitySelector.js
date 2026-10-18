// =============================================================================
// QUANTITY SELECTOR — Unified sell/buy quantity UX.
// Stepper + slider + 25/50/75/100% quick-fill (max = holding on SELL, cash-based
// for BUY). Prevents "accidental sell-all" by never defaulting to max.
// =============================================================================

import { formatQty, formatRupees } from "../money.js";

/**
 * Render a quantity selector into a container. Returns { get, set, destroy }.
 * @param container HTMLElement
 * @param opts {
 *   side: "BUY" | "SELL",
 *   kind: "EQUITY" | "ETF" | "MF",
 *   pricePaise: number,
 *   cashPaise: number,
 *   holdingQty: number,
 *   onChange: (qty) => void
 * }
 */
export function mountQuantitySelector(container, opts) {
  const state = {
    qty: opts.initialQty != null ? opts.initialQty : (opts.kind === "MF" ? 0.5 : 1),
  };

  const min = opts.kind === "MF" ? 0.01 : 1;
  const step = opts.kind === "MF" ? 0.1 : 1;
  const fixedDp = opts.kind === "MF" ? 2 : 0;

  const maxQty = computeMax();

  function computeMax() {
    if (opts.side === "SELL") return opts.holdingQty;
    if (opts.pricePaise <= 0) return 0;
    return Math.floor((opts.cashPaise / opts.pricePaise) * 100) / 100;
  }

  function clamp(v) {
    if (!Number.isFinite(v) || v < min) return min;
    if (maxQty && v > maxQty) return roundQty(maxQty);
    return roundQty(v);
  }

  function roundQty(v) {
    if (opts.kind === "MF") return Math.round(v * 100) / 100;
    return Math.floor(v);
  }

  function setQty(v, silent = false) {
    state.qty = clamp(v);
    render();
    if (!silent) opts.onChange?.(state.qty);
  }

  function render() {
    const pct100 = maxQty > 0 ? (state.qty / maxQty) * 100 : 0;
    const pctPreset = pct100 >= 99 ? 100 : pct100 >= 74 ? 75 : pct100 >= 49 ? 50 : pct100 >= 24 ? 25 : 0;

    const maxLabel = maxQty > 0
      ? `Max: ${formatQty(maxQty, opts.kind)}${opts.side === "SELL" ? ` held` : ""}`
      : "No headroom";

    container.innerHTML = `
      <label class="label">Quantity</label>
      <div class="qty-stepper">
        <button type="button" data-step="-${step}" aria-label="Decrease">−</button>
        <input class="input" type="number" min="${min}" step="${step}" value="${state.qty.toFixed(fixedDp)}" id="qty-input" inputmode="decimal" />
        <button type="button" data-step="+${step}" aria-label="Increase">+</button>
      </div>

      <div class="qty-slider-wrap">
        <input type="range" class="qty-slider" min="${min}" max="${Math.max(min, maxQty)}" step="${step}"
               value="${state.qty}" id="qty-slider" aria-label="Quantity slider" />
        <div class="flex justify-between" style="font-size: var(--text-11); color: var(--text-dim); margin-top: 4px;">
          <span>${min}</span>
          <span>${maxLabel}</span>
        </div>
      </div>

      <div class="qty-quick-row">
        <button type="button" class="qty-quick ${pctPreset === 25 ? "active" : ""}" data-pct="25">25%</button>
        <button type="button" class="qty-quick ${pctPreset === 50 ? "active" : ""}" data-pct="50">50%</button>
        <button type="button" class="qty-quick ${pctPreset === 75 ? "active" : ""}" data-pct="75">75%</button>
        <button type="button" class="qty-quick ${pctPreset === 100 ? "active" : ""}" data-pct="100">${opts.side === "SELL" ? "All" : "Max"}</button>
      </div>
    `;

    const input = container.querySelector("#qty-input");
    const slider = container.querySelector("#qty-slider");

    input.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v)) {
        state.qty = clamp(v);
        slider.value = state.qty;
        opts.onChange?.(state.qty);
      }
    });
    input.addEventListener("change", (e) => {
      // Re-render only on blur/commit to avoid fighting the user's typing
      setQty(parseFloat(e.target.value));
    });

    slider.addEventListener("input", (e) => {
      setQty(parseFloat(e.target.value));
    });

    container.querySelectorAll("[data-step]").forEach(btn => {
      // Update in place: re-rendering replaced the button under the user's
      // finger, so quick taps were lost (352 "angry" +/- clicks on 18 Oct 2026).
      btn.style.touchAction = "manipulation";
      btn.addEventListener("click", () => {
        state.qty = clamp(state.qty + parseFloat(btn.dataset.step));
        input.value = state.qty.toFixed(fixedDp);
        slider.value = state.qty;
        opts.onChange?.(state.qty);
      });
    });

    container.querySelectorAll("[data-pct]").forEach(btn => {
      btn.addEventListener("click", () => {
        const pct = parseFloat(btn.dataset.pct);
        if (maxQty > 0) setQty(maxQty * pct / 100);
      });
    });
  }

  render();

  return {
    get: () => state.qty,
    set: (v) => setQty(v),
    destroy: () => { container.innerHTML = ""; },
  };
}
