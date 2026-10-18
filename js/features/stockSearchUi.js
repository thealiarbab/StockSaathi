// =============================================================================
// Markets search box: the dropdown under the input.
//
//   empty box   -> recent searches + example searches to tap
//   typing      -> "did you mean", how the words were understood, the top
//                  matches across stocks, ETFs and funds with price and day
//                  change, "show all", and "Ask Saathi" for real questions
//
// Arrow keys move, Enter picks (or opens the stock when the match is certain),
// Esc closes. The grid below the box is filtered by stocks.js as before; this
// file only owns the dropdown.
// =============================================================================

import { search, recentSearches, rememberSearch, forgetSearches, snapOf } from "./stockSearch.js";

const TRY = [
  "under ₹100", "top gainers today", "best performing", "bank stocks",
  "high dividend", "debt free", "stocks like TCS", "IT stocks under ₹500", "gold ETF",
];

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function inr(n) {
  if (!(n > 0)) return "";
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: n >= 1000 ? 0 : 2, minimumFractionDigits: n >= 1000 ? 0 : 2 });
}
const KIND_TAG = { ETF: "ETF", MF: "Fund" };

/**
 * mountSearchSuggest(input, {
 *   universe(): instrument[]        full list (stable array)
 *   keep(it): bool                  instruments allowed anywhere (hides wound-up funds)
 *   priceOf(sym), changeOf(sym)     live values when on screen
 *   onPick(inst, query)             a match was chosen
 *   onSubmit(query, result)         Enter with nothing highlighted
 *   onAsk(query)                    "Ask Saathi" row
 *   onQuery(query)                  a recent/example/did-you-mean was tapped: set the box to it
 *   listCount(query), listName()    how many the list below would show, and its tab name
 * })
 */
export function mountSearchSuggest(input, opts) {
  const wrap = input.parentElement;
  wrap.classList.add("ss-suggest-wrap");
  const panel = document.createElement("div");
  panel.className = "ss-suggest";
  panel.id = "ss-suggest";
  panel.setAttribute("role", "listbox");
  panel.hidden = true;
  wrap.appendChild(panel);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", "ss-suggest");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");

  let items = [];        // [{ el, run }]
  let active = -1;
  let last = null;       // last search result
  let raf = 0;

  const show = () => { panel.hidden = false; input.setAttribute("aria-expanded", "true"); };
  const hide = () => { panel.hidden = true; input.setAttribute("aria-expanded", "false"); setActive(-1); };

  function setActive(i) {
    if (items[active]) items[active].el.classList.remove("on");
    active = i;
    if (items[active]) {
      items[active].el.classList.add("on");
      items[active].el.scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", items[active].el.id);
    } else input.removeAttribute("aria-activedescendant");
  }

  function build() {
    raf = 0;
    const q = input.value.trim();
    const html = [];
    const runs = [];
    const row = (cls, inner, run, extra = "") => {
      const i = runs.length;
      runs.push(run);
      html.push(`<div class="ss-row ${cls}" id="ss-opt-${i}" role="option" data-i="${i}" ${extra}>${inner}</div>`);
    };

    if (!q) {
      const rec = recentSearches();
      if (rec.length) {
        html.push(`<div class="ss-head"><span>Recent</span><button type="button" class="ss-link" data-clear="1">Clear</button></div>`);
        for (const r of rec) row("ss-recent", `<span class="ss-ico" aria-hidden="true">↺</span><span class="ss-text">${esc(r)}</span>`, () => opts.onQuery(r));
      }
      html.push(`<div class="ss-head"><span>Try</span></div><div class="ss-try">`);
      for (const t of TRY) {
        const i = runs.length;
        runs.push(() => opts.onQuery(t));
        html.push(`<button type="button" class="ss-chip" id="ss-opt-${i}" role="option" data-i="${i}">${esc(t)}</button>`);
      }
      html.push(`</div>`);
    } else {
      const r = search(q, opts.universe(), { filter: opts.keep, priceOf: opts.priceOf, changeOf: opts.changeOf });
      last = r;
      if (r.didYouMean) row("ss-dym", `Did you mean <b>${esc(r.didYouMean)}</b>?`, () => opts.onQuery(r.didYouMean));
      const shown = r.chips.filter(c => c.id !== "floor");
      if (shown.length) {
        html.push(`<div class="ss-understood">${shown.map(c => `<span class="ss-pill">${esc(c.label)}</span>`).join("")}${r.sortLabel && !shown.some(c => c.label === r.sortLabel) ? `<span class="ss-sort">${esc(r.sortLabel)}</span>` : ""}</div>`);
      }
      // Funds: at most two, so 20 plan variants of one fund don't fill the list.
      const top = [];
      let funds = 0;
      for (const it of r.results) {
        if (it.kind === "MF") { if (funds >= 2) continue; funds++; }
        top.push(it);
        if (top.length >= 7) break;
      }
      for (const it of top) {
        const s = snapOf(it.symbol);
        const p = opts.priceOf?.(it.symbol) ?? s?.p ?? (it.kind === "MF" ? it.nav : null);
        const d = opts.changeOf?.(it.symbol) ?? s?.d;
        const name = it.kind === "MF" ? String(it.name || "").replace(/ - (Direct|Regular) Plan.*$/i, "") : it.name;
        row("ss-hit",
          `<span class="ss-sym">${esc(it.kind === "MF" ? "Fund" : it.symbol)}</span>
           <span class="ss-name">${esc(name || it.symbol)}${KIND_TAG[it.kind] && it.kind !== "MF" ? ` <span class="ss-tag">${KIND_TAG[it.kind]}</span>` : ""}</span>
           <span class="ss-px tabular">${esc(inr(p))}</span>
           <span class="ss-ch tabular ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d != null && Number.isFinite(d) ? `${d > 0 ? "+" : ""}${d.toFixed(2)}%` : ""}</span>`,
          () => opts.onPick(it, q));
      }
      if (!top.length) {
        html.push(`<div class="ss-empty">No stock, ETF or fund matches “${esc(q)}”.</div>`);
      } else {
        // The list below the box only shows the open tab, so count that.
        const inList = opts.listCount ? opts.listCount(q) : r.results.length;
        if (inList > 0) row("ss-all", `Show all ${inList.toLocaleString("en-IN")} in ${esc(opts.listName ? opts.listName() : "results")} <kbd>Enter</kbd>`, () => opts.onSubmit(q, r, true));
      }
      if (q.split(/\s+/).length >= 2) {
        row("ss-ask", `<span aria-hidden="true">✨</span> Ask Saathi: “${esc(q)}”`, () => opts.onAsk(q));
      }
    }
    panel.innerHTML = html.join("");
    items = runs.map((run, i) => ({ el: panel.querySelector(`#ss-opt-${i}`), run }));
    active = -1;
    if (document.activeElement === input) show();
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(build); };

  input.addEventListener("input", schedule);
  input.addEventListener("focus", schedule);
  input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) hide(); }, 150));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (panel.hidden) { schedule(); return; }
      e.preventDefault();
      const n = items.length;
      if (!n) return;
      setActive(e.key === "ArrowDown" ? (active + 1) % n : (active <= 0 ? n - 1 : active - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const q = input.value.trim();
      if (active >= 0 && items[active]) { items[active].run(); return; }
      if (!q) return;
      rememberSearch(q);
      const r = last && input.value.trim() === q ? last : search(q, opts.universe(), { filter: opts.keep, priceOf: opts.priceOf, changeOf: opts.changeOf });
      hide();
      opts.onSubmit(q, r, false);
    } else if (e.key === "Escape") {
      if (!panel.hidden) { e.preventDefault(); hide(); }
    }
  });
  // Keep focus in the box while tapping the dropdown.
  panel.addEventListener("mousedown", (e) => e.preventDefault());
  panel.addEventListener("click", (e) => {
    if (e.target.closest("[data-clear]")) { forgetSearches(); build(); return; }
    const el = e.target.closest("[data-i]");
    if (!el) return;
    const it = items[+el.dataset.i];
    if (!it) return;
    const q = input.value.trim();
    if (q) rememberSearch(q);
    it.run();
  });
  panel.addEventListener("mousemove", (e) => {
    const el = e.target.closest("[data-i]");
    if (el && +el.dataset.i !== active) setActive(+el.dataset.i);
  });

  return { hide, refresh: schedule };
}
