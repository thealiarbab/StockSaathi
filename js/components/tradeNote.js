// =============================================================================
// TRADE NOTE — the quiet note Saathi leaves AFTER a trade that fits a
// behaviour pattern (24 Oct, owner's option C).
//
// It replaced the panic-sell pause, a full-screen modal that stopped the sell
// before it went through. Now the order always goes through first; then a
// small card rises from the coach button with what happened, in the user's
// own numbers. "What is …?" opens the explainer sheet (English / Hinglish,
// like the P/E definition box) with the term, "in your case" chips, one
// question to think about and a way to ask Saathi more. Nothing blocks and
// nothing has to be dismissed.
//
// Notes are rationed (see ROUNDS) so a habit gets one note per stretch, not
// one per trade.
// =============================================================================

import { getState, setSetting } from "../state.js";
import { biasCopy } from "../coach/biasCopy.js";
import { NOTE_THRESHOLD } from "../coach/biasCore.js";
import { onBackdropClick } from "./backdrop.js";
import { track } from "../features/track.js";

const SEEN_KEY = "ss.biasnote.v1";
const H = 3_600_000;
// How long one note on a pattern lasts before the same pattern can show again.
const ROUNDS = {
  panic_sell: [24 * H, "symbol"], fomo: [24 * H, "symbol"], pump_chase: [24 * H, "symbol"],
  anchoring: [72 * H, "symbol"], churning: [72 * H, "symbol"],
  concentration: [7 * 24 * H, "symbol"], sector_concentration: [7 * 24 * H, "sector"],
  disposition: [72 * H, null], overtrading: [20 * H, null],
};
const AUTO_HIDE_MS = 30_000;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hinglish = () => { try { return !!getState()?.settings?.hinglish; } catch { return false; } };

function seenKey(r) {
  const [, by] = ROUNDS[r.bias] || [24 * H, "symbol"];
  const id = by === "sector" ? r.evidence?.top_sector : by === "symbol" ? r.evidence?.symbol : "";
  return `${r.bias}|${id || ""}`;
}
function recentlyShown(r) {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
    const ts = seen[seenKey(r)];
    return ts && Date.now() - ts < (ROUNDS[r.bias]?.[0] ?? 24 * H);
  } catch { return false; }
}
function markShown(r) {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
    const now = Date.now();
    for (const k of Object.keys(seen)) if (now - seen[k] > 8 * 24 * H) delete seen[k];
    seen[seenKey(r)] = now;
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {}
}

/** The detector result worth a note, if any: strongest first, not shown lately. */
export function pickNote(results) {
  return (results || []).find((r) => r?.severity >= NOTE_THRESHOLD && biasCopy(r) && !recentlyShown(r)) || null;
}

let _card = null, _hideTimer = null;

/** Show the after-trade note for one detector result. */
export function showTradeNote(result, { name } = {}) {
  if (!result || !biasCopy(result)) return;
  markShown(result);
  closeNote();
  const hi = hinglish();
  const c = biasCopy(result, { name, hi });
  const card = document.createElement("aside");
  card.className = "tn-card";
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");
  card.innerHTML = `
    <div class="tn-head">
      <span class="tn-avatar" aria-hidden="true">S</span>
      <div class="tn-who"><b>${hi ? "Is trade pe ek baat" : "A note on this trade"}</b><span>${hi ? "Saathi se · abhi" : "From Saathi · just now"}</span></div>
      <button type="button" class="tn-x" aria-label="${hi ? "Band karo" : "Dismiss"}">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <p class="tn-body">${esc(c.note)}</p>
    <div class="tn-foot">
      <button type="button" class="tn-learn">${esc(c.learn)}</button>
      <span class="tn-meta">${hi ? "Report card me gina jaata hai" : "Saathi notes this for your report card"}</span>
    </div>`;
  place(card);
  document.body.appendChild(card);
  _card = card;
  requestAnimationFrame(() => card.classList.add("is-in"));
  track("bias_note", result.evidence?.symbol || null, { bias: result.bias, severity: Math.round(result.severity * 100) / 100, action: "shown" });

  card.querySelector(".tn-x").addEventListener("click", () => { track("bias_note", result.evidence?.symbol || null, { bias: result.bias, action: "dismissed" }); closeNote(); });
  card.querySelector(".tn-learn").addEventListener("click", () => {
    track("bias_note", result.evidence?.symbol || null, { bias: result.bias, action: "opened" });
    closeNote();
    openExplainer(result, { name, hi });
  });
  // Quiet: it leaves by itself unless the user is reading it.
  const arm = () => { clearTimeout(_hideTimer); _hideTimer = setTimeout(() => { if (_card === card) closeNote(); }, AUTO_HIDE_MS); };
  card.addEventListener("pointerenter", () => clearTimeout(_hideTimer));
  card.addEventListener("pointerleave", arm);
  card.addEventListener("focusin", () => clearTimeout(_hideTimer));
  arm();
  window.addEventListener("ss:navigate", closeNote, { once: true });
}

// Rise from the coach button wherever the user dragged it; bottom right
// when it is hidden (coach docked or closed).
function place(card) {
  const fab = document.querySelector(".coach-fab");
  const r = fab && fab.offsetParent ? fab.getBoundingClientRect() : null;
  if (!r || window.innerWidth < 560) return;
  const right = Math.max(12, window.innerWidth - r.right);
  const bottom = Math.max(12, window.innerHeight - r.top + 12);
  card.style.right = `${right}px`;
  card.style.bottom = `${bottom}px`;
  card.style.transformOrigin = "100% 100%";
}

export function closeNote() {
  clearTimeout(_hideTimer);
  const c = _card;
  _card = null;
  if (!c) return;
  c.classList.remove("is-in");
  setTimeout(() => c.remove(), 220);
}

// ---- Explainer sheet ------------------------------------------------------------
function openExplainer(result, { name, hi }) {
  const prevFocus = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay tn-overlay";
  document.body.appendChild(overlay);
  let lang = hi;
  const draw = () => {
    const c = biasCopy(result, { name, hi: lang });
    overlay.innerHTML = `
      <div class="modal tn-sheet" role="dialog" aria-modal="true" aria-labelledby="tn-title">
        <div class="tn-sheet-top">
          <span class="tn-kicker">${lang ? "Term samjho" : "What the term means"}</span>
          <div class="tn-lang" role="group" aria-label="Language">
            <button type="button" data-lang="en" aria-pressed="${!lang}">English</button>
            <button type="button" data-lang="hi" aria-pressed="${lang}">Hinglish</button>
          </div>
        </div>
        <h2 id="tn-title">${esc(c.term)}</h2>
        <p class="tn-def">${esc(c.body)}</p>
        <div class="tn-case">
          <span class="tn-case-label">${lang ? "Tumhare case me" : "In your case"}${name ? ` · ${esc(name)}` : ""}</span>
          <div class="tn-chips">${c.chips.map((x) => `<span>${esc(x)}</span>`).join("")}</div>
        </div>
        <p class="tn-q">${esc(c.question)}</p>
        <div class="modal-foot tn-actions">
          <button type="button" class="btn btn-ghost" data-act="ask">${lang ? "Saathi se pucho" : "Ask Saathi"}</button>
          <button type="button" class="btn btn-primary" data-act="ok">${lang ? "Samajh gaya" : "Got it"}</button>
        </div>
      </div>`;
    overlay.querySelectorAll("[data-lang]").forEach((b) => b.addEventListener("click", () => {
      lang = b.dataset.lang === "hi";
      draw();
      overlay.querySelector(`[data-lang="${lang ? "hi" : "en"}"]`)?.focus();
    }));
    overlay.querySelector("[data-act=ok]").addEventListener("click", close);
    overlay.querySelector("[data-act=ask]").addEventListener("click", () => {
      track("bias_note", result.evidence?.symbol || null, { bias: result.bias, action: "ask" });
      close();
      askSaathi(c.term, name, lang);
    });
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  function close() {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    try { prevFocus?.focus?.(); } catch {}
  }
  draw();
  document.addEventListener("keydown", onKey, true);
  onBackdropClick(overlay, close);
  overlay.querySelector("[data-act=ok]").focus();
}

// Open the coach with a question already typed, so one tap sends it.
function askSaathi(term, name, hi) {
  const text = hi
    ? `Mere ${name || "is"} trade pe "${term}" wala note aaya. Isko mere trade ke saath samjhao?`
    : `I got a note about "${term}" on my ${name || ""} trade. Can you go through it with me?`.replace("my  trade", "my trade");
  setSetting("coachPanelOpen", true);
  let tries = 0;
  const fill = () => {
    const input = document.querySelector("#coach-input");
    if (!input || input.disabled) { if (tries++ < 20) setTimeout(fill, 50); return; }
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  };
  setTimeout(fill, 30);
}
