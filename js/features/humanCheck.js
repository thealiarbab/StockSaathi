// =============================================================================
// HUMAN CHECK — Cloudflare Turnstile, only during an AI lockdown.
//
// When the abuse watcher sees an attack on the paid AI endpoints it switches
// on a 30-minute lockdown (api/_guard.js): no new model calls. Real people
// caught in it get a 503 { challenge: true }. This module notices that
// answer, runs Turnstile (invisible for almost everyone; a one-click box only
// when Cloudflare is unsure), exchanges the token for a one-hour "human pass"
// cookie, and repeats the request once. On a normal day it does nothing: the
// Turnstile script is not even loaded.
// =============================================================================

const SITE_KEY = "0x4AAAAAAFuJdkw9VLh4szkP";
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const LLM_OPS = /^(explain|news-tldr|portfolio-digest|stock-why|trade-nudge|market-mood|market-search|report-card|crash-suggestions|command)$/;
const GIVE_UP_MS = 5 * 60_000;   // after a failed or closed check, do not ask again for 5 min

let _installed = false;
let _pending = null;
let _gaveUpAt = 0;

function isAiCall(url) {
  try {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin) return false;
    if (u.pathname === "/api/chat") return true;
    return u.pathname === "/api/ai" && LLM_OPS.test(u.searchParams.get("op") || "");
  } catch { return false; }
}

function loadScript() {
  if (window.turnstile) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT; s.async = true;
    s.onload = () => resolve(); s.onerror = () => reject(new Error("turnstile_load"));
    document.head.appendChild(s);
  });
}

// One check at a time; every waiting request shares it.
function runCheck() {
  if (_pending) return _pending;
  if (Date.now() - _gaveUpAt < GIVE_UP_MS) return Promise.resolve(false);
  _pending = (async () => {
    let overlay = null;
    try {
      await loadScript();
      overlay = document.createElement("div");
      overlay.className = "hc-overlay";
      overlay.hidden = true;   // shown only if Cloudflare wants a click
      overlay.innerHTML = `
        <div class="hc-card" role="dialog" aria-modal="true" aria-labelledby="hc-title">
          <h2 id="hc-title">Quick check</h2>
          <p>Saathi is getting a lot of automated traffic right now. Tick the box to keep using it.</p>
          <div class="hc-widget"></div>
          <button type="button" class="btn btn-ghost hc-close">Not now</button>
        </div>`;
      document.body.appendChild(overlay);
      const token = await new Promise((resolve) => {
        overlay.querySelector(".hc-close").addEventListener("click", () => resolve(null));
        window.turnstile.render(overlay.querySelector(".hc-widget"), {
          sitekey: SITE_KEY,
          appearance: "interaction-only",
          "before-interactive-callback": () => { overlay.hidden = false; },
          callback: (t) => resolve(t),
          "error-callback": () => resolve(null),
          "expired-callback": () => resolve(null),
        });
      });
      if (!token) return false;
      const r = await fetch("/api/ai?op=human-check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }), credentials: "same-origin",
      });
      return r.ok;
    } catch {
      return false;
    } finally {
      overlay?.remove();
    }
  })().then((ok) => { if (!ok) _gaveUpAt = Date.now(); _pending = null; return ok; });
  return _pending;
}

/** Wrap window.fetch once. Only AI calls answered with 503 + challenge are touched. */
export function installHumanCheck() {
  if (_installed || typeof window === "undefined" || !window.fetch) return;
  _installed = true;
  const inner = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const res = await inner(input, init);
    if (res.status !== 503 || !url || !isAiCall(url)) return res;
    // A body we cannot send twice (stream) cannot be retried.
    if (init?.body && typeof init.body !== "string") return res;
    let busy = null;
    try { busy = await res.clone().json(); } catch {}
    if (!busy?.challenge) return res;
    if (!(await runCheck())) return res;
    return inner(input, init);
  };
}
