// =============================================================================
// PUSH ASK — "ping me when it fills", offered right after a waiting order.
//
// 24 Oct: 1,346 fill notices were written since 5 Oct, but 28 of 2,964 new
// users had push on, so nearly every one sat in the bell of a closed app. 70%
// sign up while the market is shut and their first order waits for 9:15: the
// one moment an alert is obviously worth having. Asked there, never on load.
//
// Only when this device could get push and hasn't said yes or no in the
// browser. At most three asks, three days apart: a browser that gets "Block"
// can't ask again, so pestering costs the channel for good.
// =============================================================================

import { track } from "./track.js";
import { toast } from "../components/toast.js";
import { pushSupported, pushState, enablePush, needsHomeScreen } from "./notifications.js";

const KEY = "ss.pushAsk.v1";
const MAX_ASKS = 3;
const GAP_MS = 3 * 86400_000;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function readLog() {
  try { return JSON.parse(localStorage.getItem(KEY)) || { n: 0, t: 0 }; } catch { return { n: 0, t: 0 }; }
}
function writeLog(log) {
  try { localStorage.setItem(KEY, JSON.stringify(log)); } catch {}
}

/**
 * Offer alerts after an order that fills later.
 * @param {{ symbol: string, path: "amo"|"limit"|"mf", when?: string }} o
 *   when: "Mon 9:15 AM" style label of the next open, for AMOs.
 */
export async function offerPushAfterOrder({ symbol, path, when = "" }) {
  try {
    if (!pushSupported() || needsHomeScreen()) return;
    if (Notification.permission !== "default") return;
    const log = readLog();
    if (log.n >= MAX_ASKS || Date.now() - log.t < GAP_MS) return;
    if (await pushState() !== "off") return;
    writeLog({ n: log.n + 1, t: Date.now() });
    const r = await ask({ symbol, path, when });
    // outcome: on | blocked (browser said Block) | off (browser box closed
    // with no answer) | not_now | dismiss (closed our box) | error.
    // ms_to_tap: box shown -> first tap; ms_total: box shown -> final answer.
    track("push_ask", symbol, { outcome: r.outcome, path, n: log.n + 1, ms_to_tap: r.msToTap, ms_total: r.msTotal,
                                perm: typeof Notification !== "undefined" ? Notification.permission : null });
  } catch { /* an alert offer must never break an order */ }
}

function bodyFor({ symbol, path, when }) {
  const s = `<b>${esc(symbol)}</b>`;
  if (path === "amo") return `Your ${s} order waits for the market to open${when ? ` (${esc(when)})` : ""}. Turn on alerts and we'll tell you the moment it fills, even with the app closed.`;
  if (path === "mf") return `Units for ${s} are allotted at the next NAV. Turn on alerts and we'll tell you when they land, even with the app closed.`;
  return `Your ${s} limit fills when the price gets there. Turn on alerts and we'll tell you the moment it does, even with the app closed.`;
}

function ask(o) {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="pa-title">
        <div class="modal" style="max-width: 420px;">
          <div class="modal-head"><div><h2 id="pa-title">Get a ping when it fills?</h2></div></div>
          <div class="modal-body">
            <p style="margin:0 0 var(--sp-2);">${bodyFor(o)}</p>
            <p class="muted text-sm" style="margin:0;">Your orders, a one-line recap after the market closes, and account notes. Nothing between 10 pm and 7 am. Change it any time in Settings.</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" data-pa="no">Not now</button>
            <button class="btn btn-primary" data-pa="yes">Turn on alerts</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);
    const overlay = root.firstElementChild;
    const shownAt = Date.now();
    let tappedAt = null;
    let settled = false;
    // Once "Turn on" is tapped the browser's own permission box is up, and a
    // tap that closes it can land on our overlay. That is not a dismissal:
    // until enablePush answers, only its answer counts. (24 Oct: two people
    // who allowed alerts were logged as "dismiss" this way.)
    let enabling = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      root.remove();
      const now = Date.now();
      resolve({ outcome: v, msToTap: (tappedAt || now) - shownAt, msTotal: now - shownAt });
    };
    const close = (v) => { if (!enabling) done(v); };
    const onKey = (e) => { if (e.key === "Escape") close("dismiss"); };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { tappedAt ??= Date.now(); close("dismiss"); } });
    root.querySelector('[data-pa="no"]').addEventListener("click", () => { tappedAt ??= Date.now(); close("not_now"); });
    root.querySelector('[data-pa="yes"]').addEventListener("click", async (e) => {
      // The permission prompt needs this tap, so it is asked from here.
      tappedAt ??= Date.now();
      enabling = true;
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = "Turning on…";
      let st;
      try { st = await enablePush(["orders", "account", "recap"]); } catch (err) {
        toast({ kind: "error", message: `Couldn't turn on alerts: ${err?.message || err}` });
        enabling = false;
        return done("error");
      }
      enabling = false;
      if (st === "on") toast({ kind: "success", message: "Done. We'll ping you when it fills." });
      done(st);
    });
    setTimeout(() => root.querySelector('[data-pa="yes"]')?.focus(), 50);
  });
}
