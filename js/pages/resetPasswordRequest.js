// =============================================================================
// RESET PASSWORD — Step 1 of 2. Request the email.
// User enters email → we call Supabase resetPasswordForEmail → email is
// sent with a link back to /reset-password. Second step lives in
// resetPassword.js.
// =============================================================================

import { requestPasswordReset } from "../auth/accounts.js";

export function renderResetPasswordRequest(main) {
  // Prefill the email if the login page bounced us here with ?email=...
  const q = location.search.slice(1);
  const prefilled = new URLSearchParams(q).get("email") || "";

  main.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <h1>Reset your password</h1>
        <p class="sub">Tell us your email and we'll send you a link to set a new password.</p>

        <form class="auth-form" id="rpr-form" autocomplete="on">
          <div class="field">
            <label class="label" for="rpr-email">Email</label>
            <input class="input" id="rpr-email" type="email" name="email" required autocomplete="email" value="${escapeAttr(prefilled)}" placeholder="you@example.com" />
          </div>
          <div id="rpr-error" role="alert"></div>
          <button type="submit" class="btn btn-primary btn-block btn-lg" id="rpr-btn">Send reset link</button>
        </form>

        <div id="rpr-success" style="display:none; margin-top: var(--sp-4); text-align: center;">
          <div style="font-size: 40px; margin-bottom: var(--sp-2);">📬</div>
          <h3 style="margin: 0 0 8px 0;">Check your email</h3>
          <p class="dim" style="margin: 0; font-size: var(--text-sm);">
            If an account exists for <strong id="rpr-email-echo"></strong>, a reset link is on its way.
            It expires in 60 minutes.
          </p>
          <p class="dim text-xs" style="margin-top: var(--sp-3);">
            Didn't get it? Check spam. Or <a href="#" id="rpr-again">send another</a>.
          </p>
        </div>

        <div class="auth-switch">
          Remembered your password? <a href="/login">Log in</a>
        </div>
      </div>
    </div>
  `;

  const form = main.querySelector("#rpr-form");
  const errBox = main.querySelector("#rpr-error");
  const btn = main.querySelector("#rpr-btn");
  const success = main.querySelector("#rpr-success");
  const emailEcho = main.querySelector("#rpr-email-echo");

  async function submit() {
    errBox.innerHTML = "";
    const email = main.querySelector("#rpr-email").value.trim();
    if (!email) return showErr("Enter your email.");
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      await requestPasswordReset(email);
      form.style.display = "none";
      success.style.display = "block";
      emailEcho.textContent = email;
    } catch (err) {
      showErr(err.message || "Could not send reset email.");
      btn.disabled = false;
      btn.textContent = "Send reset link";
    }
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  main.querySelector("#rpr-again")?.addEventListener("click", (e) => {
    e.preventDefault();
    form.style.display = "";
    success.style.display = "none";
    btn.disabled = false;
    btn.textContent = "Send reset link";
  });

  function showErr(msg) { errBox.innerHTML = `<div class="error-msg">${escapeHtml(msg)}</div>`; }
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
