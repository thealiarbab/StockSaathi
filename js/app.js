// =============================================================================
// APP ENTRY — Theme bootstrap, nav, coach, router, service worker.
// =============================================================================

import { getState, subscribe, setSetting, setSettings, switchUser, resolvedTheme } from "./state.js";
import { mountNav } from "./components/nav.js";
import { mountCoachLauncher } from "./components/coachLauncher.js";
import { mountEventMarquee } from "./components/eventMarquee.js";
import { mountRouter } from "./router.js";
import { currentUser, refreshCurrentUser } from "./auth/accounts.js";
import { bootSync } from "./db/sync.js";
import { startOrderEvents } from "./features/limitOrders.js";
import { startTelemetry } from "./features/telemetry.js";
import { showPendingNotices } from "./components/noticeModal.js";
import { mountAiExplainer } from "./features/aiExplainer.js";
import { mountCommandPalette, openCommandPalette } from "./components/commandPalette.js";
import { startServerTimeSync } from "./data/serverTime.js";
import { mountMarketStatusPopover } from "./features/marketStatusPopover.js";
import { ensureUniverseLoaded } from "./data/universe.js";
import { upgradeLegacyHash } from "./navigation.js";
import { ensureCoachStyles, ensureStylesheet } from "./features/styles.js";
import { toast } from "./components/toast.js";
import { captureOpen } from "./features/openTracking.js";

// Old "#/…" links (bookmarks, shared URLs, emails sent before clean URLs) →
// clean path, before anything reads the URL. Runs ahead of the Supabase
// client's creation, so a legacy password-reset link's "#access_token=…"
// ends up in location.hash where supabase-js expects it.
upgradeLegacyHash();
// A push tap or email link (?ss_n= / ?ss_e=): count it, then clean the URL.
captureOpen();

// Theme ASAP to avoid flash
(function applyTheme() {
  document.documentElement.setAttribute("data-theme", resolvedTheme(getState().settings));
  // Follow the system switching (sunset, Control Centre) while nobody has
  // picked a theme; setSettings({}) re-renders the toggles' icons too.
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (!getState().settings.themeChosen) setSettings({});
    });
  } catch {}
})();

// Load user-scoped state on boot (local immediately)
switchUser();
if (window.innerWidth < 1280 && getState().settings.coachPanelOpen) {
  setSetting("coachPanelOpen", false);
}

// Kick off the server-time sync early so the market-status badge has a
// trusted clock within a second of first paint. Non-blocking.
startServerTimeSync();

// Kick the Tier-2 universe fetch (universeFull.json, ~2700 rows / ~90 KB
// brotli'd). Non-blocking — pages can render curated-only immediately and
// listen for the ss:universe-loaded event to re-render when Tier-2 lands.
// SW-cached, so subsequent loads are free.
ensureUniverseLoaded();

// Visitor tracking (js/features/telemetry.js). Never allowed to break the app.
try { startTelemetry(); } catch (e) { console.warn("telemetry off:", e); }

let coachPanelLoad;
function canLoadCoachPanel() {
  const path = location.pathname || "/";
  return getState().isAuthed && !["", "/", "/login", "/register"].includes(path);
}

function syncCoachPanel() {
  if (!getState().settings.coachPanelOpen || !canLoadCoachPanel() || coachPanelLoad) return;
  coachPanelLoad = (async () => {
    const panelPromise = import("./components/coachPanel.js");
    await ensureCoachStyles();
    const panel = await panelPromise;
    panel.mountCoachPanel();
  })().catch((error) => {
    coachPanelLoad = undefined;
    console.error("[coach] Failed to load Coach panel:", error);
    setSetting("coachPanelOpen", false);
    toast({ kind: "error", message: "Coach could not load. Please try again." });
  });
}

const componentPreload = document.getElementById("components-css-preload");
const componentStylesReady = componentPreload
  ? ensureStylesheet("components-stylesheet", "/css/components.css", "components-css-preload")
  : Promise.resolve();

let appMounted = false;
function mountApp() {
  if (appMounted) return;
  appMounted = true;
  mountEventMarquee();   // hides itself when no active events
  mountNav();
  mountCoachLauncher();
  mountAiExplainer();
  mountCommandPalette();
  mountMarketStatusPopover();
  mountRouter();
  subscribe(syncCoachPanel);
  window.addEventListener("ss:navigate", syncCoachPanel);
  syncCoachPanel();
}

// Wait briefly for the component styles so the first paint does not jump,
// but never let a slow or failed stylesheet keep the app from opening: an
// unstyled page still works, a blank one does not.
const STYLE_WAIT_MS = 2500;
Promise.race([
  componentStylesReady,
  new Promise((resolve) => setTimeout(resolve, STYLE_WAIT_MS)),
]).then(mountApp, mountApp);
componentStylesReady.catch((error) => {
  console.error("[app] Component stylesheet failed to load:", error);
  mountApp();
  toast({ kind: "error", message: "Some styles didn't load. Pull to refresh if the page looks off." });
});

// If Supabase is configured, boot cross-device sync + start the limit-order
// fill listener (the server fills orders; the tab only hears about it).
(async () => {
  try {
    await refreshCurrentUser();
    await bootSync();
    switchUser();
    startOrderEvents();
  } catch (e) { console.warn("Supabase boot skipped:", e); }
})();

// PRIVACY: drop any cached coach transcript that does not belong to whoever
// is signed in on this device right now.
//
// The coach caches (ss.chat.sessions.v1 / ss.coachchat.v1) are unscoped
// localStorage keys, and `/chat` is a PUBLIC route — so a signed-out browser
// was still rendering the previous user's entire conversation with the coach.
// Logout now clears them, but this covers the cases logout never sees: a
// session that expired on its own, a cache written before this fix shipped,
// and signing in as a different person on a shared device.
//
// Runs before anything can paint the chat. The server copy in coach_messages
// is untouched and re-hydrates on sign-in.
(async () => {
  try {
    let uid = null;
    try {
      const raw = localStorage.getItem("ss.sb.session.v1");
      uid = raw ? (JSON.parse(raw)?.user?.id ?? null) : null;
    } catch { uid = null; }
    const { enforceChatCacheOwner } = await import("./db/sync.js");
    enforceChatCacheOwner(uid);
  } catch (e) { console.warn("chat-cache owner check skipped:", e); }
})();

// Personal notices run on their OWN chain, deliberately not sequenced behind
// bootSync().
//
// They were chained after it at first, and a live test on a flaky network
// showed the cost: bootSync() never settled — no throw, so nothing was even
// logged — and the notice simply never appeared. Gating an apology on the
// slowest, most failure-prone step of boot is exactly backwards: the users
// owed one are the ones whose network and session were already misbehaving.
//
// showPendingNotices() reads its own Supabase client, is a no-op when there
// is nothing unseen or nobody is logged in, and swallows its own errors.
// A small delay keeps it from competing with first paint.
setTimeout(() => { showPendingNotices(); }, 1200);

// Reactively sync theme
subscribe((s) => {
  document.documentElement.setAttribute("data-theme", resolvedTheme(s.settings));
});

// Service worker (offline) — auto-update so users aren't stuck on a
// months-old cached JS bundle. When a new SW installs, tell it to activate
// immediately and reload the page once.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      // Absolute path: with clean URLs a page can load at /stocks/TCS, where
      // "./sw.js" would resolve to /stocks/sw.js (404) and scope the worker
      // to /stocks/.
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      // Periodic update check — long-open tabs catch up to recent
      // deploys without waiting for the browser's own 24h-capped
      // background update cycle. Pre-fix reg.update() ran exactly once
      // on window.load, so a tab parked overnight could keep serving
      // stale cached bundles past several deploys.
      const checkForUpdate = () => { reg.update().catch(() => {}); };
      checkForUpdate();
      setInterval(checkForUpdate, 5 * 60 * 1000);
      // Re-check on tab refocus — most common path back from
      // background. Catches the "I left my tab open yesterday and you
      // shipped 5 hotfixes overnight" case faster than the 5-min
      // interval would.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") checkForUpdate();
      });
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            sw.postMessage("SKIP_WAITING");
          }
        });
      });
      let reloaded = false;
      let reloadWaitingForChat = false;
      // The worker found a changed file that came without a version bump
      // (see sw.js). Pick it up on the next in-app navigation, never mid-page.
      let staleAssets = false;
      navigator.serviceWorker.addEventListener("message", (e) => {
        if (e.data?.type === "asset-updated") staleAssets = true;
      });
      window.addEventListener("ss:navigate", () => {
        if (staleAssets && !document.getElementById("chat-stop")) window.location.reload();
      });
      // Only an UPDATE should reload. On a visitor's very first load the page
      // starts uncontrolled; the new worker's clients.claim() still fires
      // controllerchange, which used to reload the page a few seconds after
      // a first-time visitor arrived, often mid-read or mid-click.
      const hadController = !!navigator.serviceWorker.controller;
      const safeReload = () => {
        if (!hadController) return;
        if (reloaded) return;
        const ae = document.activeElement;
        if (document.getElementById("chat-stop")) {
          if (reloadWaitingForChat) return;
          reloadWaitingForChat = true;
          const observer = new MutationObserver(() => {
            if (!document.getElementById("chat-stop")) {
              observer.disconnect();
              reloadWaitingForChat = false;
              safeReload();
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
          return;
        }
        reloaded = true;
        const typing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
        if (typing) {
          if (ae.id === "chat-input" && typeof ae.value === "string") {
            try {
              sessionStorage.setItem("ss.sw-update-chat-draft.v1", JSON.stringify({
                path: location.pathname,
                value: ae.value,
                start: ae.selectionStart,
                end: ae.selectionEnd,
              }));
            } catch {
              ae.addEventListener("blur", () => window.location.reload(), { once: true });
              return;
            }
            window.location.reload();
          } else {
            ae.addEventListener("blur", () => window.location.reload(), { once: true });
            return;
          }
        } else {
          window.location.reload();
        }
      };
      navigator.serviceWorker.addEventListener("controllerchange", safeReload);
    } catch (err) {
      console.warn("SW registration failed (non-critical):", err);
    }
  });
}

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  if (e.key === "/" && location.pathname.startsWith("/stocks")) {
    e.preventDefault();
    document.querySelector("#stocks-search")?.focus();
  }
  if (e.key === "c" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    setSetting("coachPanelOpen", !getState().settings.coachPanelOpen);
  }
});

console.log("%cStockSaathi", "color: #00B386; font-size: 22px; font-weight: 800;");
console.log("%cInvest virtually. Learn for real. No external deps, fully offline-capable.",
  "color: #5C6473; font-size: 12px;");
