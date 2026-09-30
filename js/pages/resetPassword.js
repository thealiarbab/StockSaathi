// =============================================================================
// RESET PASSWORD — Step 2 of 2. Set the new password.
// This is where Supabase's "reset password" email lands. The URL arrives
// with ?type=recovery + hash tokens; Supabase-js detectSessionInUrl sets
// a PASSWORD_RECOVERY session. We then call auth.updateUser({ password })
// to persist the new password and redirect to /portfolio.
// =============================================================================

import { setNewPassword, validatePassword } from "../auth/accounts.js";
import { switchUser } from "../state.js";
import { navigate } from "../router.js";
import { wirePasswordToggle } from "./login.js";

const RECOVERY_WAIT_MS = 5000;

export function renderResetPassword(main) {
  main.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <h1>Set a new password</h1>
        <p class="sub">Choose something only you'll remember.</p>

        <div id="rp-waiting" class="dim text-sm" style="display:flex; align-items:center; gap:var(--sp-2); margin-bottom: var(--sp-3);">
          <span class="spinner" aria-hidden="true"></span>
          <span>Verifying your reset link…</span>
        </div>

        <form class="auth-form" id="rp-form" autocomplete="off" style="display:none;">
          <div class="field">
            <label class="label" for="rp-pw">New password</label>
            <div class="auth-pw-wrap">
              <input class="input" id="rp-pw" type="password" required autocomplete="new-password" minlength="8" placeholder="At least 8 characters" />
              <button type="button" class="auth-pw-toggle" id="rp-pw-toggle" aria-label="Show password" aria-pressed="false" tabindex="0">👁</button>
            </div>
            <div class="muted text-xs" style="margin-top: 4px;">At least 8 characters. Tap the eye icon to check what you typed.</div>
          </div>
          <div class="field">
            <label class="label" for="rp-pw2">Confirm new password</label>
            <div class="auth-pw-wrap">
              <input class="input" id="rp-pw2" type="password" required autocomplete="new-password" minlength="8" placeholder="Type it again" />
              <button type="button" class="auth-pw-toggle" id="rp-pw2-toggle" aria-label="Show password" aria-pressed="false" tabindex="0">👁</button>
            </div>
          </div>
          <div id="rp-error" role="alert"></div>
          <button type="submit" class="btn btn-primary btn-block btn-lg" id="rp-btn">Set new password</button>
        </form>

        <div id="rp-expired" style="display:none;">
          <div class="error-msg" style="margin-bottom: var(--sp-3);">
            This reset link has expired or is invalid. They're single-use and last 60 minutes.
          </div>
          <a href="/reset-password-request" class="btn btn-primary btn-block">Request a new link</a>
        </div>

        <div class="auth-switch">
          Back to <a href="/login">log in</a>
        </div>
      </div>
    </div>
  `;

  const waiting = main.querySelector("#rp-waiting");
  const form = main.querySelector("#rp-form");
  const expired = main.querySelector("#rp-expired");
  const errBox = main.querySelector("#rp-error");
  const btn = main.querySelector("#rp-btn");

  // Wait up to 5s for Supabase-js to parse the URL hash and establish the
  // recovery session via onAuthStateChange. If no PASSWORD_RECOVERY event
  // fires, show the expired-link state.
  let gotRecovery = false;
  let authUnsub = null;
  (async () => {
    const { sb } = await import("../db/supabase.js");
    const client = await sb();
    if (!client) { showExpired(); return; }

    // Maybe Supabase already set it before we subscribed:
    const { data } = await client.auth.getSession();
    if (data?.session?.access_token) {
      showForm();
      return;
    }

    const sub = client.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session?.user)) {
        gotRecovery = true;
        showForm();
      }
    });
    authUnsub = () => sub?.data?.subscription?.unsubscribe?.();

    setTimeout(() => { if (!gotRecovery) showExpired(); }, RECOVERY_WAIT_MS);
  })();

  function showForm() {
    waiting.style.display = "none";
    form.style.display = "";
    expired.style.display = "none";
    main.querySelector("#rp-pw")?.focus();
    // Wire show/hide toggles on both new-password fields. Critical on
    // mobile for verifying what swipe-input actually typed.
    wirePasswordToggle(main, "#rp-pw", "#rp-pw-toggle");
    wirePasswordToggle(main, "#rp-pw2", "#rp-pw2-toggle");
  }
  function showExpired() {
    waiting.style.display = "none";
    form.style.display = "none";
    expired.style.display = "";
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.innerHTML = "";
    // Trim BOTH ends — mobile autofill / swipe-input frequently leaves
    // trailing spaces that the user can't see.
    const pw = main.querySelector("#rp-pw").value.trim();
    const pw2 = main.querySelector("#rp-pw2").value.trim();
    const vErr = validatePassword(pw);
    if (vErr) return showErr(vErr);
    if (pw !== pw2) return showErr("Passwords don't match.");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await setNewPassword(pw);
      authUnsub?.();
      const { refreshCurrentUser } = await import("../auth/accounts.js");
      await refreshCurrentUser();
      const { bootSync, loadAllFromDb } = await import("../db/sync.js");
      await bootSync();
      await loadAllFromDb();
      switchUser();
      navigate("/portfolio");
    } catch (err) {
      showErr(err.message || "Couldn't save password.");
      btn.disabled = false;
      btn.textContent = "Set new password";
    }
  });

  function showErr(msg) { errBox.innerHTML = `<div class="error-msg">${escapeHtml(msg)}</div>`; }
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
