// Google Analytics 4 (and Microsoft Clarity, at the bottom). Loaded as a file because the CSP (script-src 'self')
// blocks inline scripts, same as va.js.
//
// Admin slugs are secrets, so GA never builds its own page views: the router
// sends each one with the path already redacted (trackablePath in router.js),
// and GA's per-hit kill switch is on whenever the URL is under /a/. That also
// stops GA's automatic history-change page views if they get switched on in
// the GA admin.
// Third-party scripts wait until the page has painted and gone quiet. On
// budget phones over mobile data they were competing with our own CSS and JS
// for the same bandwidth (home page: 2.8 s to main content at p75, 18 Oct).
window.ssAfterLoad = function (fn) {
  function idle() { (window.requestIdleCallback || function (f) { setTimeout(f, 1); })(fn, { timeout: 2000 }); }
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true });
};

(function () {
  var ID = "G-65CB0CZ1PX"; // GA4 measurement ID. Empty = analytics off.

  var noop = function () {};
  window.ssGa = { guard: noop, page: noop };
  if (!ID) return;

  var OFF = "ga-disable-" + ID;
  function guard(path) {
    window[OFF] = String(path || location.pathname).indexOf("/a/") === 0;
  }

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  guard();
  gtag("js", new Date());
  gtag("config", ID, { send_page_view: false });

  window.ssGa = {
    guard: guard,
    page: function (path) {
      guard();
      if (window[OFF]) return;
      gtag("event", "page_view", {
        page_location: location.origin + path,
        page_title: document.title,
      });
    },
  };

  window.ssAfterLoad(function () {
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + ID;
    document.head.appendChild(s);
  });
})();

// Microsoft Clarity: heatmaps and session recordings. It lives in this file
// so every page that already loads GA gets it without touching the HTML.
//
// Clarity records the page address itself (no redacted path to hand it), so
// it is never started in a tab that opens on an admin page. Nothing in the
// app links to /a/, so an admin page is only ever reached by a fresh load.
// Password fields are always masked by Clarity; how much other text is
// masked is the project's masking mode, set in the Clarity dashboard.
(function () {
  var ID = "yzb63jvdw1"; // Clarity project ID. Empty = Clarity off.
  if (!ID || location.pathname.indexOf("/a/") === 0) return;

  window.clarity = window.clarity || function () {
    (window.clarity.q = window.clarity.q || []).push(arguments);
  };
  window.ssAfterLoad(function () {
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.clarity.ms/tag/" + ID;
    document.head.appendChild(s);
  });
})();

// Google AdSense (auto ads). Was a <script async> in every page's <head>.
(function () {
  if (location.pathname.indexOf("/a/") === 0) return;
  window.ssAfterLoad(function () {
    var s = document.createElement("script");
    s.async = true;
    s.crossOrigin = "anonymous";
    s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6383385864830785";
    document.head.appendChild(s);
  });
})();
