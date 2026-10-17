// =============================================================================
// NOTICE MODAL — delivers a personal message from the maintainer to one user.
//
// Built for the 2026-09-13 order-backfill apology: 24 users had orders stuck
// in the queue (one for 128 days) because execution only ever ran inside their
// own browser tab. Each affected user gets a notice naming their actual
// orders and what was done about them.
//
// Rows live in public.user_notices (RLS: you can only read your own). The
// modal shows the oldest unseen notice, marks it seen via the ack_notice RPC,
// and moves to the next one. Nothing is ever shown twice.
//
// Deliberately NOT a toast: a toast auto-dismisses and would be missed by
// exactly the users who are owed the apology.
// =============================================================================

import { sb } from "../db/supabase.js";
import { presentWhatsNew } from "./whatsNew.js";

// Guard state.
//
// The first version latched a single module-level `_shown = true` on the very
// first call. That call happens 1.2s after page load — which for most people
// is while they are still LOGGED OUT, staring at the login form. It found
// nothing (correctly, RLS returns no rows for anon), latched, and then logging
// in never re-ran it, because login navigates via the hash router and never
// reloads the page. Net effect: the people the apology was written for could
// only ever see it by hard-reloading while already signed in.
//
// Now: `_inFlight` only prevents two overlapping runs, and `_doneForUser`
// records the user id we actually finished a pass for. A different user (or
// going from logged-out to logged-in) gets a fresh pass.
let _inFlight = false;
let _doneForUser = null;

/**
 * Fetch unseen notices for the logged-in user and show them one at a time.
 * Safe to call repeatedly — on boot, after login, on user switch. Returns
 * immediately when there is nothing to show, and never throws into the caller.
 */
// Never on a sign-in or setup screen: a card over the login form reads as
// "you're logged out". Wait for the first real page instead.
const AUTH_PAGE = /^\/(login|register|reset-password(-request)?|onboarding)\/?$/;
let _waitingForPage = false;

export async function showPendingNotices() {
  if (AUTH_PAGE.test(location.pathname)) {
    if (!_waitingForPage) {
      _waitingForPage = true;
      const retry = () => {
        if (AUTH_PAGE.test(location.pathname)) return;
        window.removeEventListener("ss:navigate", retry);
        window.removeEventListener("popstate", retry);
        _waitingForPage = false;
        setTimeout(() => { showPendingNotices(); }, 600);
      };
      window.addEventListener("ss:navigate", retry);
      window.addEventListener("popstate", retry);
    }
    return;
  }
  // ?whatsnew=preview shows the current release card without touching the
  // database, so it can be reviewed any number of times.
  if (new URLSearchParams(location.search).get("whatsnew") === "preview") {
    previewNotice({ kind: "whats_new", title: "", body: "", payload: {} });
    return;
  }
  if (_inFlight) return;
  _inFlight = true;
  try {
    const client = await sb();
    if (!client) return;
    // Who are we? No session means nothing to show AND nothing to latch —
    // the user may be about to log in.
    let uid = null;
    try {
      const raw = localStorage.getItem("ss.sb.session.v1");
      uid = raw ? (JSON.parse(raw)?.user?.id ?? null) : null;
    } catch { uid = null; }
    if (!uid) return;
    if (_doneForUser === uid) return;
    // RLS scopes this to the current user; an unauthenticated tab gets [].
    const { data, error } = await client
      .from("user_notices")
      .select("id,kind,title,body,payload,created_at")
      .is("seen_at", null)
      .order("created_at", { ascending: true })
      .limit(5);
    // A query error is NOT a reason to latch — we still don't know whether
    // this user has something waiting. Only a clean result counts as done.
    if (error) {
      console.warn("[notices] query failed:", error.message);
      return;
    }
    _doneForUser = uid;
    if (!data?.length) return;
    for (let i = 0; i < data.length; i++) {
      await presentOne(client, data[i], i, data.length);
    }
  } catch (e) {
    console.warn("[notices] skipped:", e?.message || e);
  } finally {
    _inFlight = false;
  }
}

// Look per notice kind: accent colour, header icon and kicker line.
const THEMES = {
  order_cancelled: { tone: "warn", icon: "cross", kicker: "About your orders" },
  order_expiring:  { tone: "time", icon: "clock", kicker: "About your orders" },
  order_expired:   { tone: "time", icon: "clock", kicker: "About your orders" },
  order_filled:    { tone: "good", icon: "check", kicker: "About your orders" },
  order_allotted:  { tone: "good", icon: "check", kicker: "About your orders" },
};
const DEFAULT_THEME = { tone: "info", icon: "mail", kicker: "A note from the person who built this" };

const ICONS = {
  cross: `<path d="M8 8l8 8M16 8l-8 8"/>`,
  check: `<path d="M6.5 12.5l3.5 3.5 7.5-8"/>`,
  clock: `<circle cx="12" cy="12" r="7.5"/><path d="M12 8v4.5l3 2"/>`,
  mail:  `<rect x="4" y="6.5" width="16" height="11" rx="2"/><path d="M4.5 7.5l7.5 5.5 7.5-5.5"/>`,
};

const OUTCOME_LABEL = {
  filled: "filled", cancelled: "cancelled", expiring: "expires soon",
  expired: "expired", allotted: "allotted",
};

function rowsHtml(list, startIndex = 0) {
  return list.map((o, i) => {
    const note = o.note || (o.outcome === "filled" && o.days_stuck != null
      ? `filled · was stuck ${o.days_stuck}d`
      : OUTCOME_LABEL[o.outcome] || "");
    const price = o.price_inr ?? o.fill_inr;
    const good = o.outcome === "filled" || o.outcome === "allotted";
    return `
      <div class="notice-order-row" style="--i:${startIndex + i}">
        ${o.side ? `<span class="pill ${o.side === "BUY" ? "pill-green" : "pill-red"}">${escapeHtml(o.side)}</span>` : ""}
        <strong>${escapeHtml(o.symbol)}</strong>
        <span class="dim">${o.qty != null ? escapeHtml(fmtQty(o.qty)) : ""}${price != null ? ` @ ₹${escapeHtml(fmtPrice(price))}` : ""}</span>
        ${note ? `<span class="notice-row-note${good ? " positive" : ""}">${escapeHtml(note)}</span>` : ""}
      </div>`;
  }).join("");
}

function presentOne(client, notice, index = 0, total = 1) {
  // Release cards have their own look (the term explainer's card).
  if (notice.kind === "whats_new") return presentWhatsNew(client, notice);
  return new Promise((resolve) => {
    const modalRoot = document.getElementById("modal-root");
    if (!modalRoot) return resolve();
    const theme = THEMES[notice.kind] || DEFAULT_THEME;

    const paras = String(notice.body || "")
      .split(/\n\s*\n/)
      .map((p) => `<p>${escapeHtml(p.trim())}</p>`)
      .join("");

    const orders = Array.isArray(notice.payload?.orders) ? notice.payload.orders : [];
    // 2026-09-27 remediation notices carry `items` instead: orders filled
    // late (with when the market actually reached the user's price) and buys
    // re-priced after the Yahoo frozen-price bug (paid vs real, cash back).
    const items = Array.isArray(notice.payload?.items) ? notice.payload.items : [];
    const fills = items.filter((i) => i.kind === "late_fill");
    const fixes = items.filter((i) => i.kind === "reprice");
    const refund = Number(notice.payload?.refund_total_inr) || 0;
    let row = 0;
    const fillsHtml = fills.length ? `
        <div class="notice-section-label">Orders we filled for you</div>
        <div class="notice-orders">${rowsHtml(fills.map((o) => ({
          side: o.side, symbol: o.symbol, qty: o.qty, price_inr: o.fill_inr,
          outcome: "filled", note: `market hit your price ${o.hit_at || ""}`.trim(),
        })), row)}</div>` : "";
    row += fills.length;
    const fixesHtml = fixes.length ? `
        <div class="notice-section-label">Prices we corrected</div>
        <div class="notice-orders">
          ${fixes.map((o, i) => `
            <div class="notice-order-row" style="--i:${row + i}">
              <strong>${escapeHtml(o.symbol)}</strong>
              <span class="dim">${escapeHtml(fmtQty(o.qty))} shares · paid <s>₹${escapeHtml(fmtPrice(o.paid_inr))}</s> → real ₹${escapeHtml(fmtPrice(o.real_inr))}</span>
              <span class="notice-row-note positive">+₹${escapeHtml(fmtPrice(o.refund_inr))}</span>
            </div>`).join("")}
        </div>` : "";
    row += fixes.length;
    const ordersHtml = orders.length
      ? `<div class="notice-orders">${rowsHtml(orders, row)}</div>` : "";
    const refundHtml = refund > 0 ? `
        <div class="notice-refund">
          <span class="notice-refund-amt" data-count-to="${refund}">+₹${escapeHtml(fmtPrice(refund))}</span>
          <span>back in your cash</span>
        </div>` : "";
    // Only in-app paths: a notice must never send anyone off-site.
    const cta = notice.payload?.cta && /^\/[\w\-/]*$/.test(notice.payload.cta.href || "")
      ? notice.payload.cta : null;
    const dots = total > 1
      ? `<div class="notice-steps" aria-label="Message ${index + 1} of ${total}">${
          Array.from({ length: total }, (_, i) => `<span class="${i === index ? "on" : i < index ? "done" : ""}"></span>`).join("")
        }</div>` : "";

    const prevFocus = document.activeElement;
    modalRoot.innerHTML = `
      <div class="modal-overlay notice-overlay" id="notice-overlay" role="dialog" aria-modal="true" aria-labelledby="notice-title" tabindex="-1">
        <div class="modal notice-card notice-${theme.tone}" role="document">
          <div class="notice-hero" aria-hidden="true">
            <span class="notice-glow"></span>
            <span class="notice-ring"></span>
            <svg class="notice-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[theme.icon]}</svg>
          </div>
          <div class="notice-head">
            <div class="modal-kicker">${escapeHtml(theme.kicker)}</div>
            <h2 id="notice-title">${escapeHtml(notice.title || "A quick note")}</h2>
          </div>
          <div class="modal-body notice-body">${paras}${refundHtml}${fillsHtml}${fixesHtml}${ordersHtml}${notice.payload?.signoff ? `<p class="notice-signoff">${escapeHtml(notice.payload.signoff)}</p>` : ""}</div>
          <div class="modal-foot notice-foot">
            ${dots}
            ${cta ? `<a class="btn btn-outline" id="notice-cta" href="${escapeHtml(cta.href)}">${escapeHtml(cta.label || "Open")}</a>` : ""}
            <button class="btn btn-primary notice-ok" id="notice-ok">${index + 1 < total ? "Next" : "Got it"}</button>
          </div>
        </div>
      </div>
    `;

    const overlay = modalRoot.querySelector("#notice-overlay");
    const okBtn = modalRoot.querySelector("#notice-ok");
    const ctaBtn = modalRoot.querySelector("#notice-cta");
    okBtn?.focus();
    countUp(modalRoot.querySelector("[data-count-to]"));

    let done = false;
    const close = async () => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      // Let the exit animation play; skip it when motion is reduced.
      if (!reducedMotion()) {
        overlay?.classList.add("leaving");
        await new Promise((r) => setTimeout(r, 220));
      }
      modalRoot.innerHTML = "";
      try { prevFocus?.focus?.(); } catch {}
      // Best-effort ack. If it fails the notice simply reappears next boot,
      // which is the right failure direction for an apology.
      try { await client.rpc("ack_notice", { p_notice_id: notice.id }); }
      catch (e) { console.warn("[notices] ack failed:", e?.message || e); }
      resolve();
    };

    const focusables = [ctaBtn, okBtn].filter(Boolean);
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (e.key === "Tab") {
        e.preventDefault();
        const i = focusables.indexOf(document.activeElement);
        focusables[(i + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length]?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    okBtn?.addEventListener("click", close);
    ctaBtn?.addEventListener("click", () => { close(); });
    overlay?.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  });
}

function reducedMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

// Refund amount ticks up from zero once the card has landed.
function countUp(el) {
  const target = Number(el?.dataset?.countTo);
  if (!el || !(target > 0) || reducedMotion()) return;
  const start = performance.now() + 380;
  const dur = 900;
  const step = (now) => {
    const t = Math.min(1, Math.max(0, (now - start) / dur));
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = `+₹${fmtPrice(target * eased)}`;
    if (t < 1) requestAnimationFrame(step);
  };
  el.textContent = "+₹0.00";
  requestAnimationFrame(step);
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}

// jsonb numerics arrive stripped of trailing zeros, so 401.90 came back as
// 401.9 and rendered as "₹401.9" next to a correctly-formatted "₹706.65".
// Money always gets two decimals.
function fmtPrice(v) {
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(v ?? "");
}

// Quantities are fractional only for mutual funds; show decimals just when
// they exist, so "12" stays "12" and 37.0096 units stays precise.
function fmtQty(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "");
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

// Render a notice without a database row (design checks from the console:
// `(await import("/js/components/noticeModal.js")).previewNotice({...})`).
// Acknowledging it does nothing.
export function previewNotice(notice, index = 0, total = 1) {
  return presentOne({ rpc: async () => ({}) }, { id: "preview", ...notice }, index, total);
}
