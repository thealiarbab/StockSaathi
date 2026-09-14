// =============================================================================
// SERVICE WORKER — Offline-first cache. Demo-day insurance against flaky WiFi.
// =============================================================================

// Bump this on every deploy so old cached JS/HTML isn't served forever. The
// activate step below deletes any cache whose name doesn't match. Include a
// date so it is obvious in DevTools which build is live.
const CACHE_NAME = "stocksaathi-v283-20260914d";
const STATIC = [
  "./",
  "./index.html",
  "./manifest.json",
  "./logo.svg",
  "./privacy.html",
  "./terms.html",
  "./grievance.html",
  "./og-image.svg",
  "./robots.txt",
  "./sitemap.xml",
  "./css/main.css",
  "./css/components.css",
  "./js/app.js",
  "./js/state.js",
  "./js/money.js",
  "./js/router.js",
  "./js/auth/accounts.js",
  "./js/features/transfers.js",
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
  "./js/db/sync.js",
  "./js/features/limitOrders.js",
  "./js/features/customCrash.js",
  "./js/features/chatSessions.js",
  "./js/features/aiExplainer.js",
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
  "./js/data/marketData.js",
  "./js/data/news.js",
  "./js/pages/landing.js",
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
  "./js/pages/friends.js",
  "./js/pages/news.js",
  "./js/pages/admin.js",
  "./js/pages/chat.js",
  "./js/pages/privacy.js",
  "./js/pages/terms.js",
  "./js/pages/grievance.js",
];

self.addEventListener("install", (event) => {
  // Use cache.add per-entry inside allSettled so a single 404 (e.g. a path
  // that was renamed since the last deploy) doesn't reject the whole install
  // — previously this made the SW fail forever and left the OLD SW in
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
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never cache external APIs — always network
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

  // Never cache our own /api/* routes — they should always hit network.
  // Previously these were cache-first and could return stale config / health /
  // consent responses on subsequent loads.
  if (url.pathname.startsWith("/api/")) return;

  // Network-first for HTML shell so users get new builds fast. Fallback
  // to cache on offline. This combines with the new CACHE_NAME bump so
  // an old build can't stick around after a deploy.
  const isHTML = event.request.mode === "navigate"
                 || (event.request.headers.get("accept") || "").includes("text/html");

  if (isHTML) {
    event.respondWith(
      fetch(event.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      }).catch(() => caches.match(event.request).then(c => c || caches.match("./index.html")))
    );
    return;
  }

  // Cache-first for assets (CSS, JS, fonts, icons) — fast on repeat.
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
