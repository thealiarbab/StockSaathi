// =============================================================================
// FRIENDS & TRANSFERS — Send virtual money between StockSaathi accounts,
// manage friend list, generate shareable transfer codes.
// =============================================================================

import { getState, subscribe } from "../state.js";
import { formatRupees, rupeesToPaise } from "../money.js";
import { sendTransfer, createTransferCode, redeemTransferCode, addFriend, removeFriend, searchUsers } from "../features/transfers.js";
import { toast } from "../components/toast.js";

let tab = "send";   // send | codes | history

export function renderFriends(main) {
  render();
  const unsub = subscribe(render);
  window.addEventListener("ss:navigate", () => unsub?.(), { once: true });

  function render() {
    const state = getState();
    main.innerHTML = `
      <div style="margin-bottom: var(--sp-5);">
        <h1>Friends & Transfers</h1>
        <p class="muted">Send virtual cash to other StockSaathi users. Useful for class competitions, challenges, or splitting a project pot.</p>
      </div>

      <div class="lb-tabs" style="margin-bottom: var(--sp-5);">
        <button class="lb-tab ${tab === "send" ? "active" : ""}" data-tab="send">Send</button>
        <button class="lb-tab ${tab === "codes" ? "active" : ""}" data-tab="codes">Transfer codes</button>
        <button class="lb-tab ${tab === "history" ? "active" : ""}" data-tab="history">History</button>
        <button class="lb-tab ${tab === "friends" ? "active" : ""}" data-tab="friends">Friends (${state.friends.length})</button>
      </div>

      <div id="tab-body"></div>
    `;

    main.querySelectorAll("[data-tab]").forEach(btn => {
      btn.addEventListener("click", () => { tab = btn.dataset.tab; render(); });
    });

    const body = main.querySelector("#tab-body");
    if (tab === "send") renderSend(body, state);
    else if (tab === "codes") renderCodes(body, state);
    else if (tab === "history") renderHistory(body, state);
    else renderFriendsList(body, state);
  }
}

// ----- SEND tab ---------------------------------------------------------
function renderSend(body, state) {
  body.innerHTML = `
    <div class="grid" style="grid-template-columns: 1fr; gap: var(--sp-4);">
      <div class="card">
        <div class="card-head">
          <h3>Send to a StockSaathi user</h3>
          <span class="pill pill-neutral">Cash: ${formatRupees(state.portfolio.cashPaise, { compact: true })}</span>
        </div>
        <div class="flex-col gap-3" style="max-width: 520px;">
          <div>
            <label class="label" for="send-handle">Recipient (@username)</label>
            <input class="input" id="send-handle" placeholder="e.g. @priya or priya_s" autocomplete="off" />
            <div id="user-results" style="margin-top: 6px;"></div>
          </div>
          <div>
            <label class="label" for="send-amount">Amount (₹)</label>
            <div class="input-prefix">
              <span class="px">₹</span>
              <input type="number" id="send-amount" min="1" step="1" placeholder="e.g. 500" />
            </div>
          </div>
          <div>
            <label class="label" for="send-note">Note (optional)</label>
            <input class="input" id="send-note" placeholder="e.g. 'Winning from last week's challenge'" maxlength="100" />
          </div>
          <div class="flex gap-2 wrap" style="margin-top: var(--sp-2);">
            <button class="btn btn-primary" id="send-btn">Send now</button>
            <button class="btn btn-ghost" id="send-quick-100">₹100</button>
            <button class="btn btn-ghost" id="send-quick-500">₹500</button>
            <button class="btn btn-ghost" id="send-quick-1000">₹1,000</button>
          </div>
          <div id="send-msg"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Quick pick from your friends</h3></div>
        ${state.friends.length
          ? `<div class="flex gap-2 wrap">${state.friends.filter(f => f.username).map(f => `
              <button class="btn btn-ghost btn-sm friend-pick" data-handle="${escapeAttr(f.username)}">@${escapeHtml(f.username)}</button>
            `).join("")}</div>`
          : `<p class="muted" style="font-size: var(--text-sm);">You haven't added any friends yet. Switch to the Friends tab to add some.</p>`
        }
      </div>
    </div>
  `;

  const handleInput = body.querySelector("#send-handle");
  const amountInput = body.querySelector("#send-amount");
  const noteInput = body.querySelector("#send-note");
  const msg = body.querySelector("#send-msg");
  const results = body.querySelector("#user-results");

  let searchTimer = null;
  let searchSeq = 0;
  handleInput.addEventListener("input", () => {
    const q = handleInput.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (q.length < 2) { results.innerHTML = ""; return; }
    // Debounce: 220ms after the last keystroke. Also track a sequence so a
    // slow in-flight search for "an" can't overwrite the newer "ana" result.
    const mySeq = ++searchSeq;
    searchTimer = setTimeout(async () => {
      let found = [];
      try { found = await searchUsers(q.replace(/^@/, "")); } catch { found = []; }
      if (mySeq !== searchSeq) return;   // stale response, discard
      if (!Array.isArray(found)) found = [];
      results.innerHTML = found.map(u => `
        <button class="btn btn-ghost btn-sm" data-pick="${escapeAttr(u.username)}" style="margin-right: 6px; margin-top: 4px;">@${escapeHtml(u.username)} · ${escapeHtml(u.displayName || u.username)}</button>
      `).join("");
      results.querySelectorAll("[data-pick]").forEach(btn => {
        btn.addEventListener("click", () => {
          handleInput.value = "@" + btn.dataset.pick;
          results.innerHTML = "";
        });
      });
    }, 220);
  });

  body.querySelectorAll(".friend-pick").forEach(btn => {
    btn.addEventListener("click", () => { handleInput.value = "@" + btn.dataset.handle; });
  });

  body.querySelector("#send-quick-100").addEventListener("click", () => amountInput.value = 100);
  body.querySelector("#send-quick-500").addEventListener("click", () => amountInput.value = 500);
  body.querySelector("#send-quick-1000").addEventListener("click", () => amountInput.value = 1000);

  body.querySelector("#send-btn").addEventListener("click", async () => {
    msg.innerHTML = "";
    const handle = handleInput.value.trim().replace(/^@/, "");
    const amount = parseFloat(amountInput.value);
    const note = noteInput.value.trim();
    if (!handle) return showErr(msg, "Enter a recipient.");
    if (!Number.isFinite(amount) || amount <= 0) return showErr(msg, "Enter a valid amount.");

    const btn = body.querySelector("#send-btn");
    btn.disabled = true;
    const origLabel = btn.textContent;
    btn.textContent = "Sending…";
    try {
      const res = await sendTransfer({ recipientHandle: handle, amountPaise: rupeesToPaise(amount), note });
      const who = res?.recipient?.displayName || res?.recipient?.username || handle;
      toast({ kind: "success", message: `Sent ${formatRupees(res.amountPaise)} to ${who}` });
      handleInput.value = ""; amountInput.value = ""; noteInput.value = "";
      msg.innerHTML = `<div class="success-msg">Transfer complete.</div>`;
    } catch (e) {
      showErr(msg, e.message || "Transfer failed.");
    } finally {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  });
}

// ----- CODES tab --------------------------------------------------------
function renderCodes(body, state) {
  const pending = state.transfers.filter(t => t.direction === "out" && t.status === "pending" && t.code);
  body.innerHTML = `
    <div class="grid" style="grid-template-columns: 1fr; gap: var(--sp-4);">
      <div class="card">
        <h3 style="margin-bottom: var(--sp-3);">Generate a transfer code</h3>
        <p class="muted text-sm" style="margin-bottom: var(--sp-4);">
          Create a one-time code your friend can redeem on their device. Funds are deducted
          from your cash immediately and held as pending until redeemed.
        </p>
        <div class="flex-col gap-3" style="max-width: 520px;">
          <div>
            <label class="label" for="code-amount">Amount (₹)</label>
            <div class="input-prefix">
              <span class="px">₹</span>
              <input type="number" id="code-amount" min="1" step="1" placeholder="e.g. 500" />
            </div>
          </div>
          <div>
            <label class="label" for="code-note">Note (optional)</label>
            <input class="input" id="code-note" maxlength="100" />
          </div>
          <button class="btn btn-primary" id="code-gen-btn" style="width: fit-content;">Generate code</button>
          <div id="code-result"></div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom: var(--sp-3);">Redeem a code</h3>
        <div class="flex gap-2 wrap items-end" style="max-width: 520px;">
          <div class="grow">
            <label class="label" for="redeem-code">Code</label>
            <input class="input" id="redeem-code" style="font-family: var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase;" placeholder="XXXX-XXXX" />
          </div>
          <button class="btn btn-primary" id="redeem-btn">Redeem</button>
        </div>
        <div id="redeem-msg" style="margin-top: var(--sp-3);"></div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Pending codes (${pending.length})</h3></div>
        ${pending.length
          ? `<div class="flex-col gap-2">${pending.map(t => `
              <div class="flex items-center justify-between" style="padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r);">
                <div>
                  <div class="transfer-code">${escapeHtml(t.code)}</div>
                  <div class="muted text-xs" style="margin-top: 4px;">${escapeHtml(t.note || "")}</div>
                </div>
                <div class="num font-bold">${formatRupees(t.amountPaise)}</div>
              </div>`).join("")}
            </div>`
          : `<p class="muted text-sm">No pending codes.</p>`}
      </div>
    </div>
  `;

  body.querySelector("#code-gen-btn").addEventListener("click", async () => {
    const result = body.querySelector("#code-result");
    const amount = parseFloat(body.querySelector("#code-amount").value);
    const note = body.querySelector("#code-note").value.trim();
    if (!Number.isFinite(amount) || amount <= 0) { result.innerHTML = `<div class="error-msg">Enter a valid amount.</div>`; return; }
    try {
      const res = await createTransferCode({ amountPaise: rupeesToPaise(amount), note });
      result.innerHTML = `
        <div class="success-msg" style="display: flex; flex-direction: column; gap: 8px;">
          <div>Code ready. Share it with the recipient:</div>
          <div class="transfer-code">${res.code}</div>
          <div style="font-size: var(--text-xs); color: var(--text-muted);">Amount: ${formatRupees(res.amountPaise)}. Expires if unredeemed.</div>
        </div>
      `;
    } catch (e) { result.innerHTML = `<div class="error-msg">${escapeHtml(e.message || "Failed.")}</div>`; }
  });

  body.querySelector("#redeem-btn").addEventListener("click", async () => {
    const msg = body.querySelector("#redeem-msg");
    const code = body.querySelector("#redeem-code").value.trim().toUpperCase();
    try {
      const res = await redeemTransferCode(code);
      toast({ kind: "success", message: `Received ${formatRupees(res.amountPaise)}` });
      msg.innerHTML = `<div class="success-msg">Code redeemed. ${formatRupees(res.amountPaise)} added to your cash.</div>`;
      body.querySelector("#redeem-code").value = "";
    } catch (e) {
      msg.innerHTML = `<div class="error-msg">${escapeHtml(e.message || "Failed.")}</div>`;
    }
  });
}

// ----- HISTORY tab ------------------------------------------------------
function renderHistory(body, state) {
  const list = state.transfers.slice().reverse();
  if (!list.length) {
    body.innerHTML = `
      <div class="empty-state">
        <span class="emoji">💸</span>
        <h3>No transfers yet</h3>
        <p>When you send or receive cash, it'll appear here.</p>
      </div>
    `;
    return;
  }
  body.innerHTML = `
    <div class="card" style="padding: 0; overflow: hidden;">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>With</th>
              <th>Note</th>
              <th class="num">Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(t => {
              const when = new Date(t.ts);
              // Prefer display_name → username → code → "—". Covers every
              // transfer shape: direct (has counterpartyName), code-pending
              // (has code only), realtime-synced (has counterpartyHandle).
              const who = t.counterpartyName
                ? escapeHtml(t.counterpartyName)
                : (t.counterpartyHandle
                    ? `@${escapeHtml(t.counterpartyHandle)}`
                    : (t.code
                        ? `<span class="transfer-code" style="font-size: 12px; padding: 4px 10px;">${escapeHtml(t.code)}</span>`
                        : "—"));
              return `
                <tr>
                  <td class="dim text-xs">${when.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} ${when.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</td>
                  <td><span class="pill ${t.direction === "in" ? "pill-green" : "pill-red"}">${t.direction === "in" ? "RECEIVED" : "SENT"}</span></td>
                  <td>${who}</td>
                  <td class="muted">${escapeHtml(t.note || "")}</td>
                  <td class="num font-bold ${t.direction === "in" ? "up" : "down"}">${t.direction === "in" ? "+" : "−"}${formatRupees(t.amountPaise)}</td>
                  <td><span class="pill ${t.status === "completed" ? "pill-green" : "pill-yellow"}">${escapeHtml(t.status)}</span></td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ----- FRIENDS LIST tab -------------------------------------------------
function renderFriendsList(body, state) {
  body.innerHTML = `
    <div class="grid" style="grid-template-columns: 1fr; gap: var(--sp-4);">
      <div class="card">
        <h3 style="margin-bottom: var(--sp-3);">Add a friend</h3>
        <div class="flex gap-2 items-end wrap" style="max-width: 520px;">
          <div class="grow">
            <label class="label" for="fr-handle">Their @username</label>
            <input class="input" id="fr-handle" placeholder="@ananya" autocomplete="off" />
          </div>
          <button class="btn btn-primary" id="fr-add">Add</button>
        </div>
        <div id="fr-msg" style="margin-top: var(--sp-3);"></div>
      </div>

      <div class="card">
        <div class="card-head">
          <h3>Your friends (${state.friends.length})</h3>
        </div>
        ${state.friends.length
          ? `<div class="flex-col gap-2">${state.friends.map(f => {
              const name = f.displayName || f.username || "Friend";
              const initials = name.replace(/[^A-Za-z0-9]+/g, "").slice(0, 2).toUpperCase() || "??";
              return `
              <div class="friend-row">
                <div class="friend-avatar ${escapeAttr(f.avatarColor || "green")}">${escapeHtml(initials)}</div>
                <div class="grow">
                  <div class="friend-name">${escapeHtml(name)}</div>
                  <div class="friend-handle">${f.username ? "@" + escapeHtml(f.username) : "<span class=\"dim\">profile unavailable</span>"}</div>
                </div>
                ${f.username ? `<button class="btn btn-ghost btn-sm" data-send="${escapeAttr(f.username)}">Send ₹</button>` : ""}
                <button class="btn btn-ghost btn-sm" data-remove="${escapeAttr(f.id)}">Remove</button>
              </div>
            `;}).join("")}</div>`
          : `<div class="empty-state" style="padding: var(--sp-8);">
              <span class="emoji">👥</span>
              <h3>No friends yet</h3>
              <p>Add your classmates by their username or email to quickly send money or track progress together.</p>
            </div>`
        }
      </div>
    </div>
  `;

  const addBtn = body.querySelector("#fr-add");
  const addHandle = body.querySelector("#fr-handle");
  async function doAddFriend() {
    const msg = body.querySelector("#fr-msg");
    const handle = addHandle.value.trim().replace(/^@/, "");
    if (!handle) return;
    addBtn.disabled = true;
    addBtn.textContent = "Adding…";
    try {
      const res = await addFriend(handle);
      const who = res?.friend?.displayName || res?.friend?.username || handle;
      toast({ kind: "success", message: `Added ${who}` });
      addHandle.value = "";
      msg.innerHTML = "";
    } catch (e) {
      msg.innerHTML = `<div class="error-msg">${escapeHtml(e.message || "Failed.")}</div>`;
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = "Add";
    }
  }
  addBtn.addEventListener("click", doAddFriend);
  addHandle.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doAddFriend(); }
  });

  body.querySelectorAll("[data-remove]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this friend?")) return;
      btn.disabled = true;
      try {
        await removeFriend(btn.dataset.remove);
      } catch (e) {
        toast({ kind: "error", message: e.message || "Remove failed." });
        btn.disabled = false;
      }
    });
  });
  body.querySelectorAll("[data-send]").forEach(btn => {
    btn.addEventListener("click", () => {
      const handle = btn.dataset.send;
      // Switch to Send tab by clicking the existing tab button — reuses the
      // renderFriends closure's render() without tricky event plumbing.
      const sendTabBtn = document.querySelector('[data-tab="send"]');
      sendTabBtn?.click();
      queueMicrotask(() => {
        const el = document.querySelector("#send-handle");
        if (el) { el.value = "@" + handle; el.focus(); }
      });
    });
  });
}

// utils
function showErr(el, msg) { el.innerHTML = `<div class="error-msg">${escapeHtml(msg)}</div>`; }
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
