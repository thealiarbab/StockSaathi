// =============================================================================
// COMMAND PALETTE — Cmd/Ctrl+K global AI-powered palette.
//
// Opens from anywhere. User types ANY natural-language command:
//   - "what's a P/E"                  -> AI answer inline
//   - "go to portfolio"               -> navigate
//   - "show me cheap IT stocks"       -> fires market-search
//   - "buy 5 TCS"                     -> opens buy flow pre-filled
//
// Keyboard: Cmd/Ctrl+K to open, Esc to close, Enter to submit, arrow keys
// to navigate quick suggestions.
//
// Mounted once from app.js.
// =============================================================================

import { navigate } from "../router.js";

let mounted = false;
let root = null;
let state = {
  open: false,
  loading: false,
  query: "",
  result: null,   // { action, response, target?, query?, symbol?, side?, qty? }
  error: null,
};

const QUICK_ACTIONS = [
  { label: "📊 Go to portfolio", hash: "/portfolio" },
  { label: "📈 Markets", hash: "/stocks" },
  { label: "📰 News", hash: "/news" },
  { label: "⏱ Time travel", hash: "/crash-replay" },
  { label: "📋 Report card", hash: "/report-card" },
  { label: "👥 Friends", hash: "/friends" },
];

function ensureRoot() {
  if (root) return root;
  root = document.createElement("div");
  root.id = "cmdk-root";
  root.className = "cmdk-overlay";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-hidden", "true");
  document.body.appendChild(root);
  root.addEventListener("click", (e) => {
    if (e.target === root) close();
  });
  return root;
}

function render() {
  if (!root) return;
  if (!state.open) {
    root.innerHTML = "";
    root.classList.remove("open");
    root.setAttribute("aria-hidden", "true");
    return;
  }
  root.setAttribute("aria-hidden", "false");
  root.classList.add("open");
  const showQuick = !state.query.trim() && !state.result && !state.loading;
  root.innerHTML = `
    <div class="cmdk-panel" role="dialog">
      <div class="cmdk-inputwrap">
        <span class="cmdk-icon">✨</span>
        <input id="cmdk-input" class="cmdk-input" autocomplete="off" spellcheck="false" placeholder="Ask anything, or type a command…" value="${escapeAttr(state.query)}" />
        ${state.loading ? `<span class="cmdk-spinner" aria-hidden="true"></span>` : ""}
        <kbd class="cmdk-kbd">Esc</kbd>
      </div>
      ${showQuick ? `
        <div class="cmdk-section-label">Quick actions</div>
        <div class="cmdk-quick">
          ${QUICK_ACTIONS.map(q => `<button class="cmdk-quick-item" data-cmdk-hash="${escapeAttr(q.hash)}">${q.label}</button>`).join("")}
        </div>
        <div class="cmdk-section-label">Examples</div>
        <div class="cmdk-examples">
          <span class="cmdk-example">"explain P/E ratio"</span>
          <span class="cmdk-example">"show me cheap IT stocks"</span>
          <span class="cmdk-example">"why is RELIANCE moving"</span>
          <span class="cmdk-example">"buy 5 TCS"</span>
        </div>
      ` : ""}
      ${state.loading && !state.result ? `
        <div class="cmdk-loading">Saathi is thinking…</div>
      ` : ""}
      ${state.result ? renderResult(state.result) : ""}
      ${state.error ? `<div class="cmdk-error">${escapeHtml(state.error)}</div>` : ""}
    </div>
  `;
  const input = root.querySelector("#cmdk-input");
  input?.focus();
  input?.addEventListener("input", (e) => { state.query = e.target.value; state.error = null; });
  input?.addEventListener("keydown", onInputKeydown);
  root.querySelectorAll("[data-cmdk-hash]").forEach(el => {
    el.addEventListener("click", () => { navigate(el.dataset.cmdkHash.replace(/^#/, "")); close(); });
  });
  root.querySelector("[data-cmdk-action='navigate']")?.addEventListener("click", () => {
    navigate(state.result.target.replace(/^#/, ""));
    close();
  });
  root.querySelector("[data-cmdk-action='open-search']")?.addEventListener("click", () => {
    // Go to stocks page with the search query pre-filled via hash param
    navigate("/stocks");
    setTimeout(() => {
      const s = document.querySelector("#stocks-search");
      if (s) {
        s.value = state.result.query || "";
        s.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("#ask-saathi-btn")?.click();
      }
    }, 120);
    close();
  });
  root.querySelector("[data-cmdk-action='open-trade']")?.addEventListener("click", () => {
    if (state.result.symbol) {
      navigate(`/stocks/${state.result.symbol}`);
    }
    close();
  });
}

function renderResult(r) {
  if (r.action === "answer") {
    return `<div class="cmdk-answer">${escapeHtml(r.response || "")}</div>`;
  }
  if (r.action === "navigate") {
    return `
      <div class="cmdk-answer">${escapeHtml(r.response || "Opening…")}</div>
      <button class="cmdk-cta" data-cmdk-action="navigate">Go to <code>${escapeHtml(r.target || "")}</code> →</button>
    `;
  }
  if (r.action === "search") {
    return `
      <div class="cmdk-answer">${escapeHtml(r.response || "Running the filter…")}</div>
      <button class="cmdk-cta" data-cmdk-action="open-search">Open results for "${escapeHtml(r.query || "")}" →</button>
    `;
  }
  if (r.action === "trade") {
    return `
      <div class="cmdk-answer">${escapeHtml(r.response || "")}</div>
      <button class="cmdk-cta" data-cmdk-action="open-trade">${escapeHtml(r.side || "BUY")} ${r.qty || 1} × ${escapeHtml(r.symbol || "")} →</button>
    `;
  }
  return `<div class="cmdk-answer">${escapeHtml(r.response || "OK.")}</div>`;
}

function onInputKeydown(e) {
  if (e.key === "Escape") { e.preventDefault(); close(); return; }
  if (e.key === "Enter") {
    e.preventDefault();
    submit();
  }
}

async function submit() {
  const q = state.query.trim();
  if (!q || state.loading) return;
  state.loading = true;
  state.result = null;
  state.error = null;
  render();
  try {
    const res = await fetch("/api/ai?op=command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, context: location.pathname.startsWith("/a/") ? "/a" : (location.pathname || "/") }),
    });
    if (!res.ok) throw new Error("http_" + res.status);
    const data = await res.json();
    state.result = sanitizeResult(data);
    // Auto-perform navigation for obvious nav intents (shave a click)
    if (state.result?.action === "navigate" && state.result.target) {
      setTimeout(() => {
        navigate(state.result.target.replace(/^#/, ""));
        close();
      }, 350);
    }
  } catch (e) {
    state.error = "Couldn't reach Saathi. Try again in a moment.";
  } finally {
    state.loading = false;
    render();
  }
}

function sanitizeResult(d) {
  if (!d || typeof d !== "object") return null;
  const a = d.action;
  if (a === "navigate" && typeof d.target === "string") return { action: "navigate", target: d.target, response: d.response || "" };
  if (a === "answer")    return { action: "answer", response: String(d.response || "").slice(0, 2000) };
  if (a === "search")    return { action: "search", query: String(d.query || state.query), response: d.response || "" };
  if (a === "trade")     return {
    action: "trade",
    side: d.side === "SELL" ? "SELL" : "BUY",
    symbol: String(d.symbol || "").toUpperCase().slice(0, 24),
    qty: Math.max(1, Math.floor(Number(d.qty) || 1)),
    response: d.response || "",
  };
  return { action: "answer", response: "Got it, but not sure what action to take. Try phrasing differently." };
}

export function openCommandPalette(prefill = "") {
  ensureRoot();
  state.open = true;
  state.query = prefill || "";
  state.result = null;
  state.error = null;
  state.loading = false;
  render();
}
function close() {
  state.open = false;
  state.query = "";
  state.result = null;
  render();
}

export function mountCommandPalette() {
  if (mounted) return;
  mounted = true;
  ensureRoot();
  document.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    const modK = (e.ctrlKey || e.metaKey) && key === "k";
    if (modK) {
      e.preventDefault();
      state.open ? close() : openCommandPalette();
    }
  });
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
