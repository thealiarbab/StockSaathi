// =============================================================================
// BELL — the notification inbox in the top bar (owner preview).
//
// The nav re-renders on every state change, so it only leaves a slot
// (#nav-bell-slot) and this module fills it from its own state. The panel is
// attached to <body>, so a nav re-render never closes it. Data and push live
// in features/notifications.js.
// =============================================================================

import { go } from "../navigation.js";
import { toast } from "./toast.js";
import {
  onInbox, loadInbox, markRead, unreadCount, inboxItems,
  pushSupported, pushState, enablePush, needsHomeScreen,
} from "../features/notifications.js";

const ICON_BELL = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
const CAT_ICON = {
  recap: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  orders: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>',
  account: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>',
  achievements: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="6"/><path d="m8.5 14-1.5 8 5-3 5 3-1.5-8"/></svg>',
  coach: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

let _wired = false;
let _panel = null;

/** Fill the nav's slot. Called after every nav render. */
export function mountBell(slot) {
  if (!slot) return;
  const draw = () => {
    const n = unreadCount();
    slot.innerHTML = `<button type="button" class="nav-bell ${n ? "has-unread" : ""}" id="nav-bell" aria-label="Notifications${n ? `, ${n} unread` : ""}" aria-haspopup="dialog" aria-expanded="${!!_panel}">
      ${ICON_BELL}${n ? `<span class="nav-bell-n">${n > 9 ? "9+" : n}</span>` : ""}</button>`;
    slot.querySelector("#nav-bell").addEventListener("click", (e) => { e.stopPropagation(); _panel ? closePanel() : openPanel(); });
  };
  draw();
  slot._unsub?.();
  slot._unsub = onInbox(() => { if (slot.isConnected) draw(); else slot._unsub?.(); if (_panel) drawPanel(); });
  if (!_wired) {
    _wired = true;
    loadInbox();
    // Tapping a push when the service worker could not move the tab itself.
    navigator.serviceWorker?.addEventListener("message", (e) => {
      if (e.data?.type === "ss:open" && typeof e.data.url === "string") go(new URL(e.data.url).pathname);
    });
    // A notification while the app is open: a quiet toast, the bell updates.
    document.addEventListener("ss:notification", (e) => {
      const n = e.detail;
      if (!_panel) toast({ kind: "info", message: n.body ? `${n.title}. ${n.body}` : n.title });
    });
  }
}

function openPanel() {
  _panel = document.createElement("div");
  _panel.className = "nb-wrap";
  _panel.innerHTML = `<div class="nb-panel" role="dialog" aria-label="Notifications"></div>`;
  document.body.appendChild(_panel);
  drawPanel();
  requestAnimationFrame(() => _panel?.classList.add("is-open"));
  setTimeout(() => document.addEventListener("click", outside), 0);
  document.addEventListener("keydown", onEsc);
  window.addEventListener("ss:navigate", closePanel, { once: true });
  document.getElementById("nav-bell")?.setAttribute("aria-expanded", "true");
}
function closePanel() {
  if (!_panel) return;
  const p = _panel;
  _panel = null;
  p.classList.remove("is-open");
  setTimeout(() => p.remove(), 180);
  document.removeEventListener("click", outside);
  document.removeEventListener("keydown", onEsc);
  document.getElementById("nav-bell")?.setAttribute("aria-expanded", "false");
}
const outside = (e) => { if (_panel && !e.target.closest(".nb-panel") && !e.target.closest("#nav-bell")) closePanel(); };
const onEsc = (e) => { if (e.key === "Escape") closePanel(); };

async function drawPanel() {
  if (!_panel) return;
  const box = _panel.querySelector(".nb-panel");
  const items = inboxItems();
  const unread = unreadCount();
  const state = pushSupported() ? await pushState() : "unsupported";
  if (!_panel) return;
  const pushCard = state === "off" ? (needsHomeScreen()
      ? `<div class="nb-push"><b>Get these on your iPhone</b><span>Tap Share, then "Add to Home Screen", and open StockSaathi from there. iPhones only send alerts to apps on the Home Screen.</span></div>`
      : `<div class="nb-push"><b>Get these on your phone</b><span>Know the moment an order fills, even with the app closed. Quiet between 10 pm and 7 am.</span><button type="button" class="nb-btn" data-nb="push">Turn on</button></div>`)
    : state === "blocked" ? `<div class="nb-push is-muted"><span>Notifications are blocked for this site. Allow them in your browser's site settings to get alerts.</span></div>` : "";
  box.innerHTML = `
    <div class="nb-head">
      <h2>Notifications</h2>
      ${unread ? `<button type="button" class="nb-link" data-nb="all">Mark all read</button>` : ""}
      <button type="button" class="nb-x" data-nb="close" aria-label="Close">&times;</button>
    </div>
    ${pushCard}
    <div class="nb-list">
      ${items.length ? items.map((n) => `
        <button type="button" class="nb-item ${n.read_at ? "" : "is-unread"}" data-id="${esc(n.id)}" data-url="${esc(n.url || "")}">
          <span class="nb-ico nb-${esc(n.category)}">${CAT_ICON[n.category] || CAT_ICON.account}</span>
          <span class="nb-text"><b>${esc(n.title)}</b>${n.body ? `<span>${esc(n.body)}</span>` : ""}</span>
          <span class="nb-time">${esc(ago(n.created_at))}</span>
        </button>`).join("") : `<div class="nb-empty"><b>You're all caught up</b><span>Order fills, refunds and other updates show up here.</span></div>`}
    </div>
    <a class="nb-foot" href="/settings#notifications">Notification settings</a>`;
  box.onclick = async (e) => {
    const b = e.target.closest("[data-nb]");
    if (b?.dataset.nb === "close") return closePanel();
    if (b?.dataset.nb === "all") return markRead(null);
    if (b?.dataset.nb === "push") {
      b.disabled = true; b.textContent = "Turning on…";
      try {
        const st = await enablePush();
        toast({ kind: st === "on" ? "success" : "info", message: st === "on" ? "Done. You'll get alerts on this device." : st === "blocked" ? "Notifications are blocked for this site in your browser settings." : "Not turned on." });
      } catch (err) { toast({ kind: "error", message: `Couldn't turn on alerts: ${err?.message || err}` }); }
      drawPanel();
      return;
    }
    const it = e.target.closest(".nb-item");
    if (!it) return;
    if (it.classList.contains("is-unread")) markRead([it.dataset.id]);
    import("../features/openTracking.js").then((m) => m.logNotifOpen(it.dataset.id, "bell")).catch(() => {});
    if (it.dataset.url) { closePanel(); go(it.dataset.url); }
  };
}
