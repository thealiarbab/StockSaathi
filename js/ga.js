// Google Analytics 4. Loaded as a file because the CSP (script-src 'self')
// blocks inline scripts, same as va.js.
//
// Admin slugs are secrets, so GA never builds its own page views: the router
// sends each one with the path already redacted (trackablePath in router.js),
// and GA's per-hit kill switch is on whenever the URL is under /a/. That also
// stops GA's automatic history-change page views if they get switched on in
// the GA admin. Google signals and ad personalisation stay off.
(function () {
  var ID = ""; // GA4 measurement ID ("G-…"). Empty = analytics off.

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
  gtag("config", ID, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

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

  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + ID;
  document.head.appendChild(s);
})();
