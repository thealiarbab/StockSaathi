// =============================================================================
// AI EXPLAINER — Hover-to-explain any finance term, anywhere on the site.
//
// Usage:
//   import { termHtml, mountAiExplainer } from "../features/aiExplainer.js";
//
//   // In any page template:
//   `What's your ${termHtml("P/E")} telling you?`
//
//   // Once, at app boot:
//   mountAiExplainer();
//
// The wrapper returns an <abbr class="ai-term" data-term="..."> element that
// looks subtle (dotted-underline). Mouse hover shows a small preview; a tap,
// click or Enter opens a centred card over a dimmed page. Terms listed in
// js/data/glossary.js use that fixed text. Anything else falls back to
// /api/ai?op=explain lazily — first hover triggers the API
// call, subsequent hovers on any instance of the same term anywhere on the
// page are instant from the in-memory cache. The backend also caches across
// users in Supabase (table public.ai_response_cache, bucket="explain") so
// the second person to hover "P/E" on the whole site ever gets the cached
// answer for free.
// =============================================================================

import { aiLang } from "./aiLang.js";
import { glossaryLookup } from "../data/glossary.js";

const TOOLTIP_ID = "ai-term-tooltip";
const HOVER_DELAY_MS = 250;  // avoid firing on accidental hover pass-through
// Keyed by term AND language (C11): switching Hinglish on used to keep
// serving the English tooltip already in memory, and the other way round.
const memoryCache = new Map();   // `${lang}|${term}` -> explanation
const inflight = new Map();      // `${lang}|${term}` -> Promise

let hoverTimer = null;
let currentTarget = null;

function ensureTooltipEl() {
  let el = document.getElementById(TOOLTIP_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = TOOLTIP_ID;
  el.className = "ai-term-tooltip";
  el.setAttribute("role", "tooltip");
  el.style.display = "none";
  // Inline width forcing — belt-and-suspenders so even a stale CSS cache
  // can never collapse the tooltip to a single-token width like "A 5".
  // The CSS file's min-width: 240px is the primary defence; this is the
  // backup that survives even if components.css fails to load.
  el.style.minWidth = "260px";
  el.style.maxWidth = "360px";
  el.style.width = "max-content";
  el.style.whiteSpace = "normal";
  el.style.overflowWrap = "break-word";
  el.style.wordBreak = "normal";
  document.body.appendChild(el);
  return el;
}

// Mirrors the server's gate in api/ai.js opExplain(). If the backend ever
// regresses or serves a cached short value, the frontend rejects it too
// so the user sees "No explanation available" instead of garbage like
// "A 5" or "Beta measures how much a". Kept in sync with the server
// definition deliberately — both must agree or one will let bad values
// through.
//
// MUST stay in sync with app/api/ai.js explanationLooksGood + STUB_WORDS.
// If you change one, change the other.
const STUB_WORDS = new Set([
  "a","an","the",
  "it","this","that","these","those",
  "is","are","was","were","be","been","being",
  "have","has","had","having",
  "do","does","did","doing","done",
  "will","would","should","could","can","may","might","must","shall",
  "and","or","but","nor","so","yet",
]);

function explanationLooksGood(text) {
  if (!text) return false;
  const trimmed = String(text).trim();
  if (trimmed.length < 15) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  if (!/\s/.test(trimmed)) return false;
  // Mid-sentence-truncation signals:
  //   (a) raw text ends with ",", "-", ":" (LLM stalled mid-clause)
  //   (b) raw text ends with "..." or "…" (ellipsis = thinking token out)
  //   (c) last alpha-run is a stub word (article/pronoun/auxiliary/conj)
  if (/[,\-:]\s*$/.test(trimmed)) return false;
  if (/\.{2,}\s*$/.test(trimmed) || /…\s*$/.test(trimmed)) return false;
  const m = trimmed.toLowerCase().match(/([a-z]+)[^a-z]*$/);
  if (m && STUB_WORDS.has(m[1])) return false;
  return true;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}

function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Public: wrap a term in the AI-explain pill. Returns HTML string.
// `display` is what the user sees; `term` is what goes to the API (defaults
// to display). Example:
//   termHtml("P/E")                       -> "<abbr …>P/E</abbr>"
//   termHtml("drawdown", "drawdowns")     -> "<abbr …>drawdowns</abbr>"
export function termHtml(term, display) {
  const d = display ?? term;
  return `<abbr class="ai-term" data-term="${escapeAttr(term)}" tabindex="0" role="button" aria-haspopup="dialog" aria-label="What is ${escapeAttr(term)}?">${escapeHtml(d)}</abbr>`;
}

// Language of term explanations: the card's own English/Hinglish button
// (remembered on this device) wins; until it is used, the Settings switch.
const TERM_LANG_KEY = "ss.term.lang";
function termLang() {
  try { const v = localStorage.getItem(TERM_LANG_KEY); if (v === "hi" || v === "en") return v; } catch {}
  return aiLang() ? "hi" : "en";
}

async function fetchExplanation(term, which = termLang()) {
  const lang = which === "hi" ? "&lang=hi" : "";
  // Fixed definitions first (js/data/glossary.js): instant, no network, and
  // right for the page. The model is only asked about terms not listed there.
  const fixed = glossaryLookup(term, which);
  if (fixed) return fixed;
  const key = `${lang}|${term}`;
  if (memoryCache.has(key)) {
    const cached = memoryCache.get(key);
    if (explanationLooksGood(cached)) return cached;
    // In-memory poison — drop it so a fresh fetch can repopulate.
    memoryCache.delete(key);
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const r = await fetch("/api/ai?op=explain&term=" + encodeURIComponent(term) + lang, { cache: "default" });
      if (!r.ok) throw new Error("http_" + r.status);
      const j = await r.json();
      const text = j?.explanation || "";
      // Quality gate mirrors the server. Even if the server somehow
      // serves a poisoned cached value (e.g. mid-deploy), we reject
      // it here so the tooltip shows "No explanation available right
      // now." instead of garbage like "A 5".
      if (!explanationLooksGood(text)) {
        memoryCache.delete(key);
        return "";
      }
      memoryCache.set(key, text);
      return text;
    } catch (e) {
      return "";   // silently degrade — no tooltip rather than a broken one
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// Hover preview (mouse only). position:fixed, so it lives in the viewport
// and can never add height or width to the page. The old one was absolute
// at scrollY + top and, near the bottom of a stock page, stretched the
// document so the page scrolled while it was up.
function positionTooltip(tip, target) {
  const r = target.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  tip.style.visibility = "hidden";
  tip.style.display = "block";
  const tw = Math.min(tip.offsetWidth, vw - 16);
  const th = tip.offsetHeight;
  let top = r.top - th - 10;
  let left = r.left + r.width / 2 - tw / 2;
  if (top < 8) top = r.bottom + 10;
  if (left < 8) left = 8;
  if (left + tw > vw - 8) left = vw - tw - 8;
  if (top + th > vh - 8) top = Math.max(8, vh - th - 8);
  tip.style.top = top + "px";
  tip.style.left = left + "px";
  tip.style.visibility = "visible";
}

function bodyHtml(text) {
  if (text === null) return `<div class="term-pop-skel"><span></span><span></span><span></span></div>`;
  if (!text) return `<p class="term-pop-text dim">No explanation available right now. Try again in a minute.</p>`;
  return `<p class="term-pop-text">${escapeHtml(text)}</p>`;
}

async function showFor(target) {
  const term = target.dataset.term;
  if (!term) return;
  const tip = ensureTooltipEl();
  tip.dataset.term = term;
  tip.innerHTML = `<div class="ai-term-tooltip-head">${escapeHtml(term)}</div><div class="ai-term-tooltip-body muted">…</div>`;
  positionTooltip(tip, target);
  const text = await fetchExplanation(term);
  if (tip.dataset.term !== term) return;
  if (!text) {
    tip.innerHTML = `<div class="ai-term-tooltip-head">${escapeHtml(term)}</div><div class="ai-term-tooltip-body dim">No explanation available right now.</div>`;
  } else {
    tip.innerHTML = `<div class="ai-term-tooltip-head">${escapeHtml(term)}</div><div class="ai-term-tooltip-body">${escapeHtml(text)}</div><div class="ai-term-tooltip-hint">Click to keep it open</div>`;
  }
  positionTooltip(tip, target);
}

function hide() {
  const tip = document.getElementById(TOOLTIP_ID);
  if (tip) {
    tip.style.display = "none";
    delete tip.dataset.term;
  }
  currentTarget = null;
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
}

// ---- Tap / click: centred card over a dimmed page ------------------------
let popEl = null;
let popReturnFocus = null;

function closePop() {
  const el = popEl;
  if (!el) return;
  popEl = null;
  document.documentElement.classList.remove("term-pop-open");
  document.documentElement.style.removeProperty("--term-pop-gutter");
  document.removeEventListener("keydown", onPopKey, true);
  const done = () => el.remove();
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) done();
  else {
    el.classList.add("leaving");
    el.addEventListener("animationend", done, { once: true });
    setTimeout(done, 300);
  }
  try { popReturnFocus?.focus?.({ preventScroll: true }); } catch {}
  popReturnFocus = null;
}

function onPopKey(e) {
  if (!popEl) return;
  if (e.key === "Escape") { e.preventDefault(); closePop(); return; }
  if (e.key === "Tab") {
    // Two buttons; keep focus inside the card.
    const f = [...popEl.querySelectorAll("button")];
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    e.preventDefault();
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  }
}

async function openPop(target) {
  const term = target.dataset.term;
  if (!term) return;
  hide();
  if (popEl) popEl.remove();
  popReturnFocus = target;
  let lang = termLang();
  const langBtn = () => lang === "hi"
    ? `<button type="button" class="term-pop-lang" lang="en" aria-label="Show in English">English</button>`
    : `<button type="button" class="term-pop-lang" aria-label="Show in Hinglish">Hinglish</button>`;
  const el = document.createElement("div");
  el.className = "term-pop-overlay";
  el.innerHTML = `
    <div class="term-pop" role="dialog" aria-modal="true" aria-labelledby="term-pop-title">
      <div class="term-pop-head">
        <h2 class="term-pop-title" id="term-pop-title"><span class="term-pop-term">${escapeHtml(term)}</span></h2>
        ${langBtn()}
        <button type="button" class="term-pop-x" aria-label="Close">✕</button>
      </div>
      <div class="term-pop-body" aria-live="polite">${bodyHtml(null)}</div>
      <button type="button" class="btn btn-primary term-pop-ok">Got it</button>
    </div>`;
  el.addEventListener("click", async (e) => {
    if (e.target === el || e.target.closest(".term-pop-x, .term-pop-ok")) { closePop(); return; }
    const b = e.target.closest(".term-pop-lang");
    if (!b) return;
    lang = lang === "hi" ? "en" : "hi";
    try { localStorage.setItem(TERM_LANG_KEY, lang); } catch {}
    b.outerHTML = langBtn();
    el.querySelector(".term-pop-lang").focus({ preventScroll: true });
    const body = el.querySelector(".term-pop-body");
    body.innerHTML = bodyHtml(null);
    const want = lang;
    const t = await fetchExplanation(term, want);
    if (popEl === el && lang === want) body.innerHTML = bodyHtml(t);
  });
  // No scrolling the page underneath; keep the layout from shifting when a
  // desktop scrollbar disappears.
  const gutter = window.innerWidth - document.documentElement.clientWidth;
  if (gutter > 0) document.documentElement.style.setProperty("--term-pop-gutter", gutter + "px");
  document.documentElement.classList.add("term-pop-open");
  document.body.appendChild(el);
  popEl = el;
  document.addEventListener("keydown", onPopKey, true);
  el.querySelector(".term-pop-ok").focus({ preventScroll: true });
  const first = lang;
  const text = await fetchExplanation(term, first);
  if (popEl !== el || lang !== first) return;
  el.querySelector(".term-pop-body").innerHTML = bodyHtml(text);
}

const canHover = () => !!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;

function onEnter(e) {
  if (!canHover() || popEl) return;
  const t = e.target?.closest?.(".ai-term");
  if (!t) return;
  currentTarget = t;
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (currentTarget === t) showFor(t);
  }, HOVER_DELAY_MS);
}

function onLeave(e) {
  const t = e.target?.closest?.(".ai-term");
  if (!t) return;
  hide();
}

// Keyboard focus shows the small preview; Enter/Space opens the card.
function onFocus(e) {
  const t = e.target?.closest?.(".ai-term");
  if (!t || popEl) return;
  let kb = false;
  try { kb = t.matches(":focus-visible"); } catch {}
  if (!kb) return;
  currentTarget = t;
  showFor(t);
}

function onBlur(e) {
  const t = e.target?.closest?.(".ai-term");
  if (!t) return;
  hide();
}

function onClick(e) {
  const t = e.target?.closest?.(".ai-term");
  if (!t) return;
  e.preventDefault();
  e.stopPropagation();
  openPop(t);
}

function onKey(e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  const t = e.target?.closest?.(".ai-term");
  if (!t) return;
  e.preventDefault();
  openPop(t);
}

let mounted = false;
export function mountAiExplainer() {
  if (mounted) return;
  mounted = true;
  // Use capture phase + delegation — works regardless of when terms are
  // inserted/removed from the DOM via innerHTML replacements.
  document.addEventListener("mouseover", onEnter, true);
  document.addEventListener("mouseout", onLeave, true);
  document.addEventListener("focusin", onFocus, true);
  document.addEventListener("focusout", onBlur, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("scroll", hide, { passive: true, capture: true });
  window.addEventListener("ss:navigate", () => { hide(); closePop(); });
  window.addEventListener("popstate", closePop);
}
