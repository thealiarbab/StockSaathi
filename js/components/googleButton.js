// "Continue with Google" for the login and signup pages. Rendered hidden and
// revealed only when the Google provider is enabled for the project, so it can
// ship before the switch is flipped and never shows a button that would fail.
//
// Google's own button (Google Identity Services) opens a popup that names
// stocksaathi.co.in and hands back a signed ID token, which Supabase turns
// into a session. The redirect flow is the fallback when Google's script
// can't load (blockers, some in-app webviews): it works the same, but its
// consent screen shows the Supabase project address.

import { googleSignInEnabled, signInWithGoogle, signInWithGoogleIdToken, GOOGLE_CLIENT_ID } from "../auth/accounts.js";

const GIS_SRC = "https://accounts.google.com/gsi/client";
const GIS_TIMEOUT_MS = 6000;
const GIS_HOSTS = new Set(["stocksaathi.co.in"]);

const G_LOGO = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

export function googleButtonHtml(label = "Continue with Google") {
  return `
    <div class="auth-google" id="auth-google" hidden>
      <div class="auth-google-gis" id="auth-google-gis"></div>
      <button type="button" class="btn btn-block btn-lg auth-google-btn" id="auth-google-btn" hidden>${G_LOGO}<span>${label}</span></button>
      <div class="auth-or" aria-hidden="true"><span>or use email</span></div>
    </div>`;
}

let _gisPromise = null;
function loadGis() {
  if (window.google?.accounts?.id) return Promise.resolve(true);
  if (_gisPromise) return _gisPromise;
  _gisPromise = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    const t = setTimeout(() => resolve(false), GIS_TIMEOUT_MS);
    s.onload = () => { clearTimeout(t); resolve(!!window.google?.accounts?.id); };
    s.onerror = () => { clearTimeout(t); resolve(false); };
    document.head.appendChild(s);
  });
  _gisPromise.then((ok) => { if (!ok) _gisPromise = null; });
  return _gisPromise;
}

// Google gets the SHA-256 of a one-time value and puts it in the signed
// token; Supabase gets the raw value and checks the two match, so a token
// lifted from elsewhere can't be replayed here.
async function makeNonce() {
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, "0")).join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hashed = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  return { raw, hashed };
}

/**
 * @param main      page root
 * @param onError   (message) => void
 * @param onSignedIn async () => void, runs after Supabase has the session
 * @param text      "continue_with" | "signup_with" (Google's button wording)
 */
export async function wireGoogleButton(main, onError, onSignedIn, text = "continue_with") {
  const wrap = main.querySelector("#auth-google");
  const slot = main.querySelector("#auth-google-gis");
  const btn = main.querySelector("#auth-google-btn");
  if (!wrap || !btn || !slot) return;
  if (!(await googleSignInEnabled())) return;
  if (!main.contains(wrap)) return;            // page changed while we checked
  wrap.hidden = false;

  const fallback = () => {
    slot.hidden = true;
    btn.hidden = false;
    // Back from Google's page, the browser can restore this page from its
    // back/forward cache with the button still disabled from the click.
    window.addEventListener("pageshow", (e) => { if (e.persisted) btn.disabled = false; });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await signInWithGoogle();              // navigates away to Google
      } catch (err) {
        btn.disabled = false;
        onError?.(err.message || "Couldn't open Google sign-in. Try again.");
      }
    });
  };

  // Google only serves its button to origins listed on the OAuth client
  // (stocksaathi.co.in). Local servers and Vercel previews use the redirect.
  if (!GIS_HOSTS.has(location.hostname)) return fallback();
  if (!(await loadGis()) || !crypto?.subtle) return fallback();
  if (!main.contains(wrap)) return;

  const nonce = await makeNonce();
  const gid = window.google.accounts.id;
  gid.initialize({
    client_id: GOOGLE_CLIENT_ID,
    nonce: nonce.hashed,
    ux_mode: "popup",
    auto_select: false,
    cancel_on_tap_outside: true,
    context: text === "signup_with" ? "signup" : "signin",
    callback: async (resp) => {
      if (!resp?.credential) { onError?.("Google sign-in didn't finish. Try again."); return; }
      slot.style.opacity = "0.5";
      slot.style.pointerEvents = "none";
      try {
        await signInWithGoogleIdToken(resp.credential, nonce.raw);
        await onSignedIn?.();
      } catch (err) {
        slot.style.opacity = "";
        slot.style.pointerEvents = "";
        onError?.(err.message || "Google sign-in didn't finish. Try again.");
      }
    },
  });
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const width = Math.max(200, Math.min(400, Math.round(slot.getBoundingClientRect().width || 320)));
  gid.renderButton(slot, {
    type: "standard",
    theme: dark ? "filled_black" : "outline",
    size: "large",
    text,
    shape: "pill",
    logo_alignment: "center",
    width,
  });
}
