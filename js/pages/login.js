// =============================================================================
// LOGIN — Email/username + password.
// =============================================================================

import { loginAccount } from "../auth/accounts.js";
import { switchUser } from "../state.js";
import { navigate } from "../router.js";

export function renderLogin(main) {
  // Prefill email from ?email= query param — used when register detects
  // the account already exists and redirects here so the user doesn't
  // have to retype.
  const q = (location.hash.split("?")[1] || "");
  const prefilledEmail = new URLSearchParams(q).get("email") || "";

  main.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <h1>Welcome back</h1>
        <p class="sub">Log in to continue where you left off.</p>

        <form class="auth-form" id="login-form" autocomplete="on">
          <div class="field">
            <label class="label" for="l-handle">Email or username</label>
            <input class="input" id="l-handle" name="username" type="text" required autocomplete="username" placeholder="you@example.com or yourname" value="${escapeAttr(prefilledEmail)}" />
          </div>
          <div class="field">
            <label class="label" for="l-pw" style="display:flex; justify-content:space-between; align-items:baseline;">
              <span>Password</span>
              <a href="#/reset-password-request" class="dim text-xs" style="font-weight:500;">Forgot password?</a>
            </label>
            <div class="auth-pw-wrap">
              <input class="input" id="l-pw" name="password" type="password" required autocomplete="current-password" placeholder="Your password" />
              <button type="button" class="auth-pw-toggle" id="l-pw-toggle" aria-label="Show password" aria-pressed="false" tabindex="0">👁</button>
            </div>
          </div>
          <div id="login-error" role="alert"></div>
          <button type="submit" class="btn btn-primary btn-block btn-lg" id="login-btn">Log in</button>
        </form>

        <div class="auth-switch">
          New to StockSaathi? <a href="#/register">Create an account</a>
        </div>
      </div>
    </div>
  `;

  // If the email was prefilled (coming from register's "already exists"
  // redirect), focus the password field so the user can type straight in.
  if (prefilledEmail) {
    queueMicrotask(() => main.querySelector("#l-pw")?.focus());
  }

  const form = main.querySelector("#login-form");
  const errBox = main.querySelector("#login-error");
  const btn = main.querySelector("#login-btn");
  // Show / hide password toggle. Critical on mobile where users can't
  // see what swipe-input / autocorrect actually typed.
  wirePasswordToggle(main, "#l-pw", "#l-pw-toggle");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.innerHTML = "";
    btn.disabled = true;
    btn.textContent = "Logging in…";
    try {
      // 2026-05-04 EMERGENCY REVERT: removed .trim() on the password field.
      // While trimming on REGISTER/RESET is fine (we control the new value),
      // trimming on LOGIN broke users whose existing Supabase-stored password
      // hash was computed from a value that had whitespace. Trim → different
      // value → hash mismatch → 'Invalid credentials' on a correct password.
      // Email handle still trims (case-folded too server-side anyway).
      const handle = main.querySelector("#l-handle").value.trim();
      const pwRaw = main.querySelector("#l-pw").value;
      // Try as-typed first. If Supabase rejects, retry trimmed — covers the
      // "I typed my password and got an extra space from autofill" case
      // without breaking accounts whose hash includes whitespace.
      let lastErr = null;
      try {
        await loginAccount({ emailOrUsername: handle, password: pwRaw });
      } catch (err) {
        lastErr = err;
        const trimmed = pwRaw.trim();
        if (trimmed && trimmed !== pwRaw) {
          try {
            await loginAccount({ emailOrUsername: handle, password: trimmed });
            lastErr = null;
          } catch (e2) { lastErr = e2; }
        }
      }
      if (lastErr) throw lastErr;
      // Refresh Supabase user cache, then trigger store reload
      const { refreshCurrentUser } = await import("../auth/accounts.js");
      await refreshCurrentUser();
      const { bootSync, loadAllFromDb } = await import("../db/sync.js");
      await bootSync();
      await loadAllFromDb();
      switchUser();
      // Deliver any personal notice waiting for this user. Login navigates
      // through the hash router and never reloads, so app.js's boot-time
      // call already ran (while logged out, finding nothing) and will not
      // run again. Without this the stuck-order apology was only reachable
      // by hard-reloading after signing in.
      import("../components/noticeModal.js")
        .then(m => m.showPendingNotices())
        .catch(() => {});
      const state = (await import("../state.js")).getState();
      if (!state.user.onboarded) navigate("/onboarding");
      else navigate("/portfolio");
    } catch (err) {
      errBox.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = "Log in";
    }
  });
}

function escapeHtml(s) {
  const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML;
}
function escapeAttr(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// Wire a click handler on a password-toggle button that flips the
// associated input between type="password" and type="text". Updates the
// aria-pressed state and the button glyph. Exported pattern — the same
// helper is reused in register.js and resetPassword.js.
export function wirePasswordToggle(root, inputSel, btnSel) {
  const input = root.querySelector(inputSel);
  const btn = root.querySelector(btnSel);
  if (!input || !btn) return;
  btn.addEventListener("click", () => {
    const isText = input.type === "text";
    input.type = isText ? "password" : "text";
    btn.setAttribute("aria-pressed", isText ? "false" : "true");
    btn.setAttribute("aria-label", isText ? "Show password" : "Hide password");
    btn.textContent = isText ? "👁" : "🙈";
    // Restore caret to end so user can keep typing.
    input.focus();
    const len = input.value.length;
    try { input.setSelectionRange(len, len); } catch {}
  });
}
