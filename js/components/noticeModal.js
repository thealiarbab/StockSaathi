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

let _shown = false;

/**
 * Fetch unseen notices for the logged-in user and show them one at a time.
 * Safe to call on every boot — returns immediately when there is nothing
 * to show, and never throws into the caller.
 */
export async function showPendingNotices() {
  if (_shown) return;
  _shown = true;
  try {
    const client = await sb();
    if (!client) return;
    // RLS scopes this to the current user; an unauthenticated tab gets [].
    const { data, error } = await client
      .from("user_notices")
      .select("id,kind,title,body,payload,created_at")
      .is("seen_at", null)
      .order("created_at", { ascending: true })
      .limit(5);
    if (error || !data?.length) return;
    for (const notice of data) {
      await presentOne(client, notice);
    }
  } catch (e) {
    console.warn("[notices] skipped:", e?.message || e);
  }
}

function presentOne(client, notice) {
  return new Promise((resolve) => {
    const modalRoot = document.getElementById("modal-root");
    if (!modalRoot) return resolve();

    const paras = String(notice.body || "")
      .split(/\n\s*\n/)
      .map((p) => `<p>${escapeHtml(p.trim())}</p>`)
      .join("");

    const orders = Array.isArray(notice.payload?.orders) ? notice.payload.orders : [];
    const table = orders.length
      ? `<div class="notice-orders">
           ${orders.map((o) => `
             <div class="notice-order-row">
               <span class="pill ${o.side === "BUY" ? "pill-green" : "pill-red"}">${escapeHtml(o.side)}</span>
               <strong>${escapeHtml(o.symbol)}</strong>
               <span class="dim">${escapeHtml(fmtQty(o.qty))} @ ₹${escapeHtml(fmtPrice(o.price_inr))}</span>
               <span class="dim" style="margin-left:auto;">${
                 o.outcome === "filled"
                   ? `filled · was stuck ${escapeHtml(String(o.days_stuck))}d`
                   : "cancelled"
               }</span>
             </div>`).join("")}
         </div>`
      : "";

    const prevFocus = document.activeElement;
    modalRoot.innerHTML = `
      <div class="modal-overlay" id="notice-overlay" role="dialog" aria-modal="true" aria-labelledby="notice-title" tabindex="-1">
        <div class="modal" role="document">
          <div class="modal-head">
            <div class="modal-icon info" aria-hidden="true">✉</div>
            <div>
              <div class="modal-kicker">A note from the person who built this</div>
              <h2 id="notice-title">${escapeHtml(notice.title || "A quick note")}</h2>
            </div>
          </div>
          <div class="modal-body">${paras}${table}</div>
          <div class="modal-foot">
            <button class="btn btn-primary" id="notice-ok">Got it</button>
          </div>
        </div>
      </div>
    `;

    const overlay = modalRoot.querySelector("#notice-overlay");
    const okBtn = modalRoot.querySelector("#notice-ok");
    okBtn?.focus();

    let done = false;
    const close = async () => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      modalRoot.innerHTML = "";
      try { prevFocus?.focus?.(); } catch {}
      // Best-effort ack. If it fails the notice simply reappears next boot,
      // which is the right failure direction for an apology.
      try { await client.rpc("ack_notice", { p_notice_id: notice.id }); }
      catch (e) { console.warn("[notices] ack failed:", e?.message || e); }
      resolve();
    };

    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      // Focus trap — only one button, so keep Tab on it.
      if (e.key === "Tab") { e.preventDefault(); okBtn?.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    okBtn?.addEventListener("click", close);
    overlay?.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  });
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
