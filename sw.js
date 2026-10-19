// =============================================================================
// SERVICE WORKER â€” Offline-first cache. Demo-day insurance against flaky WiFi.
// =============================================================================

// Bump this on every deploy so old cached JS/HTML isn't served forever. The
// activate step below deletes any cache whose name doesn't match. Include a
// date so it is obvious in DevTools which build is live.
const CACHE_NAME = "stocksaathi-v425-20261019y";
const STATIC = [
  "./",
  "./app-shell",
  "./manifest.json",
  "./logo.svg",
  "./privacy",
  "./terms",
  "./grievance",
  "./favicon.ico",
  "./images/icon-192.png",
  "./robots.txt",
  "./sitemap.xml",
  "./css/main.css",
  "./css/components.css",
  "./fonts/inter-latin.woff2",
  "./fonts/inter-latin-ext.woff2",
  "./js/app.js",
  "./js/state.js",
  "./js/money.js",
  "./js/router.js",
  "./js/pageTitles.js",
  "./js/pages/staticPage.js",
  "./js/navigation.js",
  "./js/va.js",
  "./js/ga.js",
  "./js/auth/accounts.js",
  "./js/auth/emailCheck.js",
  "./js/components/googleButton.js",
  "./js/components/nav.js",
  "./js/components/coachPanel.js",
  "./js/components/interventionModal.js",
  "./js/components/toast.js",
  "./js/components/charts.js",
  "./js/components/chartZoom.js",
  "./js/components/quantitySelector.js",
  "./js/components/commandPalette.js",
  "./js/components/eventMarquee.js",
  "./js/components/themedSelect.js",
  "./js/coach/biasDetectors.js",
  "./js/coach/templates.js",
  "./js/coach/outputFilter.js",
  "./js/coach/orchestrator.js",
  "./js/coach/historicalAnalog.js",
  "./js/coach/llmBridge.js",
  "./js/coach/persona.js",
  "./js/coach/liveData.js",
  "./js/coach/agent.js",
  "./js/db/supabase.js",
  "./js/vendor/supabase-js-2.45.4.js",
  "./js/vendor/supabase-js-2.45.4.umd.js",
  "./js/db/sync.js",
  "./js/features/limitOrders.js",
  "./js/features/telemetry.js",
  "./js/features/stockSearch.js",
  "./js/features/stockSearchUi.js",
  "./js/features/aiLang.js",
  "./js/features/customCrash.js",
  "./js/features/chatSessions.js",
  "./js/features/chatBranches.js",
  "./js/features/chatCloud.js",
  "./js/features/chatCards.js",
  "./js/features/chatOrder.js",
  "./js/features/chatProjects.js",
  "./js/features/notifications.js",
  "./js/components/bell.js",
  "./js/components/backdrop.js",
  "./js/features/preview.js",
  "./js/features/aiExplainer.js",
  "./js/data/glossary.js",
  "./js/features/portfolioDigest.js",
  "./js/features/marketStatusPopover.js",
  "./js/data/universe.js",
  "./js/data/universeLoader.js",
  "./js/data/curated.js",
  "./js/data/universeFull.json",
  "./js/data/universeFull.meta.json",
  "./js/data/mfFull.json",
  "./js/data/mfFull.meta.json",
  "./js/data/prices.js",
  "./js/data/serverTime.js",
  "./js/data/crashes.js",
  "./js/data/dips.js",
  "./js/data/realCloses.js",
  "./js/data/marketData.js",
  "./js/data/news.js",
  "./js/pages/landing.js",
  "./js/pages/landingContent.js",
  "./js/pages/portfolio.js",
  "./js/pages/stocks.js",
  "./js/pages/stockDetail.js",
  "./js/pages/crashReplay.js",
  "./js/pages/reportCard.js",
  "./js/pages/onboarding.js",
  "./js/pages/settings.js",
  "./js/pages/login.js",
  "./js/pages/register.js",
  "./js/pages/resetPasswordRequest.js",
  "./js/pages/resetPassword.js",
  "./js/pages/news.js",
  "./js/pages/admin.js",
  "./js/pages/adminCharts.js",
  "./js/pages/adminSignups.js",
  "./js/pages/adminBehaviour.js",
  "./js/pages/chat.js",
  "./js/pages/sharedChat.js",
  "./js/pages/privacy.js",
  "./js/pages/terms.js",
  "./js/pages/grievance.js",
];

// Pages visited (navigations) live in their own cache, capped (S3): every
// stock page ever opened used to stay in the main cache for good, ~2,000
// of them available, with no limit. Deleted with the build like the rest.
const PAGES_CACHE = CACHE_NAME + "-pages";
const MAX_PAGES = 50;
async function putPage(request, response) {
  try {
    const cache = await caches.open(PAGES_CACHE);
    await cache.delete(request);          // re-put = most recent (keys keep insertion order)
    await cache.put(request, response);
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - MAX_PAGES; i++) await cache.delete(keys[i]);
  } catch {}
}

self.addEventListener("install", (event) => {
  // Use cache.add per-entry inside allSettled so a single 404 (e.g. a path
  // that was renamed since the last deploy) doesn't reject the whole install
  // â€” previously this made the SW fail forever and left the OLD SW in
  // charge, which is how stale caches lived for weeks.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(STATIC.map(async (url) => {
      try {
        const res = await fetch(url, { cache: "reload" });
        if (res && res.ok) await cache.put(url, res);
      } catch {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== PAGES_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never cache external APIs â€” always network
  // External API hostnames the SW must never try to cache. Listed as
  // substrings so subdomains match. These are required API destinations;
  // removing any will either break the feature or let the SW swallow its
  // requests.
  const externalHosts = [
    "finnhub.io",
    "api.groq.com",
    "anthropic.com",
    "api.coingecko.com",
    "api.mfapi.in",
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com",
    "api.rss2json.com",
    "corsproxy.io",
    "allorigins.win",
    "codetabs.com",
    "cdn.emailjs.com",
    "api.emailjs.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
  ];
  if (externalHosts.some(h => url.hostname.includes(h))) return;

  if (url.origin !== location.origin) return;

  // Never cache our own /api/* routes â€” they should always hit network.
  // Previously these were cache-first and could return stale config / health
  // responses on subsequent loads.
  if (url.pathname.startsWith("/api/")) return;
  // /sb/* is the database relay (vercel.json rewrite to Supabase): never cache.
  if (url.pathname.startsWith("/sb/")) return;

  // Network-first for HTML shell so users get new builds fast. Fallback
  // to cache on offline. This combines with the new CACHE_NAME bump so
  // an old build can't stick around after a deploy.
  const isHTML = event.request.mode === "navigate"
                 || (event.request.headers.get("accept") || "").includes("text/html");

  if (isHTML) {
    event.respondWith(
      fetch(event.request).then(res => {
        if (res.ok) event.waitUntil(putPage(event.request, res.clone()));
        return res;
      }).catch(() => caches.match(event.request)
        .then(c => c || caches.match("./app-shell"))      // offline deep link: SPA shell renders the route
        .then(c => c || caches.match("./")))
    );
    return;
  }

  // Cache-first for assets (CSS, JS, fonts, icons) â€” fast on repeat.
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(res => {
        if (event.request.method === "GET" && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});

// Let the page tell the SW to activate a new build immediately.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

// ---- Web push (owner preview; migration 2026-10-19f, push-dispatch) ---------
// The payload is the notification row: { id, title, body, url, kind, tag }.
// Tapping it focuses an open StockSaathi tab and moves it to `url`, or opens
// one there.
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: "StockSaathi", body: event.data?.text() || "" }; }
  event.waitUntil(self.registration.showNotification(d.title || "StockSaathi", {
    body: d.body || "",
    icon: "/images/icon-192.png",
    badge: "/images/badge-96.png",
    tag: d.tag || d.id,
    data: { url: d.url || "/", id: d.id },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const tab = tabs.find((c) => c.url.startsWith(self.location.origin));
    if (tab) {
      await tab.focus();
      try { await tab.navigate(url); } catch { tab.postMessage({ type: "ss:open", url }); }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
