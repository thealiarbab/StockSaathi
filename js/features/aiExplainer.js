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
// looks subtle (dotted-underline) and pops a tooltip on hover/focus. The
// tooltip fetches /api/ai?op=explain lazily — first hover triggers the API
// call, subsequent hovers on any instance of the same term anywhere on the
// page are instant from the in-memory cache. The backend also caches across
// users in Supabase (table public.ai_response_cache, bucket="explain") so
// the second person to hover "P/E" on the whole site ever gets the cached
// answer for free.
// =============================================================================

const TOOLTIP_ID = "ai-term-tooltip";
const HOVER_DELAY_MS = 250;  // avoid firing on accidental hover pass-through
const memoryCache = new Map();   // term -> explanation
const inflight = new Map();      // term -> Promise

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
  return `<abbr class="ai-term" data-term="${escapeAttr(term)}" tabindex="0" aria-label="Hover for explanation of ${escapeAttr(term)}">${escapeHtml(d)}</abbr>`;
}

async function fetchExplanation(term) {
  if (memoryCache.has(term)) {
    const cached = memoryCache.get(term);
    if (explanationLooksGood(cached)) return cached;
    // In-memory poison — drop it so a fresh fetch can repopulate.
    memoryCache.delete(term);
  }
  if (inflight.has(term)) return inflight.get(term);
  const p = (async () => {
    try {
      const r = await fetch("/api/ai?op=explain&term=" + encodeURIComponent(term), { cache: "default" });
      if (!r.ok) throw new Error("http_" + r.status);
      const j = await r.json();
      const text = j?.explanation || "";
      // Quality gate mirrors the server. Even if the server somehow
      // serves a poisoned cached value (e.g. mid-deploy), we reject
      // it here so the tooltip shows "No explanation available right
      // now." instead of garbage like "A 5".
      if (!explanationLooksGood(text)) {
        memoryCache.delete(term);
        return "";
      }
      memoryCache.set(term, text);
      return text;
    } catch (e) {
      return "";   // silently degrade — no tooltip rather than a broken one
    } finally {
      inflight.delete(term);
    }
  })();
  inflight.set(term, p);
  return p;
}

function positionTooltip(tip, target) {
  const r = target.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Measure first by showing invisible
  tip.style.visibility = "hidden";
  tip.style.display = "block";
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  // Prefer above the term, centred horizontally
  let top = r.top - th - 10;
  let left = r.left + r.width / 2 - tw / 2;
  // Flip below if no room above
  if (top < 8) top = r.bottom + 10;
  // Clamp horizontally
  if (left < 8) left = 8;
  if (left + tw > vw - 8) left = vw - tw - 8;
  // Clamp vertically
  if (top + th > vh - 8) top = vh - th - 8;
  tip.style.top = (top + window.scrollY) + "px";
  tip.style.left = (left + window.scrollX) + "px";
  tip.style.visibility = "visible";
}

async function showFor(target) {
  const term = target.dataset.term;
  if (!term) return;
  const tip = ensureTooltipEl();
  tip.dataset.term = term;
  tip.innerHTML = `<div class="ai-term-tooltip-head">${escapeHtml(term)}</div><div class="ai-term-tooltip-body muted">…</div>`;
  positionTooltip(tip, target);
  const text = await fetchExplanation(term);
  // Guard: cursor may have moved off during the fetch
  if (tip.dataset.term !== term) return;
  if (!text) {
    tip.innerHTML = `<div class="ai-term-tooltip-head">${escapeHtml(term)}</div><div class="ai-term-tooltip-body dim">No explanation available right now.</div>`;
  } else {
    tip.innerHTML = `<div class="ai-term-tooltip-head">${escapeHtml(term)}</div><div class="ai-term-tooltip-body">${escapeHtml(text)}</div>`;
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

function onEnter(e) {
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

function onFocus(e) {
  const t = e.target?.closest?.(".ai-term");
  if (!t) return;
  currentTarget = t;
  showFor(t);
}

function onBlur(e) {
  const t = e.target?.closest?.(".ai-term");
  if (!t) return;
  hide();
}

function onTouchStart(e) {
  const t = e.target?.closest?.(".ai-term");
  if (!t) return;
  e.preventDefault();
  if (currentTarget === t) { hide(); return; }
  currentTarget = t;
  showFor(t);
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
  document.addEventListener("touchstart", onTouchStart, { passive: false });
  document.addEventListener("scroll", hide, { passive: true });
  window.addEventListener("ss:navigate", hide);
}
