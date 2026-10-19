// =============================================================================
// SHARED CHAT — /share/<id>, a read-only snapshot of a coach chat that its
// owner chose to share (chat_shares, read through get_shared_chat()). Works
// signed out. Cards redraw from live data; everything else is the snapshot.
// =============================================================================

import { fetchShared } from "../features/chatCloud.js";
import { cardHtml, hydrateCards } from "../features/chatCards.js";
import { renderMarkdown, chartCard } from "./chat.js";
import { getState } from "../state.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function renderSharedChat(main, params) {
  main.innerHTML = `<div class="share-page"><p class="share-loading">Loading the shared chat…</p></div>`;
  const data = await fetchShared(params?.id);
  if (!data) {
    document.title = "Chat not found | StockSaathi";
    main.innerHTML = `<div class="share-page"><div class="empty-state"><h3>This link doesn't work</h3>
      <p>The chat may have been unshared, or the link is incomplete.</p><a class="btn btn-primary" href="/chat">Ask Saathi something</a></div></div>`;
    return;
  }
  document.title = `${data.title} | StockSaathi`;
  const when = new Date(data.updated_at || data.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const msgs = (data.messages || []).map((m) => m.role === "user"
    ? `<div class="cc-row cc-row-user"><div class="cc-user-col">${m.chart ? chartCard(m.chart) : ""}<div class="cc-bubble cc-user"><span class="msg-body">${esc(m.text)}</span></div></div></div>`
    : `<div class="cc-row cc-row-bot"><div class="cc-bot-col">${m.cardWithText ? "" : m.card ? cardHtml(m.card) : ""}<div class="cc-bubble cc-bot"><span class="msg-body">${renderMarkdown(m.text)}</span></div>${m.cardWithText && m.card ? cardHtml(m.card) : ""}</div></div>`).join("");
  const authed = !!getState()?.isAuthed;
  main.innerHTML = `
    <div class="share-page">
      <header class="share-head">
        <div class="share-kicker">Shared chat with Saathi${data.author ? ` · from ${esc(data.author)}` : ""} · ${esc(when)}</div>
        <h1>${esc(data.title)}</h1>
      </header>
      <div class="share-msgs cc-messages">${msgs}</div>
      <footer class="share-foot">
        <p>Saathi is StockSaathi's money coach for students. It explains; it doesn't give tips. Practice only, not investment advice.</p>
        <a class="btn btn-primary" href="${authed ? "/chat" : "/register"}">${authed ? "Ask Saathi your own question" : "Try StockSaathi free"}</a>
      </footer>
    </div>`;
  hydrateCards(main.querySelector(".share-msgs"), {
    onAsk: (q) => { location.href = authed ? "/chat" : "/register"; void q; },
  });
}
