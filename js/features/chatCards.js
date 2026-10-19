// =============================================================================
// CHAT CARDS — StockSaathi tools inside the coach chat.
//
// Slash commands that answer from the app's own data, instantly and with no
// AI call: an interactive price chart, a two-stock comparison, a "what if I
// had invested" calculator, a portfolio snapshot and glossary explanations.
// Each becomes an assistant message carrying `card` (the parameters) and a
// plain-text summary in `text`, so follow-up questions and share links
// read the same numbers the card shows.
//
// Cards are drawn after the messages render (hydrateCards): the chart data
// is fetched then, so an old chat redraws with current prices. Only real
// exchange data is drawn; getHistory's synthetic fallback is never shown.
// =============================================================================

import { getHistory, getQuoteBatch } from "../data/marketData.js";
import { getInstrument, STOCKS } from "../data/universe.js";
import { getState } from "../state.js";
import { glossaryLookup } from "../data/glossary.js";

export const COMMANDS = [
  { cmd: "/chart",     args: "SYMBOL [1m|3m|6m|1y|5y]", hint: "Interactive price chart", example: "/chart TCS 6m" },
  { cmd: "/compare",   args: "A B [range]",            hint: "Two stocks on one chart, in %", example: "/compare INFY TCS 1y" },
  { cmd: "/whatif",    args: "SYMBOL AMOUNT PERIOD",   hint: "If you had invested back then", example: "/whatif RELIANCE 10000 3y" },
  { cmd: "/portfolio", args: "",                       hint: "Your holdings at a glance", example: "/portfolio" },
  { cmd: "/explain",   args: "TERM",                   hint: "A finance word in plain language", example: "/explain p/e" },
  { cmd: "/help",      args: "",                       hint: "What these commands do", example: "/help" },
];

const RANGES = { "1m": "1mo", "3m": "3mo", "6m": "6mo", "1y": "1y", "5y": "5y" };
const RANGE_LABEL = { "1mo": "1 month", "3mo": "3 months", "6mo": "6 months", "1y": "1 year", "5y": "5 years" };
const interval = (r) => (r === "5y" ? "1wk" : "1d");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rs = (paise) => "₹" + (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rs0 = (rupees) => "₹" + Math.round(rupees).toLocaleString("en-IN");
const pct = (x) => (x >= 0 ? "+" : "") + x.toFixed(2) + "%";
const day = (t) => new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit", timeZone: "Asia/Kolkata" });

/** Resolve "tcs", "Infosys", "hdfc bank" to a listed symbol, or null. */
export function resolveSymbol(word) {
  const w = String(word || "").trim();
  if (!w) return null;
  const inst = getInstrument(w.toUpperCase());
  if (inst && !inst._stub && inst.kind !== "MF") return inst.symbol;
  const t = w.toLowerCase();
  let best = null;
  for (const st of STOCKS || []) {
    const name = String(st.name || "").toLowerCase().replace(/\b(ltd|limited|corporation|industries|company|india)\b\.?/g, "").replace(/\s+/g, " ").trim();
    if (name.length >= 3 && (name === t || name.startsWith(t + " ") || name.startsWith(t)) && (!best || name.length < best.n)) best = { sym: st.symbol, n: name.length };
  }
  return best?.sym || null;
}

function parseRange(tok, dflt = "3mo") {
  const k = String(tok || "").toLowerCase().replace(/^(\d+)\s*(mo|month|months)$/, "$1m").replace(/^(\d+)\s*(yr|year|years)$/, "$1y");
  return RANGES[k] || dflt;
}

function parseAmount(tok) {
  const s = String(tok || "").toLowerCase().replace(/[₹,\s]/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)(k|l|lakh|cr)?$/);
  if (!m) return null;
  const mult = { k: 1e3, l: 1e5, lakh: 1e5, cr: 1e7 }[m[2]] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

/** Is this text a slash command we handle? */
export function isCommand(text) {
  const c = String(text || "").trim().split(/\s+/)[0]?.toLowerCase();
  return COMMANDS.some((x) => x.cmd === c);
}

async function realBars(sym, range) {
  const h = await getHistory(sym, range, interval(range));
  if (h?.source !== "yahoo" || !Array.isArray(h.ohlc)) return null;
  const bars = h.ohlc.filter((b) => b && b.c > 0 && b.t);
  return bars.length >= 2 ? bars : null;
}

/**
 * Run a command. Returns { text, card } for the assistant message, or
 * { text } alone for an answer or a usage hint.
 */
export async function runCommand(raw) {
  const parts = String(raw || "").trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (cmd === "/help") {
    return { text: "Commands answer from StockSaathi's own data, instantly:\n" + COMMANDS.filter((c) => c.cmd !== "/help").map((c) => `- **${c.cmd}** ${c.args}: ${c.hint}. Try \`${c.example}\``).join("\n") };
  }

  if (cmd === "/chart") {
    const sym = resolveSymbol(args.filter((a) => !/^\d+\s*[a-z]*$/i.test(a)).join(" ") || args[0]);
    if (!sym) return { text: "Which stock? Try `/chart TCS 6m`." };
    const range = parseRange(args.find((a) => /^\d+\s*[a-z]+$/i.test(a)));
    const bars = await realBars(sym, range);
    if (!bars) return { text: `I couldn't load a real price history for ${sym} right now. Try again in a minute.` };
    const f = bars[0], l = bars.at(-1);
    return {
      card: { type: "chart", sym, range },
      text: `${sym} over ${RANGE_LABEL[range]}: ${rs(f.c)} on ${day(f.t)} to ${rs(l.c)} on ${day(l.t)} (${pct((l.c - f.c) / f.c * 100)}).`,
    };
  }

  if (cmd === "/compare") {
    const rangeTok = args.find((a) => /^\d+\s*[a-z]+$/i.test(a));
    const names = args.filter((a) => a !== rangeTok);
    const a = resolveSymbol(names[0]), b = resolveSymbol(names[1]);
    if (!a || !b) return { text: "Give me two stocks, like `/compare INFY TCS 1y`." };
    const range = parseRange(rangeTok, "1y");
    const [ba, bb] = await Promise.all([realBars(a, range), realBars(b, range)]);
    if (!ba || !bb) return { text: `I couldn't load real price history for ${!ba ? a : b} right now.` };
    const ca = (ba.at(-1).c - ba[0].c) / ba[0].c * 100, cb = (bb.at(-1).c - bb[0].c) / bb[0].c * 100;
    return {
      card: { type: "compare", syms: [a, b], range },
      text: `Over ${RANGE_LABEL[range]}: ${a} ${pct(ca)}, ${b} ${pct(cb)}. Both start at 0% so the lines compare growth, not price.`,
    };
  }

  if (cmd === "/whatif") {
    const amtTok = args.find((x) => parseAmount(x) != null && !/^\d+\s*(m|y|mo|yr)$/i.test(x));
    const perTok = args.find((x) => /^\d+\s*[a-z]+$/i.test(x) && x !== amtTok);
    const sym = resolveSymbol(args.filter((x) => x !== amtTok && x !== perTok).join(" "));
    const amount = parseAmount(amtTok) || 10000;
    if (!sym) return { text: "Try `/whatif RELIANCE 10000 3y`: a stock, an amount, how long ago." };
    const yrs = Math.max(1, Math.min(5, parseInt(perTok || "1y", 10) || 1));
    const unit = /m/i.test(perTok || "") && !/y/i.test(perTok || "") ? "m" : "y";
    const range = unit === "m" ? parseRange(perTok, "1y") : (yrs >= 2 ? "5y" : "1y");
    const [bars, nifty] = await Promise.all([realBars(sym, range), realBars("NIFTYBEES", range)]);
    if (!bars) return { text: `I couldn't load real price history for ${sym} right now.` };
    // From `yrs` years ago (5y range is weekly bars; pick the first bar at or after the date).
    const fromT = unit === "y" ? Date.now() - yrs * 365.25 * 864e5 : bars[0].t;
    const startBar = (bs) => bs?.find((b) => b.t >= fromT) || bs?.[0];
    const s0 = startBar(bars), s1 = bars.at(-1);
    const years = Math.max((s1.t - s0.t) / (365.25 * 864e5), 1 / 12);
    const value = amount * s1.c / s0.c;
    const n0 = startBar(nifty), niftyValue = nifty ? amount * nifty.at(-1).c / n0.c : null;
    const fdValue = amount * Math.pow(1.07, years);
    const card = { type: "whatif", sym, amount, from: s0.t, to: s1.t, p0: s0.c, p1: s1.c, value, niftyValue, fdValue, years };
    return {
      card,
      text: `${rs0(amount)} in ${sym} on ${day(s0.t)} would be ${rs0(value)} on ${day(s1.t)} (${pct((value / amount - 1) * 100)}).` +
        (niftyValue ? ` The same in a Nifty 50 fund: ${rs0(niftyValue)}.` : "") +
        ` In a 7% fixed deposit: ${rs0(fdValue)}. Past returns don't predict future ones.`,
    };
  }

  if (cmd === "/portfolio") {
    const st = getState();
    const hs = Object.entries(st.holdings || {});
    if (!hs.length) return { text: `You hold no stocks yet. Cash: ${rs(st.portfolio?.cashPaise || 0)}.` };
    // Prices the app already has come back at once; a slow feed is not
    // waited on for more than 4 s (unpriced rows show "—", never a guess).
    const quotes = await Promise.race([
      getQuoteBatch(hs.map(([s]) => s)).catch(() => ({})),
      new Promise((r) => setTimeout(() => r({}), 4000)),
    ]);
    const rows = hs.map(([sym, h]) => {
      const q = quotes?.[sym];
      const px = q && q.source !== "synthetic" ? (q.pricePaise ?? null) : null;   // never an invented price
      const value = px != null ? h.qty * px : null;
      return { sym, qty: h.qty, avg: h.avgCostPaise, px, value, pl: px != null ? (px - h.avgCostPaise) * h.qty : null };
    }).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const invested = rows.reduce((n, r) => n + (r.value ?? 0), 0);
    const pl = rows.reduce((n, r) => n + (r.pl ?? 0), 0);
    const cash = st.portfolio?.cashPaise || 0;
    const missing = rows.filter((r) => r.px == null).map((r) => r.sym);
    const card = { type: "portfolio", at: Date.now(), cash, invested, pl, missing, rows: rows.slice(0, 8) };
    return {
      card,
      text: missing.length === rows.length
        ? `Portfolio: ${rows.length} holding${rows.length === 1 ? "" : "s"} and ${rs(cash)} cash. Live prices weren't available just now, so no value is shown.`
        : `Portfolio: ${rs(invested + cash)} total (${rs(invested)} in ${rows.length - missing.length} priced holding${rows.length - missing.length === 1 ? "" : "s"}, ${rs(cash)} cash). On paper ${pl >= 0 ? "profit" : "loss"}: ${rs(Math.abs(pl))}.` +
          (missing.length ? ` No live price for ${missing.join(", ")}.` : ""),
    };
  }

  if (cmd === "/explain") {
    const term = args.join(" ").trim();
    if (!term) return { text: "Which word? Try `/explain p/e` or `/explain market cap`." };
    const lang = getState()?.settings?.hinglish ? "hi" : "en";
    const def = glossaryLookup(term, lang);
    if (!def) return { text: null, ask: `Explain "${term}" in simple words for a teenager.` };
    return { card: { type: "explain", term, def }, text: `${term}: ${def}` };
  }
  return { text: null };
}

// ---- Rendering ---------------------------------------------------------------

/** Placeholder markup; hydrateCards() draws into it. */
export function cardHtml(card) {
  if (!card?.type) return "";
  const data = esc(JSON.stringify(card));
  if (card.type === "explain") {
    return `<div class="ss-card ss-card-explain"><div class="ss-card-kicker">Explained</div><div class="ss-card-title">${esc(card.term)}</div><p>${esc(card.def)}</p>
      <button type="button" class="ss-card-btn" data-card-ask="${esc(`Explain ${card.term} with an Indian stock example`)}">Go deeper with Saathi</button></div>`;
  }
  if (card.type === "whatif") return whatifHtml(card);
  if (card.type === "portfolio") return portfolioHtml(card);
  return `<div class="ss-card ss-card-chart" data-card="${data}"><div class="ss-card-loading">Loading chart…</div></div>`;
}

function whatifHtml(c) {
  const best = Math.max(c.value, c.niftyValue || 0, c.fdValue);
  const bar = (label, v, cls) => `<div class="ss-wi-row ${cls}"><span>${esc(label)}</span><div class="ss-wi-bar"><i style="width:${Math.max(4, v / best * 100).toFixed(1)}%"></i></div><b>${rs0(v)}</b></div>`;
  const ret = (c.value / c.amount - 1) * 100;
  return `<div class="ss-card ss-card-whatif">
    <div class="ss-card-kicker">What if</div>
    <div class="ss-card-title">${rs0(c.amount)} in ${esc(c.sym)} on ${esc(day(c.from))}</div>
    <div class="ss-wi-big ${ret >= 0 ? "up" : "down"}">${rs0(c.value)} <small>${pct(ret)}</small></div>
    ${bar(c.sym, c.value, "is-main")}
    ${c.niftyValue ? bar("Nifty 50 fund", c.niftyValue, "") : ""}
    ${bar("7% fixed deposit", c.fdValue, "")}
    <p class="ss-card-foot">Bought at ${rs(c.p0)}, worth ${rs(c.p1)} on ${esc(day(c.to))}. Past returns don't predict future ones.</p>
    <div class="ss-card-actions"><a class="ss-card-btn" href="/stocks/${encodeURIComponent(c.sym)}">Open ${esc(c.sym)}</a>
      <button type="button" class="ss-card-btn" data-card-ask="${esc(`Why did ${c.sym} do ${ret >= 0 ? "well" : "badly"} over this period compared with the Nifty?`)}">Ask why</button></div>
  </div>`;
}

function portfolioHtml(c) {
  const total = c.invested + c.cash;
  const rows = (c.rows || []).map((r) => `<div class="ss-pf-row"><a href="/stocks/${encodeURIComponent(r.sym)}">${esc(r.sym)}</a>
      <div class="ss-wi-bar"><i style="width:${r.value && total ? Math.max(3, r.value / total * 100).toFixed(1) : 0}%"></i></div>
      <span class="${(r.pl ?? 0) >= 0 ? "up" : "down"}">${r.pl == null ? "—" : (r.pl >= 0 ? "+" : "−") + rs(Math.abs(r.pl))}</span></div>`).join("");
  return `<div class="ss-card ss-card-portfolio">
    <div class="ss-card-kicker">Portfolio · ${esc(new Date(c.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</div>
    ${(c.missing || []).length === (c.rows || []).length && (c.rows || []).length
      ? `<div class="ss-card-title">${rs(c.cash)} cash</div><div class="ss-pf-sub">Live prices weren't available just now, so holdings show no value. Try again in a minute.</div>`
      : `<div class="ss-card-title">${rs(total)}</div>
    <div class="ss-pf-sub">${rs(c.invested)} invested · ${rs(c.cash)} cash · <span class="${c.pl >= 0 ? "up" : "down"}">${c.pl >= 0 ? "+" : "−"}${rs(Math.abs(c.pl))} on paper</span>${(c.missing || []).length ? ` · no price yet for ${esc(c.missing.join(", "))}` : ""}</div>`}
    ${rows}
    <div class="ss-card-actions"><a class="ss-card-btn" href="/portfolio">Open portfolio</a>
      <button type="button" class="ss-card-btn" data-card-ask="How diversified is my portfolio, and what's my biggest risk?">Ask about my mix</button></div>
  </div>`;
}

// ---- Interactive chart --------------------------------------------------------

const W = 640, H = 220, PAD = { l: 8, r: 56, t: 12, b: 22 };

function sma(vals, n) {
  return vals.map((_, i) => (i + 1 >= n ? vals.slice(i + 1 - n, i + 1).reduce((a, b) => a + b, 0) / n : null));
}

function pathOf(vals, x, y) {
  let d = "", pen = false;
  vals.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += (pen ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1);
    pen = true;
  });
  return d;
}

async function drawChart(el) {
  let card;
  try { card = JSON.parse(el.dataset.card); } catch { return; }
  const range = el.dataset.range || card.range || "3mo";
  const syms = card.type === "compare" ? card.syms : [card.sym];
  const show = { s20: el.dataset.s20 === "1", s50: el.dataset.s50 === "1" };
  const series = await Promise.all(syms.map((s) => realBars(s, range)));
  if (!el.isConnected) return;
  if (series.some((s) => !s)) { el.innerHTML = `<div class="ss-card-loading">Couldn't load real prices for ${esc(syms.join(" / "))} right now.</div>`; return; }

  const isCompare = series.length > 1;
  const base = series[0];
  const n = base.length;
  // Compare: % from the first bar, aligned by index from the end.
  const vals = series.map((bars) => {
    const last = bars.slice(-n);
    return isCompare ? last.map((b) => (b.c - last[0].c) / last[0].c * 100) : last.map((b) => b.c / 100);
  });
  const extra = [];
  if (!isCompare && show.s20) extra.push({ v: sma(vals[0], 20), cls: "is-sma20" });
  if (!isCompare && show.s50) extra.push({ v: sma(vals[0], 50), cls: "is-sma50" });
  const all = [...vals.flat(), ...extra.flatMap((e) => e.v.filter((x) => x != null))];
  let lo = Math.min(...all), hi = Math.max(...all);
  const padv = (hi - lo) * 0.08 || 1; lo -= padv; hi += padv;
  const x = (i) => PAD.l + i / Math.max(1, n - 1) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const chg = isCompare ? null : (vals[0].at(-1) - vals[0][0]) / vals[0][0] * 100;
  const up = isCompare ? true : chg >= 0;
  const fmtV = (v) => isCompare ? pct(v) : "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const ticks = [lo + padv, (lo + hi) / 2, hi - padv];
  const head = isCompare
    ? syms.map((s, k) => `<span class="ss-ch-key k${k}"><i></i>${esc(s)} ${pct(vals[k].at(-1))}</span>`).join("")
    : `<strong>${esc(syms[0])}</strong><b>${fmtV(vals[0].at(-1))}</b><span class="${up ? "up" : "down"}">${pct(chg)}</span>`;
  const btn = (r, label) => `<button type="button" data-ch-range="${r}" aria-pressed="${r === range}">${label}</button>`;
  const tog = (k, label) => `<button type="button" data-ch-toggle="${k}" aria-pressed="${show[k]}">${label}</button>`;

  el.classList.toggle("is-down", !up);
  el.innerHTML = `
    <div class="ss-ch-head">${head}</div>
    <div class="ss-ch-tools">
      <div class="ss-ch-seg" role="group" aria-label="Time range">${btn("1mo", "1M")}${btn("3mo", "3M")}${btn("6mo", "6M")}${btn("1y", "1Y")}${btn("5y", "5Y")}</div>
      ${isCompare ? "" : `<div class="ss-ch-seg" role="group" aria-label="Averages">${tog("s20", "20-day avg")}${tog("s50", "50-day avg")}</div>`}
    </div>
    <div class="ss-ch-plot">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(syms.join(" vs ") + ", " + RANGE_LABEL[range])}">
        ${ticks.map((t) => `<line class="ss-ch-grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="ss-ch-axis" x="${W - PAD.r + 6}" y="${(y(t) + 4).toFixed(1)}">${esc(isCompare ? Math.round(t) + "%" : Math.round(t).toLocaleString("en-IN"))}</text>`).join("")}
        ${isCompare ? `<line class="ss-ch-zero" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` : `<path class="ss-ch-area" d="${pathOf(vals[0], x, y)} L${x(n - 1).toFixed(1)},${H - PAD.b} L${x(0).toFixed(1)},${H - PAD.b} Z"/>`}
        ${extra.map((e) => `<path class="ss-ch-line ${e.cls}" d="${pathOf(e.v, x, y)}"/>`).join("")}
        ${vals.map((v, k) => `<path class="ss-ch-line k${k}" d="${pathOf(v, x, y)}"/>`).join("")}
        <text class="ss-ch-axis" x="${PAD.l}" y="${H - 6}">${esc(day(base.slice(-n)[0].t))}</text>
        <text class="ss-ch-axis" x="${W - PAD.r}" y="${H - 6}" text-anchor="end">${esc(day(base.at(-1).t))}</text>
        <line class="ss-ch-cross" x1="0" x2="0" y1="${PAD.t}" y2="${H - PAD.b}" visibility="hidden"/>
      </svg>
      <div class="ss-ch-tip" hidden></div>
    </div>
    <div class="ss-card-actions">
      ${syms.map((s) => `<a class="ss-card-btn" href="/stocks/${encodeURIComponent(s)}">Open ${esc(s)}</a>`).join("")}
      <button type="button" class="ss-card-btn" data-card-ask="${esc(isCompare ? `Compare how ${syms[0]} and ${syms[1]} moved over the last ${RANGE_LABEL[range]} and what might explain the difference` : `Read the ${RANGE_LABEL[range].replace(/s$/, "")} chart of ${syms[0]}`)}">${isCompare ? "Ask what's different" : "Explain this chart"}</button>
    </div>`;

  // Crosshair + tooltip.
  const svg = el.querySelector("svg"), tip = el.querySelector(".ss-ch-tip"), cross = el.querySelector(".ss-ch-cross");
  const bars = base.slice(-n);
  const move = (clientX) => {
    const r = svg.getBoundingClientRect();
    const sx = (clientX - r.left) / r.width * W;
    const i = Math.max(0, Math.min(n - 1, Math.round((sx - PAD.l) / (W - PAD.l - PAD.r) * (n - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(day(bars[i].t))}</b>` + vals.map((v, k) => `<span class="k${k}">${esc(syms[k])} ${fmtV(v[i])}</span>`).join("") +
      (!isCompare ? `<span>${pct((vals[0][i] - vals[0][0]) / vals[0][0] * 100)} from start</span>` : "");
    tip.style.left = Math.min(r.width - 150, Math.max(0, x(i) / W * r.width - 60)) + "px";
  };
  svg.addEventListener("pointermove", (e) => move(e.clientX));
  svg.addEventListener("pointerdown", (e) => move(e.clientX));
  svg.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
}

/** Draw every card placeholder inside `root`; wire range buttons and ask buttons. */
export function hydrateCards(root, { onAsk } = {}) {
  if (!root) return;
  root.querySelectorAll(".ss-card-chart[data-card]:not([data-drawn])").forEach((el) => {
    el.dataset.drawn = "1";
    drawChart(el);
  });
  if (root.dataset.cardsWired) return;
  root.dataset.cardsWired = "1";
  root.addEventListener("click", (e) => {
    const r = e.target.closest("[data-ch-range]");
    const t = e.target.closest("[data-ch-toggle]");
    const ask = e.target.closest("[data-card-ask]");
    if (r || t) {
      const el = e.target.closest(".ss-card-chart");
      if (!el) return;
      if (r) el.dataset.range = r.dataset.chRange;
      if (t) el.dataset[t.dataset.chToggle] = el.dataset[t.dataset.chToggle] === "1" ? "0" : "1";
      drawChart(el);
    } else if (ask && onAsk) {
      onAsk(ask.dataset.cardAsk);
    }
  });
}
