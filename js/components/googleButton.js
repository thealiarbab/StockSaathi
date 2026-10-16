// "Continue with Google" for the login and signup pages. Rendered hidden and
// revealed only when the Google provider is enabled for the project, so it can
// ship before the switch is flipped and never shows a button that would fail.

import { googleSignInEnabled, signInWithGoogle } from "../auth/accounts.js";

const G_LOGO = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

export function googleButtonHtml(label = "Continue with Google") {
  return `
    <div class="auth-google" id="auth-google" hidden>
      <button type="button" class="btn btn-block btn-lg auth-google-btn" id="auth-google-btn">${G_LOGO}<span>${label}</span></button>
      <div class="auth-or" aria-hidden="true"><span>or use email</span></div>
    </div>`;
}

export async function wireGoogleButton(main, onError) {
  const wrap = main.querySelector("#auth-google");
  const btn = main.querySelector("#auth-google-btn");
  if (!wrap || !btn) return;
  if (!(await googleSignInEnabled())) return;
  if (!main.contains(wrap)) return;            // page changed while we checked
  wrap.hidden = false;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await signInWithGoogle();                // navigates away to Google
    } catch (err) {
      btn.disabled = false;
      onError?.(err.message || "Couldn't open Google sign-in. Try again.");
    }
  });
}
