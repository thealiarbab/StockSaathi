// =============================================================================
// ROUTER — Hash-based. Auth-aware. Clean auth/onboarding/protected split.
// =============================================================================

import { renderLanding } from "./pages/landing.js";
import { track, installTracking } from "./features/track.js";
import { renderPortfolio } from "./pages/portfolio.js";
import { renderStocks } from "./pages/stocks.js";
import { renderStockDetail } from "./pages/stockDetail.js";
import { renderCrashReplay } from "./pages/crashReplay.js";
// Leaderboard fully removed Apr 24 2026 — no route, no nav, no helper.
// /leaderboard URLs now fall through to the router's 404 handler, which
// shows a "Page not found" with a link home.
import { renderReportCard } from "./pages/reportCard.js";
import { renderOnboarding } from "./pages/onboarding.js";
import { renderSettings } from "./pages/settings.js";
import { renderLogin } from "./pages/login.js";
import { renderRegister } from "./pages/register.js";
import { renderResetPasswordRequest } from "./pages/resetPasswordRequest.js";
import { renderResetPassword } from "./pages/resetPassword.js";
import { renderFriends } from "./pages/friends.js";
import { renderNews } from "./pages/news.js";
import { renderChat } from "./pages/chat.js";
import { renderAdmin } from "./pages/admin.js";
import { renderPrivacy } from "./pages/privacy.js";
import { renderTerms } from "./pages/terms.js";
import { renderGrievance } from "./pages/grievance.js";
import { currentUser, refreshCurrentUser } from "./auth/accounts.js";
import { getState, subscribe } from "./state.js";

const ROUTES = [
  { name: "home",          match: /^$|^\/$/,                              render: renderLanding, public: true },
  { name: "login",         match: /^\/login\/?$/,                          render: renderLogin, public: true },
  { name: "register",      match: /^\/register\/?$/,                       render: renderRegister, public: true },
  { name: "reset-req",     match: /^\/reset-password-request\/?$/,         render: renderResetPasswordRequest, public: true },
  { name: "reset-password", match: /^\/reset-password\/?$/,                render: renderResetPassword, public: true },
  { name: "onboarding",    match: /^\/onboarding\/?$/,                     render: renderOnboarding, needsAuth: true },
  { name: "portfolio",     match: /^\/portfolio\/?$/,                      render: renderPortfolio, needsAuth: true, needsOnboarded: true },
  // Alias: #/orders is not a real page, but some users have bookmarks
  // or PWA shortcuts pointing here (from a mental-model of "orders
  // should be their own page"). Redirect to the portfolio page's
  // pending-orders card rather than 404 them. Using location.replace
  // (not assign) so the bad URL doesn't pollute history.
  { name: "orders-redirect", match: /^\/orders\/?$/,                        render: () => { location.replace("#/portfolio"); setTimeout(() => { document.querySelector("#order-list")?.scrollIntoView({ behavior: "smooth" }); }, 300); }, public: true },
  // Hotfix60a: /stocks + /stocks/<sym> are PUBLIC. The markets browser
  // is read-only for anonymous users — no holdings, no watchlist saves,
  // just live prices and the universe. Previously these were auth-gated
  // with needsAuth+needsOnboarded, which meant any cold load with a
  // stale ss.sb.session.v1 token (logged-out browser, leftover key from
  // a prior session, expired JWT, etc.) showed "Getting your portfolio
  // ready..." for up to 3 s before redirecting to /login. Awful first
  // impression for a discovery page. The page itself handles missing
  // user state cleanly: holdings/watchlist show their empty states,
  // and buy/sell buttons on /stocks/<sym> already prompt login when
  // an unauth'd user attempts a trade. So nothing else needs to change
  // — just opening the gate.
  { name: "stocks",        match: /^\/stocks\/?$/,                         render: renderStocks, public: true },
  { name: "stock-detail",  match: /^\/stocks\/([A-Za-z0-9&\-_.]+)\/?$/,    render: renderStockDetail, param: "symbol", public: true },
  { name: "crash-replay",  match: /^\/crash-replay\/?$/,                   render: renderCrashReplay, public: true },
  { name: "crash-replay-scenario", match: /^\/crash-replay\/([A-Za-z0-9_]+)\/?$/, render: renderCrashReplay, param: "scenario", public: true },
  { name: "report-card",   match: /^\/report-card\/?$/,                    render: renderReportCard, needsAuth: true, needsOnboarded: true },
  { name: "friends",       match: /^\/friends\/?$/,                        render: renderFriends, needsAuth: true, needsOnboarded: true },
  { name: "news",          match: /^\/news\/?$/,                           render: renderNews, public: true },
  { name: "chat",          match: /^\/chat\/?$/,                           render: renderChat, public: true },
  { name: "settings",      match: /^\/settings\/?$/,                       render: renderSettings, needsAuth: true },
  { name: "privacy",       match: /^\/privacy\/?$/,                        render: renderPrivacy, public: true },
  { name: "terms",         match: /^\/terms\/?$/,                          render: renderTerms, public: true },
  { name: "grievance",     match: /^\/grievance\/?$/,                      render: renderGrievance, public: true },
  // Admin path is NOT /admin — that 404s. Real path is /a/<slug> where
  // <slug> must match ADMIN_PATH env var on the server. The server returns
  // the same 404 shape for wrong slugs, so scanning the URL space gets you
  // nothing. renderAdmin itself calls /api/ai?op=admin-path-check and
  // short-circuits to 404 if the slug isn't valid.
  { name: "admin-slug",    match: /^\/a\/([A-Za-z0-9_-]{1,16384})\/?$/,    render: renderAdmin, param: "slug", public: true },
];

export function currentRoute() {
  const hash = location.hash.slice(1) || "/";
  const pathOnly = hash.split("?")[0];
  for (const r of ROUTES) {
    const m = pathOnly.match(r.match);
    if (m) {
      const p = {};
      if (r.param) p[r.param] = decodeURIComponent(m[1]);
      return { ...r, params: p };
    }
  }
  return { name: "404", params: {}, render: render404, public: true };
}

function render404(main) {
  main.innerHTML = `
    <div class="empty-state">
      <span class="emoji">🔍</span>
      <h3>Page not found</h3>
      <p>The route you tried doesn't exist.</p>
      <a href="#/" class="btn btn-primary">Back home</a>
    </div>
  `;
}

// Loading shell shown while we wait for refreshCurrentUser to resolve. Plain
// spinner with copy that's appropriate for the current route.
//
// Hotfix60a: per-route copy. Old copy ("Getting your portfolio ready…")
// was wrong on every page that wasn't /portfolio — onboarding, settings,
// report-card, friends — and the "Stuck? Log in manually" link was
// shown even when we were merely waiting for an existing session to
// rehydrate (i.e. the user IS logged in, the link just makes them
// re-enter credentials needlessly). Caller passes the route name so we
// can pick a tighter line, and the bottom link is omitted unless the
// session is actually missing.
function showLoadingShell(routeName) {
  const main = document.getElementById("main");
  if (!main) return;
  // Per-route loading line. Keep them short — this is a flash, not copy.
  const COPY = {
    portfolio:    "Loading your portfolio…",
    "report-card": "Loading your report card…",
    friends:      "Loading your friends…",
    onboarding:   "Setting up onboarding…",
    settings:     "Loading settings…",
  };
  const line = COPY[routeName] || "One moment…";
  // Only surface the manual-login escape hatch when we have NO persisted
  // session at all (i.e. the user truly needs to log in to proceed).
  // When a session token IS present we're just waiting for refresh —
  // showing "Log in manually" there is misleading because the user is
  // already logged in.
  const hasSession = (() => {
    try { return !!localStorage.getItem("ss.sb.session.v1"); } catch { return false; }
  })();
  const escapeHatch = hasSession
    ? ""
    : `<a href="#/login" class="dim text-xs" style="margin-top: var(--sp-4); display:inline-block;">Log in to continue</a>`;
  main.innerHTML = `
    <div class="empty-state" style="padding-top: var(--sp-12);">
      <div class="spinner" aria-hidden="true" style="margin: 0 auto var(--sp-4);"></div>
      <p class="dim" style="font-size: var(--text-sm);">${line}</p>
      ${escapeHatch}
    </div>
  `;
}

export function navigate(route) {
  location.hash = "#" + (route.startsWith("/") ? route : "/" + route);
}

// Strong sync signal that the user IS authed even if refreshCurrentUser
// hasn't populated the cache yet. A persisted Supabase session token is
// PROOF of auth — the JWT is already signed and dated, and the actual
// RPC calls will still 401 if it's expired. Avoids the "hard reload →
// flash of /login before state loads" we kept hitting.
function hasPersistedSession() {
  try { return !!localStorage.getItem("ss.sb.session.v1"); } catch { return false; }
}

// Deferred auth check: only redirects to /login if we're CONFIDENT the
// user isn't logged in. On page load, if refreshCurrentUser hasn't
// resolved yet but a Supabase session token is persisted, we subscribe
// to state changes and re-run the route guard when the cache fills —
// instead of bouncing to /login and letting the user click nav to
// recover. Also handles the needsOnboarded flicker the same way.
let _pendingRouteCheck = null;

export function mountRouter() {
  const main = document.getElementById("main");

  function route() {
    // Cancel any queued deferred check — we're about to re-evaluate fresh.
    if (_pendingRouteCheck) { _pendingRouteCheck(); _pendingRouteCheck = null; }

    const r = currentRoute();
    // page_view is recorded HERE rather than on the hashchange listener.
    // route() is also called directly at the bottom of this file on boot, so
    // a listener-only hook would miss the first page of every session — which
    // is the landing page, i.e. the most interesting one.
    track("page_view", location.hash || "#/", { name: r?.name || null });
    const user = currentUser();
    const state = getState();

    // needsAuth: if we don't know the user yet BUT a session token exists,
    // wait for refreshCurrentUser instead of redirecting. Only send them
    // to /login when we're sure they have no session at all.
    if (r.needsAuth && !user) {
      if (hasPersistedSession()) {
        showLoadingShell(r.name);
        const unsub = subscribe(() => {
          if (currentUser()) {
            cleanup();
            route();
          }
        });
        // Safety net: if refresh silently fails, fall through to /login
        // after 6s so users aren't stuck on a forever-spinner.
        // Hotfix56b: when the timer fires AND user still null, the
        // persisted session token is broken (expired, corrupted, or
        // pointing at a deleted account). Without explicitly clearing
        // it, the next route() re-entry sees hasPersistedSession()
        // still true and shows the loading shell AGAIN â€” infinite
        // loop. User-reported: 'Getting your portfolio ready...'
        // stuck after MF buy + reload. Now we wipe the stale token
        // before redirecting so /login is the unambiguous next state.
        const timer = setTimeout(() => {
          cleanup();
          if (!currentUser()) {
            try { localStorage.removeItem("ss.sb.session.v1"); } catch {}
            navigate("/login");
          } else {
            route();
          }
        }, 3000);   // Hotfix56b: was 6000ms; 3s is enough for any healthy refresh
        function cleanup() {
          unsub?.();
          clearTimeout(timer);
          if (_pendingRouteCheck === cleanup) _pendingRouteCheck = null;
        }
        _pendingRouteCheck = cleanup;
        return;
      }
      navigate("/login");
      return;
    }

    // needsOnboarded: same treatment. If we have a user object but the
    // profile fields (including `onboarded`) haven't loaded from the DB
    // yet, wait — don't bounce them to /onboarding mid-page-load.
    if (r.needsOnboarded && user && !state.user.onboarded && user._pendingRefresh) {
      showLoadingShell();
      const unsub = subscribe(() => {
        const u = currentUser();
        if (u && !u._pendingRefresh) { cleanup(); route(); }
      });
      const timer = setTimeout(() => { cleanup(); route(); }, 6000);
      function cleanup() {
        unsub?.();
        clearTimeout(timer);
        if (_pendingRouteCheck === cleanup) _pendingRouteCheck = null;
      }
      _pendingRouteCheck = cleanup;
      return;
    }
    if (r.needsOnboarded && user && !state.user.onboarded) { navigate("/onboarding"); return; }

    main.innerHTML = "";
    main.classList.remove("page-enter");
    void main.offsetWidth;
    main.classList.add("page-enter");
    // Error boundary — a single page throw used to blank the whole UI.
    // Now the user sees a recoverable "something went wrong" card with a
    // retry button, and the error is logged to the console for debugging.
    try {
      r.render(main, r.params);
    } catch (err) {
      console.error(`[router] ${r.name} render failed:`, err);
      // Hotfix50b: surface the actual error message + stack in the UI
      // so we can debug without DevTools. Plain pre-formatted text in a
      // collapsible details element â€” doesn't break the existing layout
      // for non-developers (still shows the friendly heading first).
      const errMsg = String(err && err.message || err || "unknown error");
      const errStack = String(err && err.stack || "");
      main.innerHTML = `
        <div class="empty-state">
          <span class="emoji" aria-hidden="true">⚠</span>
          <h3>Something broke on this page</h3>
          <p class="dim">We logged the error. You can reload or go back.</p>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px;">
            <button class="btn btn-primary" id="route-retry">Reload page</button>
            <a href="#/" class="btn btn-outline">Go home</a>
          </div>
          <details style="margin-top:24px; max-width: 720px; margin-left:auto; margin-right:auto; text-align:left;">
            <summary class="dim text-xs" style="cursor:pointer; user-select:none;">Show technical details</summary>
            <pre style="background:var(--bg-soft); border-radius:var(--r-sm); padding:12px; margin-top:8px; font-size:11px; line-height:1.5; overflow:auto; max-height:240px; white-space:pre-wrap; word-break:break-word;">${escapeHtml(errMsg)}\n\n${escapeHtml(errStack)}</pre>
          </details>
        </div>
      `;
      main.querySelector("#route-retry")?.addEventListener("click", () => {
        window.location.reload();
      });
    }
    // Local escape helper used by the error boundary above. Inline so the
    // router doesn't grow a new module-level import for one call.
    function escapeHtml(s) {
      const d = document.createElement("div");
      d.textContent = String(s ?? "");
      return d.innerHTML;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  installTracking();
  window.addEventListener("hashchange", route);
  route();
}
