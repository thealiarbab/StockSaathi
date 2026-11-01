// =============================================================================
// SERVICE WORKER — offline-first cache, and the reason repeat visits cost the
// CDN almost nothing.
// =============================================================================
//
// Two kinds of file, two caches:
//
// 1. Content-hashed files (/assets/*, /fonts/*, /js/data/<name>.<sha8>.json).
//    A name never changes meaning, so they are served cache-first with NO
//    background re-check, from ASSET_CACHE, which survives deploys. A deploy
//    ships new names; the new index.html points at them; nothing is thrown
//    away except files no recent build uses (pruneAssets).
// 2. Everything else that is not HTML or /api (icons, manifest, the data
//    index files, the unhashed source files old pages may still ask for).
//    Cache-first in STATIC_CACHE, whose name follows the build id, so each
//    deploy starts it fresh. It holds a handful of small files.
//
// HTML is network-first, as before, so a deploy reaches users on their next
// page load.
//
// BUILD is filled in by build/bundle.mjs at deploy: { id, core, assets }.
// null means the unbuilt source (local dev). Do not bump anything here for
// code changes: the build id changes by itself whenever a served file does.
// Change SW_VERSION only when this file's own logic changes.
const BUILD = null;
const SW_VERSION = "v480-20261101";
const BUILD_ID = BUILD ? BUILD.id : "dev";
const ASSET_CACHE = "stocksaathi-assets-v1";
const STATIC_CACHE = `stocksaathi-${SW_VERSION}-${BUILD_ID}`;
// Re-fetched once per build: the two pages offline navigation falls back to.
// Everything else unhashed is cached the first time it is used.
const STATIC = [
  "./",
  "./app-shell",
];
// The core bundle, its stylesheet and fonts: enough to open the app offline.
// Page chunks are cached the first time they are used.
const CORE = [
  "/fonts/inter-latin.woff2",
  "/fonts/inter-latin-ext.woff2",
  ...(BUILD ? BUILD.core : []),
];

const isImmutable = (path) =>
  path.startsWith("/assets/") || path.startsWith("/fonts/")
  || /^\/js\/data\/[A-Za-z]+\.[0-9a-f]{8}\.json$/.test(path);

// Pages visited (navigations) live in their own cache, capped (S3): every
// stock page ever opened used to stay in the main cache for good, ~2,000
// of them available, with no limit. Deleted with the build like the rest.
const PAGES_CACHE = STATIC_CACHE + "-pages";
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

// Store a hashed file. A new copy of a data file (universeFull.<sha8>.json,
// ~1 MB, new every daily refresh) replaces the older ones of the same name.
async function putAsset(request, response) {
  try {
    const cache = await caches.open(ASSET_CACHE);
    await cache.put(request, response);
    const m = new URL(request.url).pathname.match(/^\/js\/data\/([A-Za-z]+)\.[0-9a-f]{8}\.json$/);
    if (!m) return;
    for (const key of await cache.keys()) {
      const p = new URL(key.url).pathname;
      if (p !== new URL(request.url).pathname && p.startsWith(`/js/data/${m[1]}.`)) await cache.delete(key);
    }
  } catch {}
}

// Keep the /assets/ files of this build and the one before it. A tab still
// running the previous build can then open a page it has not opened yet:
// Vercel no longer serves that build's files.
const BUILDS_KEY = "/__sw/builds.json";
async function pruneAssets() {
  if (!BUILD) return;
  const cache = await caches.open(ASSET_CACHE);
  let builds = [];
  try { builds = (await (await cache.match(BUILDS_KEY))?.json()) || []; } catch {}
  builds = builds.filter((b) => b.id !== BUILD.id).slice(-1);
  builds.push({ id: BUILD.id, assets: BUILD.assets });
  await cache.put(BUILDS_KEY, new Response(JSON.stringify(builds), { headers: { "content-type": "application/json" } }));
  const keep = new Set(builds.flatMap((b) => b.assets));
  for (const key of await cache.keys()) {
    const p = new URL(key.url).pathname;
    if (p.startsWith("/assets/") && !keep.has(p)) await cache.delete(key);
  }
}

self.addEventListener("install", (event) => {
  // Per-entry, inside allSettled, so a single 404 (e.g. a path renamed since
  // the last deploy) doesn't reject the whole install — that once made the
  // SW fail forever and left the OLD SW in charge for weeks.
  event.waitUntil((async () => {
    const statics = await caches.open(STATIC_CACHE);
    const assets = await caches.open(ASSET_CACHE);
    await Promise.allSettled([
      ...STATIC.map(async (url) => {
        const res = await fetch(url, { cache: "reload" });
        if (res && res.ok) await statics.put(url, res);
      }),
      // Hashed files already cached from an earlier build are not fetched
      // again. The rest normally come straight from the HTTP cache.
      ...CORE.map(async (url) => {
        if (await assets.match(url)) return;
        const res = await fetch(url);
        if (res && res.ok) await assets.put(url, res);
      }),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  const live = new Set([ASSET_CACHE, STATIC_CACHE, PAGES_CACHE]);
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !live.has(k)).map((k) => caches.delete(k)));
    try { await pruneAssets(); } catch {}
    await self.clients.claim();
  })());
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
  if (event.request.method !== "GET") return;

  // Never cache our own /api/* routes â€” they should always hit network.
  // Previously these were cache-first and could return stale config / health
  // responses on subsequent loads.
  if (url.pathname.startsWith("/api/")) return;
  // /sb/* is the database relay (vercel.json rewrite to Supabase): never cache.
  if (url.pathname.startsWith("/sb/")) return;
  if (url.pathname === "/sw.js") return;

  // Network-first for HTML so users get new builds fast. Fallback to cache
  // when offline.
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

  // Hashed files: cache-first, never re-checked. ignoreVary: the data files
  // carry "Vary: Accept-Encoding" (Brotli rewrite in vercel.json), and the
  // content is the same whichever encoding it travelled in.
  if (isImmutable(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(event.request, { ignoreVary: true });
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok) event.waitUntil(putAsset(event.request, res.clone()));
      return res;
    })());
    return;
  }

  // Everything else: cache-first for this build.
  event.respondWith(
    caches.open(STATIC_CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      try {
        const res = await fetch(event.request);
        if (res.ok) event.waitUntil(cache.put(event.request, res.clone()));
        return res;
      } catch (error) {
        const fallback = await caches.match(event.request);
        if (fallback) return fallback;
        throw error;
      }
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
  // ss_n / ss_via: the page reports which notification brought the user back
  // (js/features/openTracking.js) and strips them again.
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  if (event.notification.data?.id) {
    target.searchParams.set("ss_n", event.notification.data.id);
    target.searchParams.set("ss_via", "push");
  }
  const url = target.href;
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
