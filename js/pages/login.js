// =============================================================================
// LOGIN — Email/username + password.
// =============================================================================

import { loginAccount, readEmailLinkParams, verifyEmailLink } from "../auth/accounts.js";
import { switchUser } from "../state.js";
import { navigate } from "../router.js";
import { googleButtonHtml, wireGoogleButton } from "../components/googleButton.js";

// Shared by password login, Google sign-in (which returns to /login with the
// session in the URL fragment) and the signup page.
export async function finishSignIn() {
  const { refreshCurrentUser } = await import("../auth/accounts.js");
  await refreshCurrentUser();
  const { bootSync, loadAllFromDb } = await import("../db/sync.js");
  await bootSync();
  await loadAllFromDb();
  switchUser();
  // Deliver any personal notice waiting for this user. Login navigates
  // through the router and never reloads, so app.js's boot-time call already
  // ran (while logged out, finding nothing) and will not run again.
  import("../components/noticeModal.js")
    .then(m => m.showPendingNotices())
    .catch(() => {});
  const state = (await import("../state.js")).getState();
  if (!state.user.onboarded) navigate("/onboarding");
  else navigate("/portfolio");
}

export function renderLogin(main) {
  // Prefill email from ?email= query param — used when register detects
  // the account already exists and redirects here so the user doesn't
  // have to retype.
  const q = location.search.slice(1);
  const prefilledEmail = new URLSearchParams(q).get("email") || "";

  main.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <h1>Welcome back</h1>
        <p class="sub">Log in to continue where you left off.</p>
        ${googleButtonHtml()}

        <form class="auth-form" id="login-form" autocomplete="on">
          <div class="field">
            <label class="label" for="l-handle">Email or username</label>
            <input class="input" id="l-handle" name="username" type="text" required autocomplete="username" placeholder="you@example.com or yourname" value="${escapeAttr(prefilledEmail)}" />
          </div>
          <div class="field">
            <label class="label" for="l-pw" style="display:flex; justify-content:space-between; align-items:baseline;">
              <span>Password</span>
              <a href="/reset-password-request" class="dim text-xs" style="font-weight:500;">Forgot password?</a>
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
          New to StockSaathi? <a href="/register">Create an account</a>
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
  wireGoogleButton(main, (msg) => { errBox.innerHTML = `<div class="error-msg">${escapeHtml(msg)}</div>`; }, finishSignIn);

  // Sign-in, invite and email-change links from our emails land here with
  // ?token_hash=&type= (read and cleared from the address bar at once).
  const emailLink = readEmailLinkParams();
  if (emailLink) {
    if (emailLink.type === "recovery") {
      navigate(`/reset-password?token_hash=${encodeURIComponent(emailLink.tokenHash)}&type=recovery`);
      return;
    }
    btn.disabled = true;
    btn.textContent = "Signing you in…";
    (async () => {
      try {
        await verifyEmailLink(emailLink);
        await finishSignIn();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Log in";
        errBox.innerHTML = `<div class="error-msg">${escapeHtml(err.message || "That link didn't work. Log in below.")}</div>`;
      }
    })();
  }

  // Back from Google: supabase-js reads the session from the URL fragment
  // when the client starts. Finish the sign-in instead of showing the form.
  if (/access_token=|error_description=/.test(location.hash)) {
    (async () => {
      try {
        const { sb } = await import("../db/supabase.js");
        const client = await sb();
        const { data } = client ? await client.auth.getSession() : { data: null };
        if (data?.session?.user) { await finishSignIn(); return; }
        const why = new URLSearchParams(location.hash.slice(1)).get("error_description");
        if (why) errBox.innerHTML = `<div class="error-msg">Google sign-in didn't finish: ${escapeHtml(why)}. Try again.</div>`;
      } catch (e) {
        console.warn("google return failed:", e);
      }
    })();
  }

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
      await finishSignIn();
    } catch (err) {
      if (err.code === "email_not_confirmed" && err.email) {
        // A quarter of signups never found their code (spam, Promotions).
        // Hand the address to the signup page, which sends a fresh one. It
        // goes through sessionStorage, not the URL, so it never reaches
        // analytics.
        try { sessionStorage.setItem("ss.verifyEmail", err.email); } catch {}
        errBox.innerHTML = `<div class="error-msg">
          You haven't confirmed <strong>${escapeHtml(err.email)}</strong> yet.
          <a href="/register?verify=1" style="margin-left:6px;">Send me a new code →</a>
        </div>`;
        btn.disabled = false;
        btn.textContent = "Log in";
        return;
      }
      // Wrong password was the top login error (44 on 18 Oct). Put the way
      // out inside the message instead of a small link above the box.
      const handle = main.querySelector("#l-handle").value.trim();
      const reset = /incorrect email or password/i.test(err.message || "")
        ? `<a class="btn btn-ghost btn-sm" style="margin-top:8px;" href="/reset-password-request${handle.includes("@") ? "?email=" + encodeURIComponent(handle) : ""}">Forgot password? Reset it by email →</a>`
        : "";
      errBox.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}${reset ? "<br>" + reset : ""}</div>`;
      try { errBox.scrollIntoView({ block: "center", behavior: "smooth" }); } catch {}
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
