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
