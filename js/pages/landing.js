// =============================================================================
// LANDING — StockSaathi home page.
//
// The markup lives in partials/landing.html; scripts/build_landing.py copies it
// into index.html (pre-rendered for crawlers) and into ./landingContent.js
// (used here). Edit the partial, then re-run the script.
// =============================================================================

import { getState, subscribe } from "../state.js";
import { LANDING_HTML, CTA_PLACEHOLDER } from "./landingContent.js";

// Hero CTA differs by auth state:
//   logged-in + onboarded → "Open portfolio" / "Try Time Travel"
//   logged-in + pending   → "Finish onboarding"
//   logged-out            → "Create free account" / "Explore markets"
// The logged-out variant is also baked into index.html by build_landing.py
// (CTA_LOGGED_OUT) — keep the two identical.
// Pulled out of the template so the post-render subscriber can swap just
// this fragment when auth state hydrates late (see renderLanding below).
function ctaRowHtml(isAuthed, isOnboarded) {
  if (isAuthed && isOnboarded) {
    return `<a href="/portfolio" class="btn btn-primary btn-lg">Open portfolio</a>
            <a href="/crash-replay" class="btn btn-ghost btn-lg">Try Time Travel</a>`;
  }
  if (isAuthed) {
    return `<a href="/onboarding" class="btn btn-primary btn-lg">Finish onboarding</a>`;
  }
  return `<a href="/register" class="btn btn-primary btn-lg">Create free account →</a>
          <a href="/stocks" class="btn btn-ghost btn-lg">Explore markets, no signup</a>`;
}

export function renderLanding(main) {
  const state = getState();
  let lastAuthed = state.isAuthed;
  let lastOnboarded = state.user.onboarded;

  main.innerHTML = LANDING_HTML.replace(CTA_PLACEHOLDER, ctaRowHtml(lastAuthed, lastOnboarded));

  // Hotfix62a: re-paint the CTA row when auth hydrates late.
  //
  // On a cold load the router fires renderLanding the moment the route
  // resolves. At that instant `currentUser()` may still return null —
  // refreshCurrentUser is a few hundred ms behind because it has to
  // wait on Supabase's getUser() and a profiles row fetch. The nav
  // already re-renders on every state emit (see nav.js mountNav →
  // subscribe(render)), so by the time the user sees the page their
  // avatar + portfolio pill are correct in the top-right — but the
  // landing hero, which read state ONCE at render time, still shows
  // the signup CTAs forever.
  //
  // Fix: subscribe to state and swap just the CTA fragment when
  // isAuthed/onboarded flips. Auto-unsubscribes when the hero detaches
  // (i.e. user navigates to a different route, or back to landing
  // which re-runs renderLanding and creates a fresh subscription).
  const heroEl = main.querySelector(".hero");
  const ctaEl = main.querySelector("[data-landing-cta]");
  if (heroEl && ctaEl) {
    const unsub = subscribe(() => {
      // Hero element gets detached when router blanks main.innerHTML
      // for the next route. isConnected returns false → we tear down.
      if (!heroEl.isConnected) { unsub?.(); return; }
      const s = getState();
      if (s.isAuthed === lastAuthed && s.user.onboarded === lastOnboarded) return;
      lastAuthed = s.isAuthed;
      lastOnboarded = s.user.onboarded;
      ctaEl.innerHTML = ctaRowHtml(lastAuthed, lastOnboarded);
    });
  }
}
