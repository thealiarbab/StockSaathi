// =============================================================================
// NAVIGATION — History-API primitives. No imports on purpose: any module
// (including db/sync.js, which the router transitively imports) can move the
// user without creating an import cycle.
//
// Every route change is announced as a window "ss:navigate" event. It replaces
// the old "hashchange" contract one-for-one: the router listens for it to
// render, and pages listen for it (usually { once: true }) to tear down timers
// and subscriptions when the user leaves. Like hashchange it is dispatched as a
// separate task, so a caller that navigates and then keeps running still sees
// the old page's DOM, exactly as before.
// =============================================================================

export const NAV_EVENT = "ss:navigate";

function announce() {
  setTimeout(() => window.dispatchEvent(new Event(NAV_EVENT)), 0);
}

/**
 * Convert a legacy "#/path?q#frag" fragment into a clean URL string.
 * Returns null when the fragment is not a legacy route.
 *
 * Password-reset and signup emails sent before the switch point at
 * "/#/reset-password"; Supabase appends its own "#access_token=…&type=…"
 * fragment after that, so the legacy fragment can carry a second "#" (or a
 * "&" in older GoTrue builds). Everything from the token onwards is kept as the
 * new fragment, which is where supabase-js looks for it.
 */
export function cleanUrlFromLegacyHash(hash) {
  if (!hash || !hash.startsWith("#/")) return null;
  let rest = hash.slice(1);
  let frag = "";
  const tok = rest.search(/[#&](access_token|error|error_description|type|refresh_token)=/);
  if (tok !== -1) {
    frag = "#" + rest.slice(tok + 1);
    rest = rest.slice(0, tok);
  } else {
    const h = rest.indexOf("#");
    if (h !== -1) { frag = rest.slice(h); rest = rest.slice(0, h); }
  }
  const q = rest.indexOf("?");
  const path = (q === -1 ? rest : rest.slice(0, q)) || "/";
  const search = q === -1 ? "" : rest.slice(q);
  return path + search + frag;
}

/**
 * Rewrite a legacy "#/…" URL in place. Returns true if it did.
 * Uses replaceState so the old form never lands in the back stack.
 */
export function upgradeLegacyHash() {
  const clean = cleanUrlFromLegacyHash(location.hash);
  if (clean == null) return false;
  history.replaceState(history.state, "", clean);
  return true;
}

/**
 * Navigate to an in-app path ("/stocks/TCS", "/login?email=x"). A leading
 * "#" (legacy "#/x" callers, LLM-written links) is tolerated.
 *
 * Navigating to the URL you are already on is a no-op, matching the old
 * `location.hash = sameValue` behaviour that some pages rely on.
 */
export function go(path, { replace = false } = {}) {
  let target = String(path || "/");
  if (target.startsWith("#")) target = target.slice(1);
  if (!target.startsWith("/")) target = "/" + target;
  const here = location.pathname + location.search;
  if (target === here) return;
  if (replace) history.replaceState(null, "", target);
  else history.pushState(null, "", target);
  announce();
}

let installed = false;

/**
 * Wire back/forward, legacy-hash upgrades after load (e.g. a "#/stocks/X"
 * link written by the coach), and same-origin link interception.
 *
 * `isAppPath(pathname)` tells us whether the SPA owns a path. Anything it does
 * not own (static files, /api, unknown paths) keeps a normal full navigation,
 * so the server stays the source of truth for 404s and assets.
 */
export function installNavigation(isAppPath) {
  if (installed) return;
  installed = true;

  window.addEventListener("popstate", announce);

  window.addEventListener("hashchange", () => {
    if (upgradeLegacyHash()) announce();
  });

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.("a[href]");
    if (!a) return;
    if (a.hasAttribute("download")) return;
    const tgt = (a.getAttribute("target") || "").toLowerCase();
    if (tgt && tgt !== "_self") return;
    const raw = a.getAttribute("href");
    if (!raw) return;

    let target;
    if (raw.startsWith("#/")) {
      target = cleanUrlFromLegacyHash(raw);
    } else if (raw.startsWith("#")) {
      return;                               // in-page anchor (e.g. skip link)
    } else {
      let url;
      try { url = new URL(a.href, location.href); } catch { return; }
      if (url.origin !== location.origin) return;
      if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
      target = url.pathname + url.search + url.hash;
    }
    if (!target) return;
    const pathname = target.split(/[?#]/)[0];
    if (!isAppPath(pathname)) return;
    e.preventDefault();
    go(target);
  });
}
