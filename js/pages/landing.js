// =============================================================================
// LANDING — StockSaathi pitch page.
// =============================================================================

import { getState, subscribe } from "../state.js";

// Hero CTA differs by auth state:
//   logged-in + onboarded → "Open portfolio" / "Try Time Travel"
//   logged-in + pending   → "Finish onboarding"
//   logged-out            → "Create account" / "I already have an account"
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
  return `<a href="/register" class="btn btn-primary btn-lg">Create account →</a>
          <a href="/login" class="btn btn-ghost btn-lg">I already have an account</a>`;
}

export function renderLanding(main) {
  const state = getState();
  let lastAuthed = state.isAuthed;
  let lastOnboarded = state.user.onboarded;

  main.innerHTML = `
    <section class="hero">
      <div style="margin-bottom: var(--sp-5);">
        <span class="pill pill-brand">StockSaathi · Invest virtually · Learn for real</span>
      </div>
      <h1 class="tight">Invest virtually.<br /><span class="grad-accent">Learn for real.</span></h1>
      <p class="tagline">
        You've heard <em>"SIP karo"</em> on YouTube. You've never placed a real trade.
        StockSaathi gives you ₹1,00,000 of virtual money to practice with <strong>real Indian stocks and mutual funds</strong> —
        with an AI coach that reflects on every decision without ever telling you what to do.
      </p>

      <div class="cta-row" data-landing-cta>
        ${ctaRowHtml(lastAuthed, lastOnboarded)}
      </div>

      <div class="landing-compliance-note" style="margin-top: var(--sp-4); font-size: var(--text-xs); color: var(--text-faint); text-align: center; line-height: 1.5; max-width: 560px; margin-left: auto; margin-right: auto;">
        Educational paper-trading simulator &middot; Virtual money only &middot; Not a SEBI-registered broker or investment adviser
      </div>

      <div class="stat-row">
        <div class="stat">
          <span class="n tabular">92%</span>
          <span class="l">of Indian teens can't define a mutual fund — but they hear "SIP karo" daily.</span>
        </div>
        <div class="stat">
          <span class="n tabular">₹0</span>
          <span class="l">of real money at risk. Virtual ₹1,00,000 portfolio, real NSE/BSE prices.</span>
        </div>
        <div class="stat">
          <span class="n tabular">1st</span>
          <span class="l">AI coach grounded in historical recovery data — not generic advice.</span>
        </div>
      </div>
    </section>

    <section class="container" style="margin-top: var(--sp-16);">
      <div style="margin-bottom: var(--sp-6);">
        <h2 class="tight">How it works</h2>
        <p class="muted" style="margin-top: var(--sp-2);">Six mechanics. One outcome — you become the kind of investor who survives the next dip.</p>
      </div>

      <div class="feature-grid">
        <div class="feature-card">
          <span class="icon">📈</span>
          <h3>Real-time prices</h3>
          <p>Live NSE/BSE quotes via Yahoo Finance — with your own Finnhub key as a tier-up for faster refresh. Always a synthetic fallback so the app never breaks.</p>
        </div>
        <div class="feature-card">
          <span class="icon">🧠</span>
          <h3>Behavioral coach</h3>
          <p>Nine deterministic bias detectors flag panic-selling, FOMO, concentration, churning and more. The AI coach verbalises what code flagged — never recommends a trade.</p>
        </div>
        <div class="feature-card">
          <span class="icon">📰</span>
          <h3>News + sentiment</h3>
          <p>A clean feed of Indian market headlines tagged bullish, bearish, or neutral — so you can gauge the mood without doom-scrolling Twitter.</p>
        </div>
        <div class="feature-card">
          <span class="icon">⏱</span>
          <h3>Time Travel</h3>
          <p>Scrub a slider through COVID 2020, 2008 GFC, or Demonetisation 2016. Watch "held" vs "panic-sold on day 3" diverge in real time. Financial déjà vu.</p>
        </div>
        <div class="feature-card">
          <span class="icon">💸</span>
          <h3>Send & receive</h3>
          <p>Transfer virtual cash between StockSaathi users by @username, or generate shareable redeem codes. Great for classroom challenges and friendly bets.</p>
        </div>
        <div class="feature-card">
          <span class="icon">📋</span>
          <h3>Report Card</h3>
          <p>Get a monthly grade that measures decision <em>quality</em>, not just returns. Self-override rate, panic-sell streaks, holding-discipline — all the things parents actually care about.</p>
        </div>
      </div>
    </section>

    <section class="container" style="margin-top: var(--sp-12);">
      <div class="card" style="background: linear-gradient(135deg, var(--brand-soft), transparent); border-color: var(--brand);">
        <h2 class="tight">Preview the wow moment — no signup needed</h2>
        <p class="muted" style="max-width: 640px; margin: var(--sp-2) 0 var(--sp-4);">
          Scrub through the COVID-19 crash. Watch a ₹1,00,000 portfolio split into
          <span class="up font-semi">held</span> vs <span class="down font-semi">panic-sold on day 3</span>.
          The <span class="up font-bold">+38%</span> delta lands in under 10 seconds.
        </p>
        <a href="/crash-replay/COVID_2020" class="btn btn-primary btn-lg">Run COVID 2020 →</a>
      </div>
    </section>

    <section class="container" style="margin: var(--sp-16) auto var(--sp-12);">
      <details class="card" style="padding: var(--sp-5);">
        <summary style="font-weight: 600; cursor: pointer; font-size: var(--text-base);">Why StockSaathi exists</summary>
        <div style="margin-top: var(--sp-4); color: var(--text-muted); line-height: 1.75; font-size: var(--text-md);">
          <p>
            Indian teens see 30-second "start SIP at 18, become crorepati by 40" videos constantly.
            <strong>92% of them cannot explain what a mutual fund is.</strong>
            Real brokerages bar minors (and rightly so). The gap: there's no safe place to make
            your first market mistakes and be coached through them.
          </p>
          <p style="margin-top: var(--sp-3);">
            Every existing Indian paper-trading app (Moneybhai, StockGro, Sensibull) is a broker-flavored
            game. None ground coaching in real recovery data. None intervene before a panic-sell fires.
            None let you replay history to see how similar decisions actually played out.
          </p>
          <p style="margin-top: var(--sp-3);">
            <strong>The moat:</strong> deterministic bias detection, cited historical analogs, SEBI-safe framing.
            The coach verbalises what a code-level engine flagged — it never freelances an opinion.
            That's the layer that makes an LLM safe to deploy for minors in Indian fintech.
          </p>
          <p style="margin-top: var(--sp-3); font-size: var(--text-xs); color: var(--text-dim);">
            All prices, unless your Finnhub API key is configured in Settings, are pulled directly from Yahoo Finance's public endpoint.
            No part of this product is investment advice, and it will never tell you to buy or sell a specific security.
          </p>
        </div>
      </details>
    </section>
  `;

  // Hotfix62a: re-paint the CTA row when auth hydrates late.
  //
  // On a cold load the router fires renderLanding the moment the hash
  // resolves. At that instant `currentUser()` may still return null —
  // refreshCurrentUser is a few hundred ms behind because it has to
  // wait on Supabase's getUser() and a profiles row fetch. The nav
  // already re-renders on every state emit (see nav.js mountNav →
  // subscribe(render)), so by the time the user sees the page their
  // avatar + portfolio pill are correct in the top-right — but the
  // landing hero, which read state ONCE at render time, still shows
  // "Create account / I already have an account" forever. User screenshot
  // confirms it: AA avatar + ₹1.00L pill at top, signup CTAs below.
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
