// =============================================================================
// SETTINGS — Theme, API keys, EmailJS config, account management, reset.
// =============================================================================

import { getState, subscribe, setSetting, setSettings, resetCurrentPortfolio, switchUser } from "../state.js";
import { logoutAccount, deleteCurrentAccount, updateProfile, changePassword, currentUser } from "../auth/accounts.js";
import { navigate } from "../router.js";
import { toast } from "../components/toast.js";

export function renderSettings(main) {
  render();
  const unsub = subscribe(render);
  window.addEventListener("ss:navigate", () => unsub?.(), { once: true });

  function render() {
    const state = getState();
    const user = currentUser();
    main.innerHTML = `
      <div style="max-width: 760px; margin: 0 auto;">
        <h1>Settings</h1>
        <p class="muted" style="margin: var(--sp-2) 0 var(--sp-5);">Control how StockSaathi looks, what data it uses, and your account.</p>

        <div class="card">
          <h3 style="margin-bottom: var(--sp-4);">Account</h3>
          ${user ? renderAccountSection(user, state) : `<p class="muted">Not logged in.</p>`}
        </div>

        <div class="card" style="margin-top: var(--sp-4);">
          <h3 style="margin-bottom: var(--sp-4);">Appearance</h3>
          <div class="settings-row">
            <div class="label-wrap"><div class="title">Theme</div><div class="desc">Light for readability, dark for late-night sessions.</div></div>
            <div class="flex gap-2">
              <button class="btn btn-ghost btn-sm ${state.settings.theme === "light" ? "btn-primary" : ""}" data-theme="light">Light</button>
              <button class="btn btn-ghost btn-sm ${state.settings.theme === "dark" ? "btn-primary" : ""}" data-theme="dark">Dark</button>
            </div>
          </div>
          <div class="settings-row" data-desktop-only>
            <div class="label-wrap"><div class="title">Coach panel docked</div><div class="desc">Pin the coach as a persistent right rail — desktop only. On mobile the coach opens from the floating chat button in the corner.</div></div>
            <label class="switch"><input type="checkbox" id="toggle-coach" ${state.settings.coachPanelOpen ? "checked" : ""} /><span class="slider"></span></label>
          </div>
          <div class="settings-row">
            <div class="label-wrap"><div class="title">Hinglish mode</div><div class="desc">Light Hinglish turns-of-phrase in coach responses.</div></div>
            <label class="switch"><input type="checkbox" id="toggle-hinglish" ${state.settings.hinglish ? "checked" : ""} /><span class="slider"></span></label>
          </div>
        </div>

        <div class="card" style="margin-top: var(--sp-4);">
          <h3 style="margin-bottom: var(--sp-3);">Danger zone</h3>
          <div class="settings-row">
            <div class="label-wrap"><div class="title">Reset portfolio</div><div class="desc">Clear your trades, cash, coach history, transfers. You keep your account and friends.</div></div>
            <button class="btn btn-outline" id="reset-pf-btn" style="color: var(--warning); border-color: var(--warning);">Reset portfolio</button>
          </div>
          <div class="settings-row">
            <div class="label-wrap"><div class="title">Delete account</div><div class="desc">Permanently delete your StockSaathi account. Cannot be undone.</div></div>
            <button class="btn btn-danger" id="delete-account-btn">Delete account</button>
          </div>
        </div>

        <div class="card" style="margin-top: var(--sp-4); background: var(--bg-soft);">
          <h3 style="margin-bottom: var(--sp-3);">About &amp; Legal</h3>
          <p class="text-sm" style="line-height: 1.7;"><strong>StockSaathi</strong> — an AI-coached investment simulator for Indian teens. Real stock data, virtual money, behavioural coach. Zero setup — just sign up and start.</p>
          <p class="dim text-xs" style="line-height: 1.7; margin-top: var(--sp-3);">
            <strong style="color: var(--text-muted);">Educational paper-trading simulator · Virtual money only.</strong>
            All trades, portfolios and transfers are simulated — no real securities
            are bought, sold, or held. StockSaathi is
            <strong style="color: var(--text-muted);">not a SEBI-registered broker, investment
            adviser, research analyst, or portfolio manager</strong>, and is not affiliated with
            SEBI, NSE, BSE, or any broker. Nothing on this site is investment advice or a
            recommendation to buy or sell any security. Users are not covered by SEBI's investor
            protection or grievance-redressal mechanisms for any activity on this app. Past
            performance does not guarantee future returns.
          </p>
          <p class="dim text-xs" style="line-height: 1.7; margin-top: var(--sp-2);">
            Price data is sourced from public feeds (Yahoo Finance, CoinGecko, AMFI/MFAPI) and
            shown for educational illustration only. StockSaathi does not hold an exchange data
            licence. Coach commentary is generated by an AI model and may contain errors — treat
            it as behavioural reflection, not guidance.
          </p>
          <div class="flex gap-2" style="margin-top: var(--sp-4); flex-wrap: wrap;">
            <a href="/privacy" class="btn btn-ghost btn-sm">Privacy Policy</a>
            <a href="/terms" class="btn btn-ghost btn-sm">Terms of Use</a>
            <a href="/grievance" class="btn btn-ghost btn-sm">Grievance contact</a>
          </div>
        </div>
      </div>
    `;

    // Theme
    main.querySelector("[data-theme='light']").addEventListener("click", () => { document.documentElement.setAttribute("data-theme", "light"); setSetting("theme", "light"); });
    main.querySelector("[data-theme='dark']").addEventListener("click", () => { document.documentElement.setAttribute("data-theme", "dark"); setSetting("theme", "dark"); });
    // Desktop-only; safe-navigated because the row is display:none on mobile.
    main.querySelector("#toggle-coach")?.addEventListener("change", (e) => setSetting("coachPanelOpen", e.target.checked));
    main.querySelector("#toggle-hinglish").addEventListener("change", (e) => setSetting("hinglish", e.target.checked));

    main.querySelector("#reset-pf-btn").addEventListener("click", async () => {
      if (!confirm("Reset your portfolio, trades, coach messages, and transfers? Your account stays.")) return;
      const btn = main.querySelector("#reset-pf-btn");
      btn.disabled = true;
      btn.textContent = "Resetting…";
      try {
        // Supabase-mode: hit the server RPC so the DB is the source of truth.
        // Without this, a user in server-mode would reset locally but the next
        // loadAllFromDb would restore their stale ₹3,130 Reliance position.
        const { sb } = await import("../db/supabase.js");
        const client = await sb();
        if (client) {
          const { data: s } = await client.auth.getSession();
          if (s?.session?.access_token) {
            const { error } = await client.rpc("reset_my_portfolio");
            if (error) throw new Error(error.message);
          }
        }
        resetCurrentPortfolio();
        // Also nuke persisted quote cache so the page paints fresh from Yahoo,
        // not from some ancient localStorage entry.
        try {
          localStorage.removeItem("ss.quotes.v3");
          localStorage.removeItem("ss.quotes.v2");
          localStorage.removeItem("ss.quotes.v1");
          localStorage.removeItem("ss.coachchat.v1");
          localStorage.removeItem("ss.chatlog.v1");
        } catch {}
        toast({ kind: "success", message: "Portfolio reset. Fresh start!" });
      } catch (e) {
        toast({ kind: "error", message: "Reset failed: " + (e.message || e) });
      } finally {
        btn.disabled = false;
        btn.textContent = "Reset portfolio";
      }
    });
    main.querySelector("#delete-account-btn").addEventListener("click", () => {
      if (confirm("This will permanently delete your StockSaathi account. Are you sure?")) {
        deleteCurrentAccount();
        switchUser();
        navigate("/");
      }
    });

    // Profile section handlers
    main.querySelector("#profile-save")?.addEventListener("click", async () => {
      const displayName = main.querySelector("#profile-name").value.trim();
      const school = main.querySelector("#profile-school").value.trim();
      try {
        updateProfile({ displayName, school });
        toast({ kind: "success", message: "Profile saved." });
      } catch (e) {
        toast({ kind: "error", message: e.message });
      }
    });

    main.querySelector("#logout-btn2")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (btn.dataset.busy === "1") return;
      btn.dataset.busy = "1";
      const orig = btn.textContent;
      btn.textContent = "Signing out…";
      try {
        await logoutAccount();
      } finally {
        switchUser();
        navigate("/");
        try { btn.textContent = orig; btn.dataset.busy = "0"; } catch {}
      }
    });

    main.querySelector("#change-pw-btn")?.addEventListener("click", async () => {
      const cur = main.querySelector("#pw-cur").value;
      const nxt = main.querySelector("#pw-new").value;
      const msg = main.querySelector("#pw-msg");
      if (!cur || !nxt) { msg.innerHTML = `<div class="error-msg">Fill both fields.</div>`; return; }
      if (nxt.length < 8) { msg.innerHTML = `<div class="error-msg">New password must be at least 8 characters.</div>`; return; }
      try {
        await changePassword({ currentPassword: cur, newPassword: nxt });
        main.querySelector("#pw-cur").value = "";
        main.querySelector("#pw-new").value = "";
        msg.innerHTML = `<div class="success-msg">Password changed.</div>`;
      } catch (e) { msg.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`; }
    });
  }
}

function renderAccountSection(user, state) {
  return `
    <div class="flex items-center gap-4 wrap" style="margin-bottom: var(--sp-4);">
      <div class="friend-avatar ${user.avatarColor || "green"}" style="width: 56px; height: 56px; font-size: 18px;">
        ${initials(user.displayName || user.username)}
      </div>
      <div class="grow">
        <div class="font-semi" style="font-size: var(--text-lg); color: var(--text-strong);">${escapeHtml(user.displayName || "")}</div>
        <div class="dim text-xs">@${escapeHtml(user.username)} · ${escapeHtml(user.email)}</div>
      </div>
      <button class="btn btn-ghost btn-sm" id="logout-btn2">Log out</button>
    </div>

    <div class="flex-col gap-3" style="margin-top: var(--sp-4);">
      <div class="field">
        <label class="label" for="profile-name">Display name</label>
        <input class="input" id="profile-name" value="${escapeAttr(user.displayName || "")}" />
      </div>
      <div class="field">
        <label class="label" for="profile-school">School (optional)</label>
        <input class="input" id="profile-school" value="${escapeAttr(state.user.school || "")}" />
      </div>
      <div><button class="btn btn-primary" id="profile-save">Save profile</button></div>
    </div>

    <hr />

    <h4 class="text-md font-semi" style="margin: var(--sp-3) 0 var(--sp-2);">Change password</h4>
    <div class="flex-col gap-3" style="max-width: 420px;">
      <div class="field">
        <label class="label" for="pw-cur">Current password</label>
        <input class="input" id="pw-cur" type="password" autocomplete="current-password" />
      </div>
      <div class="field">
        <label class="label" for="pw-new">New password</label>
        <input class="input" id="pw-new" type="password" autocomplete="new-password" />
      </div>
      <div><button class="btn btn-ghost" id="change-pw-btn">Update password</button></div>
      <div id="pw-msg"></div>
    </div>
  `;
}

function initials(n) {
  if (!n) return "SS";
  const p = String(n).trim().split(/\s+/);
  return (p[0][0] + (p[1]?.[0] || "")).toUpperCase();
}
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
