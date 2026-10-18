// =============================================================================
// Visitor tracking: pages, clicks (with position), forms, errors the student
// sees, scroll depth, time on page, searches and their results, failed or
// slow requests, page speed, outbound links, copying, going offline and app
// installs. Everyone is tracked, signed in or not; the server links a browser
// to an account once it signs in (it checks the session token itself).
//
// Never recorded: what is typed into fields (search boxes excepted), mouse
// movement, recordings of the screen. The admin pages are not tracked.
//
// Events are batched and sent to /api/ai?op=ev every 15 s, and on leaving
// with sendBeacon. Stored in web_events (see the 2026-10-18a migration).
// =============================================================================

import { currentUser } from "../auth/accounts.js";
import { sb } from "../db/supabase.js";

const ENDPOINT = "/api/ai?op=ev";
const VID_KEY = "ss.vid.v1";
const SID_KEY = "ss.sid.v1";
const IDLE_MS = 30 * 60_000;      // new session after 30 min without activity
const FLUSH_MS = 15_000;
const FLUSH_AT = 40;              // events
const SESSION_CAP = 2000;         // events per session; errors still go past it
const ERROR_CAP = 40;

let started = false;
let queue = [];
let sent = 0, errors = 0;
let vid = null, sid = null;
let token = null;
let page = null;                  // { path, start, visibleMs, visibleSince, maxScroll, title }
const lastClicks = [];
let lastSearch = null;            // { q, at }
const formsStarted = new WeakMap();   // form -> { id, submitted, lastField }
let fieldStart = null;            // { el, at }
const errSeen = new Map();
const alertSeen = new Map();

// ---------------------------------------------------------------------------
function rnd() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
}
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

const isAdminPath = (p = location.pathname) => p === "/a" || p.startsWith("/a/");

function device() {
  const coarse = matchMedia("(pointer: coarse)").matches;
  const w = Math.min(screen.width || innerWidth, screen.height || innerHeight);
  if (coarse && w < 600) return "mobile";
  if (coarse) return "tablet";
  return "desktop";
}
function osName(ua) {
  if (/android/i.test(ua)) return "Android";
  if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
  if (/cros/i.test(ua)) return "ChromeOS";
  if (/windows/i.test(ua)) return "Windows";
  if (/mac os x/i.test(ua)) return "macOS";
  if (/linux/i.test(ua)) return "Linux";
  return "Other";
}
function browserName(ua) {
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/samsungbrowser/i.test(ua)) return "Samsung";
  if (/firefox|fxios/i.test(ua)) return "Firefox";
  if (/crios|chrome/i.test(ua)) return "Chrome";
  if (/safari/i.test(ua)) return "Safari";
  return "Other";
}
const UA = navigator.userAgent || "";
const DEV = device(), OS = osName(UA), BR = browserName(UA);

function session() {
  const now = Date.now();
  let s = null;
  try { s = JSON.parse(lsGet(SID_KEY) || "null"); } catch {}
  let isNew = false;
  if (!s || !s.id || now - (s.last || 0) > IDLE_MS) { s = { id: rnd(), last: now }; isNew = true; }
  if (isNew || now - s.last > 10_000) { s.last = now; lsSet(SID_KEY, JSON.stringify(s)); }
  sid = s.id;
  return isNew;
}

function source() {
  const q = new URLSearchParams(location.search);
  let refHost = "";
  try { if (document.referrer) { const r = new URL(document.referrer); if (r.hostname !== location.hostname) refHost = r.hostname.replace(/^www\./, ""); } } catch {}
  const us = q.get("utm_source") || q.get("ref") || "";
  const src = us || (q.get("gclid") ? "google-ads" : "") || (q.get("fbclid") ? "facebook" : "") || refHost || "direct";
  const p = { src: src.toLowerCase().slice(0, 80) };
  if (us) p.us = us.slice(0, 80);
  if (q.get("utm_medium")) p.um = q.get("utm_medium").slice(0, 80);
  if (q.get("utm_campaign")) p.uc = q.get("utm_campaign").slice(0, 80);
  if (q.get("utm_content")) p.ut = q.get("utm_content").slice(0, 80);
  if (q.get("utm_term")) p.uk = q.get("utm_term").slice(0, 80);
  if (refHost) p.ref = refHost.slice(0, 120);
  return p;
}

// ---------------------------------------------------------------------------
function ev(kind, target = null, props = {}, path = location.pathname) {
  if (!started || isAdminPath(path)) return;
  const isErr = kind === "error";
  if (isErr) { if (++errors > ERROR_CAP) return; }
  else if (sent + queue.length >= SESSION_CAP) return;
  if (session()) startSession();
  queue.push([Date.now(), kind, path, target == null ? null : String(target).slice(0, 300), props, sid]);
  if (queue.length >= FLUSH_AT) flush();
}

function startSession() {
  const p = {
    ...source(),
    dev: DEV, os: OS, br: BR,
    scr: `${screen.width}x${screen.height}`,
    vp: `${innerWidth}x${innerHeight}`,
    dpr: Math.round((devicePixelRatio || 1) * 100) / 100,
    lang: (navigator.language || "").slice(0, 12),
    tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || "").slice(0, 40),
    th: document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    pwa: matchMedia("(display-mode: standalone)").matches ? 1 : 0,
    net: navigator.connection?.effectiveType || "",
    mem: navigator.deviceMemory || "",
    cores: navigator.hardwareConcurrency || "",
    touch: navigator.maxTouchPoints || 0,
    signed: currentUser() ? 1 : 0,
  };
  queue.push([Date.now(), "session_start", location.pathname, document.title.slice(0, 120), p, sid]);
}

async function refreshToken() {
  // Only once the app has a signed-in user (the auth SDK is then loaded
  // anyway); never load it just for tracking.
  if (!currentUser()) { token = null; return; }
  try {
    const c = await sb();
    const { data } = await c.auth.getSession();
    token = data?.session?.access_token || null;
  } catch { /* keep the last one */ }
}

async function flush(useBeacon = false) {
  if (!queue.length) return;
  const batch = queue.splice(0, 80);
  sent += batch.length;
  if (!useBeacon) await refreshToken();
  const body = JSON.stringify({ v: vid, s: sid, tok: token, e: batch });
  try {
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "text/plain" }));
    } else {
      realFetch(ENDPOINT, { method: "POST", body, keepalive: body.length < 60000, headers: { "Content-Type": "text/plain" } }).catch(() => {});
    }
  } catch {}
  if (queue.length) flush(useBeacon);
}

// ---------------------------------------------------------------------------
// Pages: the app changes pages with history.pushState; each change closes the
// previous page (time it was visible, how far down it was scrolled).
function scrollPct() {
  const h = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
  if (h <= innerHeight + 4) return 100;
  return Math.min(100, Math.round(((scrollY + innerHeight) / h) * 100));
}
function visibleMs() {
  if (!page) return 0;
  return page.visibleMs + (page.visibleSince ? Date.now() - page.visibleSince : 0);
}
function closePage(reason) {
  if (!page) return;
  abandonForms();
  ev("page_leave", reason, { ms: visibleMs(), sd: page.maxScroll, total: Date.now() - page.start }, page.path);
  page = null;
}
function openPage(from) {
  const path = location.pathname;
  page = { path, start: Date.now(), visibleMs: 0, visibleSince: document.hidden ? 0 : Date.now(), maxScroll: scrollPct() };
  // Only the NAMES of query parameters: values can be secrets (reset links).
  const keys = [...new URLSearchParams(location.search).keys()].join(",").slice(0, 120);
  ev("page", document.title.slice(0, 120), { from: from || "", qk: keys, dev: DEV }, path);
}
function onRoute() {
  if (page && page.path === location.pathname) return;
  const from = page?.path || "";
  closePage("nav");
  openPage(from);
}

// ---------------------------------------------------------------------------
// Clicks: what was clicked, where on the page, and repeated angry clicks.
const ACTIONABLE = "a,button,[role=button],[role=tab],[role=menuitem],[role=option],input,select,textarea,label,summary,[data-track],[onclick],[tabindex]";
function labelOf(el) {
  if (!el) return "";
  const d = el.getAttribute?.("data-track") || el.getAttribute?.("aria-label") || el.getAttribute?.("title");
  if (d) return d.trim().slice(0, 80);
  const tag = el.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    return `${tag}:${el.name || el.id || el.getAttribute("placeholder") || el.type || ""}`.slice(0, 80);
  }
  const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  if (t) return t.slice(0, 80);
  const img = el.querySelector?.("img[alt]");
  if (img) return `img:${img.alt}`.slice(0, 80);
  return `${tag}${el.id ? "#" + el.id : ""}${el.classList?.length ? "." + [...el.classList].slice(0, 2).join(".") : ""}`.slice(0, 80);
}
function onClick(e) {
  const raw = e.target instanceof Element ? e.target : null;
  if (!raw) return;
  const el = raw.closest(ACTIONABLE);
  const h = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
  const props = {
    x: Math.round(e.clientX), y: Math.round(e.clientY),
    vw: innerWidth, vh: innerHeight,
    py: Math.round(e.clientY + scrollY), ph: h,
    dev: DEV, tag: (el || raw).tagName.toLowerCase(),
  };
  if (!el) props.dead = 1;
  if (lastSearch && Date.now() - lastSearch.at < 60_000) props.q = lastSearch.q;
  const sect = (el || raw).closest("[id]");
  if (sect && sect.id) props.in = sect.id.slice(0, 40);
  let label = labelOf(el || raw);
  if (el && el.tagName === "A" && el.href) {
    try {
      const u = new URL(el.href);
      if (u.hostname !== location.hostname) {
        ev("outbound", `${u.hostname}${u.pathname}`.slice(0, 200), { text: label.slice(0, 60) });
      } else props.to = u.pathname.slice(0, 120);
    } catch {}
  }
  ev("click", label, props);
  // Rage: three or more clicks within a second, on about the same spot.
  const now = Date.now();
  lastClicks.push({ t: now, x: e.clientX, y: e.clientY });
  while (lastClicks.length && now - lastClicks[0].t > 1000) lastClicks.shift();
  const near = lastClicks.filter((c) => Math.abs(c.x - e.clientX) < 30 && Math.abs(c.y - e.clientY) < 30);
  if (near.length === 3) ev("rage_click", label, { x: props.x, y: props.y, vw: innerWidth, py: props.py, ph: h, dev: DEV });
}

// ---------------------------------------------------------------------------
// Forms: started, time on each field and whether it was filled (never the
// value), submitted, left half done, and the error messages shown to the user.
function formId(f) { return (f.id || f.getAttribute("name") || `form@${location.pathname}`).slice(0, 60); }
function fieldName(el) { return (el.name || el.id || el.getAttribute("placeholder") || el.type || el.tagName).toString().slice(0, 40); }
function onFocusIn(e) {
  const el = e.target;
  if (!(el instanceof HTMLElement) || !el.matches("input,select,textarea")) return;
  fieldStart = { el, at: Date.now() };
  const f = el.form || el.closest("form");
  if (!f) return;
  let st = formsStarted.get(f);
  if (!st) { st = { id: formId(f), submitted: false, lastField: "" }; formsStarted.set(f, st); ev("form_start", st.id); }
  st.lastField = fieldName(el);
}
function onFocusOut(e) {
  const el = e.target;
  if (!fieldStart || fieldStart.el !== el) return;
  const f = el.form || el.closest("form");
  const isSecret = el.type === "password";
  const filled = el.type === "checkbox" || el.type === "radio" ? (el.checked ? 1 : 0) : (String(el.value || "").length > 0 ? 1 : 0);
  ev("field", f ? formId(f) : `field@${location.pathname}`, {
    f: fieldName(el), ms: Date.now() - fieldStart.at, filled,
    len: isSecret ? undefined : Math.min(String(el.value || "").length, 500),
  });
  fieldStart = null;
}
function onSubmit(e) {
  const f = e.target;
  if (!(f instanceof HTMLFormElement)) return;
  const st = formsStarted.get(f) || { id: formId(f), submitted: false, lastField: "" };
  st.submitted = true;
  formsStarted.set(f, st);
  ev("form_submit", st.id, { last: st.lastField });
}
// The browser's own "please fill in this field" bubbles block the submit
// before any script sees it; record them as form errors too.
function onInvalid(e) {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  const f = el.form || el.closest("form");
  const key = `${f ? formId(f) : ""}|${fieldName(el)}`;
  if (Date.now() - (alertSeen.get(key) || 0) < 3000) return;
  alertSeen.set(key, Date.now());
  ev("form_error", f ? formId(f) : `field@${location.pathname}`, { msg: `${fieldName(el)}: ${(el.validationMessage || "invalid").slice(0, 120)}`, f: fieldName(el), native: 1 });
}
function abandonForms() {
  document.querySelectorAll("form").forEach((f) => {
    const st = formsStarted.get(f);
    if (st && !st.submitted && !st.abandoned) { st.abandoned = true; ev("form_abandon", st.id, { last: st.lastField }); }
  });
}
function watchMessages() {
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.classList.contains("toast")) {
          const k = ["error", "success", "warning", "info"].find((c) => n.classList.contains(c)) || "info";
          ev("toast", (n.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160), { k });
        }
      }
      const host = (m.target instanceof Element ? m.target : m.target.parentElement)?.closest?.("[role=alert]");
      if (host) {
        const msg = (host.innerText || "").replace(/\s+/g, " ").trim();
        if (!msg) continue;
        const key = host.id + "|" + msg;
        if (Date.now() - (alertSeen.get(key) || 0) < 3000) continue;
        alertSeen.set(key, Date.now());
        const f = host.closest("form");
        ev("form_error", f ? formId(f) : (host.id || `alert@${location.pathname}`), { msg: msg.slice(0, 160) });
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
}

// ---------------------------------------------------------------------------
// Searches: the text searched and how many results it found.
const searchTimers = new WeakMap();
function isSearchInput(el) {
  return el instanceof HTMLInputElement && (el.type === "search" || /search|cmdk|query/i.test(el.id || el.name || ""));
}
function resultCount(el, q) {
  if (el.id === "stocks-search") {
    // Enter on a sure match ("tcs") opens that stock, so by the time this
    // runs the grid is gone; counting it gave 0 and logged real hits as
    // "found nothing". Only count a grid that was rendered for this query.
    const host = document.querySelector("#stocks-grid-host");
    if (!host || host.dataset.q !== q) return null;
    if (host.querySelector(".empty-state")) return 0;
    const total = host.dataset.total;
    if (total != null && total !== "") return Number(total);
    return host.querySelectorAll(".stocks-grid > *").length;
  }
  const list = el.closest("[role=dialog], .cmdk, .modal, form, header, section")?.querySelectorAll("[role=option], .cmdk-item, .search-result, li a");
  return list ? list.length : null;
}
function logSearch(el, how) {
  const q = String(el.value || "").trim();
  if (!q || q.length > 120) return;
  if (lastSearch && lastSearch.q === q && Date.now() - lastSearch.at < 5000) return;
  lastSearch = { q, at: Date.now() };
  setTimeout(() => {
    const res = resultCount(el, q);
    ev("search", q, { in: (el.id || el.name || "search").slice(0, 40), res: res == null ? "" : res, how });
  }, 400);
}
function onInput(e) {
  const el = e.target;
  if (!isSearchInput(el)) return;
  clearTimeout(searchTimers.get(el));
  searchTimers.set(el, setTimeout(() => logSearch(el, "typed"), 1200));
}
function onKeyDown(e) {
  if (e.key === "Enter" && isSearchInput(e.target)) { clearTimeout(searchTimers.get(e.target)); logSearch(e.target, "enter"); }
}

// ---------------------------------------------------------------------------
// Errors students hit: script errors, failed promises, files that did not load.
// Ad and analytics scripts that ad blockers stop, plus errors browser
// extensions throw into the page, are not faults in the app: they made up
// 50 of 78 errors on 18 Oct 2026 and buried the real ones.
const BLOCKED_HOSTS = /(^|\.)(clarity\.ms|googletagmanager\.com|google-analytics\.com|googlesyndication\.com|adtrafficquality\.google|doubleclick\.net)$/;
const EXTENSION_NOISE = /window\.ethereum|chrome: call method|ResizeObserver loop/;
function onError(e) {
  const t = e.target;
  if (t && t !== window && (t.src || t.href)) {
    let u = t.src || t.href;
    try {
      const x = new URL(u);
      if (BLOCKED_HOSTS.test(x.hostname)) return;
      u = x.hostname === location.hostname ? x.pathname : x.hostname + x.pathname;
    } catch {}
    return logError(`load failed: ${t.tagName.toLowerCase()} ${u}`.slice(0, 200), {});
  }
  const m = String(e.message || "");
  // "Script error." with no file is a cross-origin script (ads, extensions)
  // hiding its details; there is nothing in it to act on.
  if (EXTENSION_NOISE.test(m) || (m === "Script error." && !e.filename)) return;
  let src = e.filename || "";
  try { src = new URL(src).pathname; } catch {}
  logError(String(e.message || "error").slice(0, 200), { src: `${src}:${e.lineno || 0}:${e.colno || 0}`.slice(0, 120), st: String(e.error?.stack || "").slice(0, 600) });
}
function onRejection(e) {
  const r = e.reason;
  if (EXTENSION_NOISE.test(String(r?.message || r || ""))) return;
  logError(`unhandled: ${String(r?.message || r || "rejection")}`.slice(0, 200), { st: String(r?.stack || "").slice(0, 600) });
}
function logError(msg, props) {
  const n = (errSeen.get(msg) || 0) + 1;
  errSeen.set(msg, n);
  if (n > 3) return;
  ev("error", msg, { ...props, br: BR, os: OS, dev: DEV, n });
}

// Requests: every failed or slow call to our API or the database.
const realFetch = window.fetch.bind(window);
function apiLabel(u) {
  try {
    const x = new URL(u, location.href);
    if (x.hostname === location.hostname && x.pathname.startsWith("/api/")) {
      const op = x.searchParams.get("op");
      return op ? `${x.pathname}?op=${op}` : x.pathname;
    }
    if (/supabase\.co$/.test(x.hostname)) return `db ${x.pathname.replace(/^\/rest\/v1/, "").slice(0, 80)}`;
  } catch {}
  return null;
}
function wrapFetch() {
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const label = url ? apiLabel(url) : null;
    if (!label || label.includes("op=ev")) return realFetch(input, init);
    const t0 = performance.now();
    return realFetch(input, init).then((r) => {
      const ms = Math.round(performance.now() - t0);
      if (!r.ok || ms > 2500) ev("api", label, { st: r.status, ms, m: (init?.method || "GET").toUpperCase() });
      return r;
    }, (err) => {
      if (err?.name !== "AbortError") ev("api", label, { st: 0, ms: Math.round(performance.now() - t0), err: String(err?.message || err).slice(0, 80) });
      throw err;
    });
  };
}

// Page speed on the student's own device, for the first page of the visit.
const perf = { lcp: 0, cls: 0, inp: 0 };
let perfSent = false;
function watchPerf() {
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) perf.lcp = Math.round(e.startTime); }).observe({ type: "largest-contentful-paint", buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) perf.cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) perf.inp = Math.max(perf.inp, Math.round(e.duration)); }).observe({ type: "event", buffered: true, durationThreshold: 40 }); } catch {}
}
function sendPerf() {
  if (perfSent) return;
  perfSent = true;
  const nav = performance.getEntriesByType("navigation")[0];
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  ev("perf", null, {
    ttfb: nav ? Math.round(nav.responseStart) : "",
    fcp: fcp ? Math.round(fcp.startTime) : "",
    lcp: perf.lcp || "", cls: Math.round(perf.cls * 1000) / 1000, inp: perf.inp || "",
    dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : "",
    load: nav ? Math.round(nav.loadEventEnd) : "",
    dev: DEV, net: navigator.connection?.effectiveType || "",
  }, perfPath);
}
let perfPath = location.pathname;

// ---------------------------------------------------------------------------
export function startTelemetry() {
  if (started || navigator.webdriver) return;
  started = true;
  vid = lsGet(VID_KEY);
  if (!vid || !/^[A-Za-z0-9_-]{8,40}$/.test(vid)) { vid = rnd(); lsSet(VID_KEY, vid); }
  const fresh = session();
  perfPath = location.pathname;
  if (fresh) startSession();

  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function (...a) { const r = orig.apply(this, a); queueMicrotask(onRoute); return r; };
  }
  addEventListener("popstate", onRoute);
  openPage(document.referrer ? "external" : "");

  addEventListener("scroll", () => {
    if (!page) return;
    const p = scrollPct();
    if (p > page.maxScroll) page.maxScroll = p;
  }, { passive: true });

  document.addEventListener("click", onClick, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("invalid", onInvalid, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("copy", () => {
    const sel = String(getSelection?.() || "");
    ev("copy", labelOf(getSelection?.()?.anchorNode?.parentElement), { len: sel.length });
  }, true);
  addEventListener("error", onError, true);
  addEventListener("unhandledrejection", onRejection);
  addEventListener("online", () => ev("net", "online"));
  addEventListener("offline", () => ev("net", "offline"));
  addEventListener("beforeinstallprompt", () => ev("install", "prompt shown"));
  addEventListener("appinstalled", () => ev("install", "installed"));
  wrapFetch();
  watchPerf();
  if (document.body) watchMessages(); else addEventListener("DOMContentLoaded", watchMessages, { once: true });

  document.addEventListener("visibilitychange", () => {
    if (!page) return;
    if (document.hidden) {
      page.visibleMs += page.visibleSince ? Date.now() - page.visibleSince : 0;
      page.visibleSince = 0;
      sendPerf();
      flush(true);
    } else {
      page.visibleSince = Date.now();
      if (session()) startSession();
    }
  });
  addEventListener("pagehide", () => { sendPerf(); closePage("exit"); flush(true); });
  setTimeout(sendPerf, 20_000);
  setInterval(() => { if (!document.hidden) flush(); }, FLUSH_MS);
}
