// =============================================================================
// APP ENTRY — Theme bootstrap, nav, coach, router, service worker.
// =============================================================================

import { getState, subscribe, setSetting, switchUser } from "./state.js";
import { mountNav } from "./components/nav.js";
import { mountEventMarquee } from "./components/eventMarquee.js";
import { mountCoachPanel } from "./components/coachPanel.js";
import { mountRouter } from "./router.js";
import { currentUser, refreshCurrentUser } from "./auth/accounts.js";
import { bootSync } from "./db/sync.js";
import { startLimitMatcher } from "./features/limitOrders.js";
import { showPendingNotices } from "./components/noticeModal.js";
import { mountAiExplainer } from "./features/aiExplainer.js";
import { mountCommandPalette, openCommandPalette } from "./components/commandPalette.js";
import { startServerTimeSync } from "./data/serverTime.js";
import { mountMarketStatusPopover } from "./features/marketStatusPopover.js";
import { ensureUniverseLoaded } from "./data/universe.js";

// Theme ASAP to avoid flash
(function applyTheme() {
  const theme = getState().settings.theme || "light";
  document.documentElement.setAttribute("data-theme", theme);
})();

// Load user-scoped state on boot (local immediately)
switchUser();

// Kick off the server-time sync early so the market-status badge has a
// trusted clock within a second of first paint. Non-blocking.
startServerTimeSync();

// Kick the Tier-2 universe fetch (universeFull.json, ~2700 rows / ~90 KB
// brotli'd). Non-blocking — pages can render curated-only immediately and
// listen for the ss:universe-loaded event to re-render when Tier-2 lands.
// SW-cached, so subsequent loads are free.
ensureUniverseLoaded();

// Mount components
mountEventMarquee();   // hides itself when no active events
mountNav();
mountCoachPanel();
mountAiExplainer();
mountCommandPalette();
mountMarketStatusPopover();
mountRouter();

// If Supabase is configured, boot cross-device sync + start the limit-order
// matcher in the background (only ticks when the user is authed + online).
(async () => {
  try {
    await refreshCurrentUser();
    await bootSync();
    switchUser();
    startLimitMatcher();
  } catch (e) { console.warn("Supabase boot skipped:", e); }
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
  document.documentElement.setAttribute("data-theme", s.settings.theme || "light");
});

// Service worker (offline) — auto-update so users aren't stuck on a
// months-old cached JS bundle. When a new SW installs, tell it to activate
// immediately and reload the page once.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
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
      const safeReload = () => {
        if (reloaded) return;
        reloaded = true;
        // Don't yank the page out from under a user mid-keystroke.
        // Wait for the focused input to lose focus, then reload. Falls
        // back to immediate reload if nothing's focused.
        const ae = document.activeElement;
        const typing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable);
        if (typing) {
          ae.addEventListener("blur", () => window.location.reload(), { once: true });
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
  if (e.key === "/" && location.hash.startsWith("#/stocks")) {
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
