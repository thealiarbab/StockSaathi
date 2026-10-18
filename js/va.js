// Storage guard. Some in-app browsers and strict privacy settings throw on any
// touch of localStorage ("Access is denied for this document"). That broke
// sign-up and login (43 failures on 18 Oct 2026). This is the first script on
// every page, so it swaps in an in-memory store before anything else runs:
// the visit works, nothing persists after the tab closes.
(function () {
  function mem() {
    var d = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; },
      setItem: function (k, v) { d[k] = String(v); },
      removeItem: function (k) { delete d[k]; },
      clear: function () { d = {}; },
      key: function (i) { return Object.keys(d)[i] || null; },
      get length() { return Object.keys(d).length; }
    };
  }
  ["localStorage", "sessionStorage"].forEach(function (name) {
    try { var s = window[name]; s.setItem("__ss_t", "1"); s.removeItem("__ss_t"); }
    catch (e) {
      try { Object.defineProperty(window, name, { value: mem(), configurable: true }); } catch (e2) {}
    }
  });
})();

// Vercel Web Analytics queue stub. Loaded as a file because the CSP
// (script-src 'self') blocks inline scripts — the old inline stub never ran.
//
// beforeSend drops page views of the admin console: its URL carries the secret
// ADMIN_PATH slug, which must never leave the browser in an analytics beacon.
window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
window.va("beforeSend", function (event) {
  try {
    if (new URL(event.url).pathname.indexOf("/a/") === 0) return null;
  } catch (e) { /* malformed URL: fall through and send as-is */ }
  return event;
});
