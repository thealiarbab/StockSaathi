// =============================================================================
// WHAT'S NEW — the release card, delivered as a user_notices row of kind
// "whats_new" (payload.release picks the content below). noticeModal.js hands
// those rows here instead of drawing its own modal, so the card can use the
// term explainer's look (.term-pop) and still be shown once, acknowledged via
// ack_notice like every other notice.
// =============================================================================

import { googleSignInEnabled } from "../auth/accounts.js";

// Lines tagged { google: true } only show once Google sign-in is switched on.
const RELEASES = {
  "2026-10": {
    title: "What's new on StockSaathi",
    sub: "30+ improvements since your last visit. Here are the big ones.",
    shot: { src: "/images/whats-new/2026-10/fullscreen-chart.png", alt: "A full-screen candlestick chart of Reliance Industries." },
    top: [
      ["Full-screen charts", "Expand any chart to fill the screen, then zoom without gaps for nights and weekends."],
      ["Crash replays from real prices", "Relive COVID-19, 2008 and demonetisation with real Nifty 50 closes. They open instantly now."],
      ["Tap a term to see what it means", "P/E, beta, market cap and more, explained in a sentence."],
      ["A faster Saathi", "Replies are quicker, and it only explains a move when a real headline says why."],
    ],
    more: [
      ["Charts and prices", [
        "Quiet stocks hold their price between trades; their 1-day candles use bars big enough to fill the day.",
        "Long charts show the year, labels never repeat, and days with no trades no longer show as flat stretches.",
        "A fund's 1W chart shows its whole week, and zooming always keeps at least 12 bars on screen.",
        "Real 52-week highs and lows, with official NSE closing prices as a backup.",
        "Small SME stocks no longer get stuck at an old price.",
        "Your \"Value over time\" chart has 1M to All ranges and zooms.",
      ]],
      ["Orders", [
        "After-hours orders fill at the next open; fund orders at the next NAV; orders stay open 30 days.",
        "Every order fills at the real market price, and you can't sell more than you own.",
        "A clear message when an order fills, and a heads-up if your limit is far from the market.",
      ]],
      ["Saathi, your coach", [
        "Replies are no longer cut off halfway.",
        "Ask about the news and Saathi answers from today's headlines. Hinglish mode works.",
        "On fund pages, Saathi talks about the fund's real NAV change.",
        "On phones, the coach panel closes properly and the chat box stays visible.",
      ]],
      ["Mutual funds", [
        "More than 8,000 real AMFI schemes, NAVs updated twice a day.",
        "Fund pages show the NAV date and the change since the previous NAV.",
      ]],
      ["Phones", [
        "Everything fits on small screens: menu button, timeframes, tab bar, portfolio total.",
        "Dark mode follows your phone's setting.",
        "Short, shareable links like stocksaathi.co.in/stocks/TCS.",
      ]],
      ["Signing in", [
        { text: "Continue with Google on the login and sign-up pages.", google: true },
        "A typo in your email gets a \"Did you mean gmail.com?\" as you type.",
        "No code in your inbox? Log in and we send a fresh one, with a tip on where to look.",
      ]],
    ],
    showMe: "/stocks/RELIANCE",
  },
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Show the card for one notice row; resolves once it is closed and acked. */
export function presentWhatsNew(client, notice) {
  return new Promise(async (resolve) => {
    const rel = RELEASES[notice.payload?.release] || RELEASES["2026-10"];
    const google = await googleSignInEnabled().catch(() => false);
    const line = (t) => (typeof t === "string" ? t : (!t.google || google) ? t.text : null);
    const el = document.createElement("div");
    el.className = "term-pop-overlay";
    el.innerHTML = `
      <div class="term-pop wn" role="dialog" aria-modal="true" aria-labelledby="wn-title">
        <button type="button" class="term-pop-x" aria-label="Close">✕</button>
        <img class="wn-shot" src="${esc(rel.shot.src)}" alt="${esc(rel.shot.alt)}" width="1120" height="665" decoding="async">
        <div class="wn-body">
          <h2 class="term-pop-title" id="wn-title">${esc(rel.title)}</h2>
          <p class="wn-sub">${esc(rel.sub)}</p>
          <ul class="wn-list">
            ${rel.top.map(([h, t]) => `<li><strong>${esc(h)}</strong><span>${esc(t)}</span></li>`).join("")}
          </ul>
          <details class="wn-more">
            <summary>Everything else that's new</summary>
            <div class="wn-more-body">
              ${rel.more.map(([h, items]) => {
                const lis = items.map(line).filter(Boolean);
                return lis.length ? `<h4>${esc(h)}</h4><ul>${lis.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "";
              }).join("")}
            </div>
          </details>
        </div>
        <div class="wn-actions">
          <a class="btn btn-ghost wn-go" href="${esc(rel.showMe)}">Open a chart</a>
          <button type="button" class="btn btn-primary term-pop-ok">Got it</button>
        </div>
      </div>`;

    const prevFocus = document.activeElement;
    const gutter = window.innerWidth - document.documentElement.clientWidth;
    if (gutter > 0) document.documentElement.style.setProperty("--term-pop-gutter", gutter + "px");
    document.documentElement.classList.add("term-pop-open");
    document.body.appendChild(el);
    const ok = el.querySelector(".term-pop-ok");
    ok.focus({ preventScroll: true });

    let done = false;
    const close = async () => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      el.remove();
      document.documentElement.classList.remove("term-pop-open");
      document.documentElement.style.removeProperty("--term-pop-gutter");
      try { prevFocus?.focus?.({ preventScroll: true }); } catch {}
      // Best-effort ack; on failure the card simply shows again next visit.
      try { await client.rpc("ack_notice", { p_notice_id: notice.id }); }
      catch (e) { console.warn("[whats-new] ack failed:", e?.message || e); }
      resolve();
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab") return;
      const f = [...el.querySelectorAll("button, a[href], summary")];
      const i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    el.addEventListener("click", (e) => {
      if (e.target === el || e.target.closest(".term-pop-x, .term-pop-ok")) close();
      // "Show me" is an in-app link: the router takes the click, we just close.
      if (e.target.closest(".wn-go")) close();
    });
  });
}
