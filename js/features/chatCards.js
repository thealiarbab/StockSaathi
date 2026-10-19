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
  { cmd: "/chart",     args: "SYMBOL [1m|3m|6m|1y|5y]", hint: "Interactive price chart", hintHi: "Interactive price chart", example: "/chart TCS 6m",
    what: "Draws the real price line. Tap 1M to 5Y, switch on 20 or 50-day averages, drag to read any day.",
    whatHi: "Asli price ka chart. 1M se 5Y tak badlo, 20/50-din average on karo, ungli ghuma ke kisi bhi din ka price dekho." },
  { cmd: "/compare",   args: "A B [range]",            hint: "Two stocks on one chart, in %", hintHi: "Do stocks ek chart pe, % mein", example: "/compare INFY TCS 1y",
    what: "Puts two stocks on one chart, both starting at 0%, so you see which grew more.",
    whatHi: "Do stocks ek saath, dono 0% se shuru, taaki dikhe kaun zyada badha." },
  { cmd: "/whatif",    args: "SYMBOL AMOUNT PERIOD",   hint: "If you had invested back then", hintHi: "Agar tab invest kiya hota", example: "/whatif RELIANCE 10000 3y",
    what: "What an amount put in back then would be worth today, next to a Nifty 50 fund and a 7% FD.",
    whatHi: "Tab lagaye paise aaj kitne hote, Nifty 50 fund aur 7% FD ke saath compare karke." },
  { cmd: "/portfolio", args: "",                       hint: "Your holdings at a glance", hintHi: "Tumhare holdings ek nazar mein", example: "/portfolio",
    what: "Your holdings, cash and paper profit or loss on one card.",
    whatHi: "Tumhare holdings, cash aur on-paper profit/loss ek card pe." },
  { cmd: "/explain",   args: "TERM",                   hint: "A finance word in plain language", hintHi: "Finance ka word simple bhasha mein", example: "/explain p/e",
    what: "Any finance word in plain words, with a button to go deeper.",
    whatHi: "Koi bhi finance word aasaan bhasha mein, aur gehraai mein jaane ka button." },
  { cmd: "/help",      args: "",                       hint: "This guide", hintHi: "Yeh guide", example: "/help", what: "", whatHi: "" },
];

/** English or Hinglish, following the coach's language switch. */
const hi = () => !!getState()?.settings?.hinglish;
const L = (en, hin) => (hi() ? hin : en);

const RANGES = { "1m": "1mo", "3m": "3mo", "6m": "6mo", "1y": "1y", "5y": "5y" };
const RANGE_LABEL = { "1mo": "1 month", "3mo": "3 months", "6mo": "6 months", "1y": "1 year", "5y": "5 years" };
const RANGE_HI = { "1mo": "1 mahine", "3mo": "3 mahine", "6mo": "6 mahine", "1y": "1 saal", "5y": "5 saal" };
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

/** Is this text a slash command? Any "/word" is: an unknown one gets the guide. */
export function isCommand(text) {
  return /^\/[a-z]+(\s|$)/i.test(String(text || "").trim());
}

/** Plain-text guide (what the AI and share links read; the card shows the rest). */
export function helpText() {
  return L("Commands answer from StockSaathi's own data, instantly:\n", "Commands StockSaathi ke apne data se turant jawab dete hain:\n") +
    COMMANDS.filter((c) => c.cmd !== "/help").map((c) => `- **${c.cmd}** ${c.args}: ${hi() ? c.hintHi : c.hint}. ${L("Try", "Jaise")} \`${c.example}\``).join("\n");
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

  if (cmd === "/help") return { card: { type: "help" }, text: helpText() };

  if (cmd === "/chart") {
    const sym = resolveSymbol(args.filter((a) => !/^\d+\s*[a-z]*$/i.test(a)).join(" ") || args[0]);
    if (!sym) return { text: L("Which stock? Try `/chart TCS 6m`.", "Kaunsa stock? Aise likho: `/chart TCS 6m`.") };
    const tok = args.find((a) => /^\d+\s*[a-z]+$/i.test(a));
    // Shorter than a month ("1d", "1w"): the chart has daily bars only, so
    // show a month and say so rather than silently drawing 3 months.
    const short = tok && /^\d+\s*(d|day|days|w|wk|week|weeks)$/i.test(tok);
    const range = short ? "1mo" : parseRange(tok);
    const bars = await realBars(sym, range);
    if (!bars) return { text: L(`I couldn't load a real price history for ${sym} right now. Try again in a minute.`, `${sym} ki asli price history abhi load nahi hui. Ek minute baad try karo.`) };
    const f = bars[0], l = bars.at(-1);
    const note = short ? L("Charts here use daily closes, so the shortest view is 1 month. ", "Yahan chart daily closing price se bante hain, isliye sabse chhota view 1 mahina hai. ") : "";
    return {
      card: note ? { type: "chart", sym, range, note: true } : { type: "chart", sym, range },
      text: note + L(`${sym} over ${RANGE_LABEL[range]}: ${rs(f.c)} on ${day(f.t)} to ${rs(l.c)} on ${day(l.t)} (${pct((l.c - f.c) / f.c * 100)}).`,
        `${sym}, pichhle ${RANGE_HI[range]}: ${day(f.t)} ko ${rs(f.c)}, ${day(l.t)} ko ${rs(l.c)} (${pct((l.c - f.c) / f.c * 100)}).`),
    };
  }

  if (cmd === "/compare") {
    const rangeTok = args.find((a) => /^\d+\s*[a-z]+$/i.test(a));
    const names = args.filter((a) => a !== rangeTok);
    const a = resolveSymbol(names[0]), b = resolveSymbol(names[1]);
    if (!a || !b) return { text: L("Give me two stocks, like `/compare INFY TCS 1y`.", "Do stocks batao, jaise `/compare INFY TCS 1y`.") };
    const range = parseRange(rangeTok, "1y");
    const [ba, bb] = await Promise.all([realBars(a, range), realBars(b, range)]);
    if (!ba || !bb) return { text: L(`I couldn't load real price history for ${!ba ? a : b} right now.`, `${!ba ? a : b} ki asli price history abhi load nahi hui.`) };
    const ca = (ba.at(-1).c - ba[0].c) / ba[0].c * 100, cb = (bb.at(-1).c - bb[0].c) / bb[0].c * 100;
    return {
      card: { type: "compare", syms: [a, b], range },
      text: L(`Over ${RANGE_LABEL[range]}: ${a} ${pct(ca)}, ${b} ${pct(cb)}. Both start at 0% so the lines compare growth, not price.`,
        `Pichhle ${RANGE_HI[range]}: ${a} ${pct(ca)}, ${b} ${pct(cb)}. Dono 0% se shuru hote hain, toh lines growth compare karti hain, price nahi.`),
    };
  }

  if (cmd === "/whatif") {
    const amtTok = args.find((x) => parseAmount(x) != null && !/^\d+\s*(m|y|mo|yr)$/i.test(x));
    const perTok = args.find((x) => /^\d+\s*[a-z]+$/i.test(x) && x !== amtTok);
    const sym = resolveSymbol(args.filter((x) => x !== amtTok && x !== perTok).join(" "));
    const amount = parseAmount(amtTok) || 10000;
    if (!sym) return { text: L("Try `/whatif RELIANCE 10000 3y`: a stock, an amount, how long ago.", "Aise likho: `/whatif RELIANCE 10000 3y` (stock, amount, kitna pehle).") };
    const yrs = Math.max(1, Math.min(5, parseInt(perTok || "1y", 10) || 1));
    const unit = /m/i.test(perTok || "") && !/y/i.test(perTok || "") ? "m" : "y";
    const range = unit === "m" ? parseRange(perTok, "1y") : (yrs >= 2 ? "5y" : "1y");
    const [bars, nifty] = await Promise.all([realBars(sym, range), realBars("NIFTYBEES", range)]);
    if (!bars) return { text: L(`I couldn't load real price history for ${sym} right now.`, `${sym} ki asli price history abhi load nahi hui.`) };
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
      text: L(`${rs0(amount)} in ${sym} on ${day(s0.t)} would be ${rs0(value)} on ${day(s1.t)} (${pct((value / amount - 1) * 100)}).` +
        (niftyValue ? ` The same in a Nifty 50 fund: ${rs0(niftyValue)}.` : "") +
        ` In a 7% fixed deposit: ${rs0(fdValue)}. Past returns don't predict future ones.`,
        `${day(s0.t)} ko ${sym} mein ${rs0(amount)} lagaye hote toh ${day(s1.t)} ko ${rs0(value)} hote (${pct((value / amount - 1) * 100)}).` +
        (niftyValue ? ` Nifty 50 fund mein: ${rs0(niftyValue)}.` : "") +
        ` 7% FD mein: ${rs0(fdValue)}. Purane returns aage ki guarantee nahi hain.`),
    };
  }

  if (cmd === "/portfolio") {
    const st = getState();
    const hs = Object.entries(st.holdings || {});
    if (!hs.length) return { text: L(`You hold no stocks yet. Cash: ${rs(st.portfolio?.cashPaise || 0)}.`, `Abhi koi stock nahi hai. Cash: ${rs(st.portfolio?.cashPaise || 0)}.`) };
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
        ? L(`Portfolio: ${rows.length} holding${rows.length === 1 ? "" : "s"} and ${rs(cash)} cash. Live prices weren't available just now, so no value is shown.`,
            `Portfolio: ${rows.length} holdings aur ${rs(cash)} cash. Live price abhi nahi mila, isliye value nahi dikha rahe.`)
        : L(`Portfolio: ${rs(invested + cash)} total (${rs(invested)} in ${rows.length - missing.length} priced holding${rows.length - missing.length === 1 ? "" : "s"}, ${rs(cash)} cash). On paper ${pl >= 0 ? "profit" : "loss"}: ${rs(Math.abs(pl))}.` +
            (missing.length ? ` No live price for ${missing.join(", ")}.` : ""),
            `Portfolio: kul ${rs(invested + cash)} (${rs(invested)} stocks mein, ${rs(cash)} cash). On paper ${pl >= 0 ? "profit" : "loss"}: ${rs(Math.abs(pl))}.` +
            (missing.length ? ` ${missing.join(", ")} ka live price nahi mila.` : "")),
    };
  }

  if (cmd === "/explain") {
    const term = args.join(" ").trim();
    if (!term) return { text: L("Which word? Try `/explain p/e` or `/explain market cap`.", "Kaunsa word? Jaise `/explain p/e` ya `/explain market cap`.") };
    const lang = getState()?.settings?.hinglish ? "hi" : "en";
    const def = glossaryLookup(term, lang);
    if (!def) return { text: null, ask: `Explain "${term}" in simple words for a teenager.` };
    return { card: { type: "explain", term, def }, text: `${term}: ${def}` };
  }
  return { card: { type: "help", unknown: cmd }, text: L(`There's no ${cmd} command. `, `${cmd} naam ka koi command nahi hai. `) + helpText() };
}

// ---- Rendering ---------------------------------------------------------------

/** Placeholder markup; hydrateCards() draws into it. */
export function cardHtml(card) {
  if (!card?.type) return "";
  const data = esc(JSON.stringify(card));
  if (card.type === "help") return guideHtml(card);
  if (card.type === "explain") {
    return `<div class="ss-card ss-card-explain"><div class="ss-card-kicker">${L("Explained", "Matlab")}</div><div class="ss-card-title">${esc(card.term)}</div><p>${esc(card.def)}</p>
      <button type="button" class="ss-card-btn" data-card-ask="${esc(`Explain ${card.term} with an Indian stock example`)}">${L("Go deeper with Saathi", "Saathi se aur samjho")}</button></div>`;
  }
  if (card.type === "whatif") return whatifHtml(card);
  if (card.type === "portfolio") return portfolioHtml(card);
  return `<div class="ss-card ss-card-chart" data-card="${data}"><div class="ss-card-loading">${L("Loading chart…", "Chart load ho raha hai…")}</div></div>`;
}

/**
 * The command guide: what each command does, with a tap-to-run example. Shown
 * for /help, for an unknown "/word", and on an empty chat. Buttons carry
 * data-card-run (sends the example) or data-card-fill (puts it in the box).
 */
export function guideHtml(card = {}) {
  const rows = COMMANDS.filter((c) => c.cmd !== "/help").map((c) => `
    <div class="ss-guide-row">
      <div class="ss-guide-main"><code>${esc(c.cmd)}</code><span>${esc(hi() ? c.whatHi : c.what)}</span></div>
      <div class="ss-guide-acts">
        <button type="button" class="ss-card-btn is-primary" data-card-run="${esc(c.example)}">${esc(c.example)}</button>
        ${c.args ? `<button type="button" class="ss-card-btn" data-card-fill="${esc(c.cmd + " ")}">${L("Type my own", "Khud likho")}</button>` : ""}
      </div>
    </div>`).join("");
  return `<div class="ss-card ss-card-guide">
    <div class="ss-card-kicker">${card.unknown ? esc(L(`${card.unknown} isn't a command`, `${card.unknown} command nahi hai`)) : L("Saathi's tools", "Saathi ke tools")}</div>
    <div class="ss-card-title">${L("Type / for real market data, instantly", "/ likho aur asli market data turant pao")}</div>
    <p class="ss-guide-sub">${L("No AI guesswork: these answer from exchange prices and your own portfolio. Or just ask in your own words.", "Koi AI andaaza nahi: yeh exchange ke prices aur tumhare portfolio se jawab dete hain. Ya seedha apne shabdon mein pucho.")}</p>
    ${rows}
  </div>`;
}

function whatifHtml(c) {
  const best = Math.max(c.value, c.niftyValue || 0, c.fdValue);
  const bar = (label, v, cls) => `<div class="ss-wi-row ${cls}"><span>${esc(label)}</span><div class="ss-wi-bar"><i style="width:${Math.max(4, v / best * 100).toFixed(1)}%"></i></div><b>${rs0(v)}</b></div>`;
  const ret = (c.value / c.amount - 1) * 100;
  return `<div class="ss-card ss-card-whatif">
    <div class="ss-card-kicker">${L("What if", "Agar")}</div>
    <div class="ss-card-title">${rs0(c.amount)} in ${esc(c.sym)} on ${esc(day(c.from))}</div>
    <div class="ss-wi-big ${ret >= 0 ? "up" : "down"}">${rs0(c.value)} <small>${pct(ret)}</small></div>
    ${bar(c.sym, c.value, "is-main")}
    ${c.niftyValue ? bar("Nifty 50 fund", c.niftyValue, "") : ""}
    ${bar(L("7% fixed deposit", "7% FD"), c.fdValue, "")}
    <p class="ss-card-foot">${L(`Bought at ${rs(c.p0)}, worth ${rs(c.p1)} on ${esc(day(c.to))}. Past returns don't predict future ones.`, `${rs(c.p0)} pe kharida, ${esc(day(c.to))} ko ${rs(c.p1)}. Purane returns aage ki guarantee nahi.`)}</p>
    <div class="ss-card-actions"><a class="ss-card-btn" href="/stocks/${encodeURIComponent(c.sym)}">${L("Open", "Kholo")} ${esc(c.sym)}</a>
      <button type="button" class="ss-card-btn" data-card-ask="${esc(`Why did ${c.sym} do ${ret >= 0 ? "well" : "badly"} over this period compared with the Nifty?`)}">${L("Ask why", "Kyun? Pucho")}</button></div>
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
      ? `<div class="ss-card-title">${rs(c.cash)} cash</div><div class="ss-pf-sub">${L("Live prices weren't available just now, so holdings show no value. Try again in a minute.", "Live price abhi nahi mila, isliye holdings ki value nahi dikh rahi. Ek minute baad try karo.")}</div>`
      : `<div class="ss-card-title">${rs(total)}</div>
    <div class="ss-pf-sub">${rs(c.invested)} ${L("invested", "laga hai")} · ${rs(c.cash)} cash · <span class="${c.pl >= 0 ? "up" : "down"}">${c.pl >= 0 ? "+" : "−"}${rs(Math.abs(c.pl))} on paper</span>${(c.missing || []).length ? ` · ${L("no price yet for", "price nahi mila:")} ${esc(c.missing.join(", "))}` : ""}</div>`}
    ${rows}
    <div class="ss-card-actions"><a class="ss-card-btn" href="/portfolio">${L("Open portfolio", "Portfolio kholo")}</a>
      <button type="button" class="ss-card-btn" data-card-ask="How diversified is my portfolio, and what's my biggest risk?">${L("Ask about my mix", "Mera mix kaisa hai?")}</button></div>
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
  if (series.some((s) => !s)) { el.innerHTML = `<div class="ss-card-loading">${L(`Couldn't load real prices for ${esc(syms.join(" / "))} right now.`, `${esc(syms.join(" / "))} ke asli prices abhi load nahi hue.`)}</div>`; return; }

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
    ${card.note ? `<p class="ss-ch-note">${L("Daily closes only, so 1 month is the shortest view.", "Sirf daily closing price, isliye 1 mahina sabse chhota view hai.")}</p>` : ""}
    <div class="ss-ch-tools">
      <div class="ss-ch-seg" role="group" aria-label="Time range">${btn("1mo", "1M")}${btn("3mo", "3M")}${btn("6mo", "6M")}${btn("1y", "1Y")}${btn("5y", "5Y")}</div>
      ${isCompare ? "" : `<div class="ss-ch-seg" role="group" aria-label="Averages">${tog("s20", L("20-day avg", "20-din avg"))}${tog("s50", L("50-day avg", "50-din avg"))}</div>`}
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
      ${syms.map((s) => `<a class="ss-card-btn" href="/stocks/${encodeURIComponent(s)}">${L("Open", "Kholo")} ${esc(s)}</a>`).join("")}
      <button type="button" class="ss-card-btn" data-card-ask="${esc(isCompare ? `Compare how ${syms[0]} and ${syms[1]} moved over the last ${RANGE_LABEL[range]} and what might explain the difference` : `Read the ${RANGE_LABEL[range].replace(/s$/, "")} chart of ${syms[0]}`)}">${isCompare ? L("Ask what's different", "Fark kyun? Pucho") : L("Explain this chart", "Chart samjhao")}</button>
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
      (!isCompare ? `<span>${pct((vals[0][i] - vals[0][0]) / vals[0][0] * 100)} ${L("from start", "shuru se")}</span>` : "");
    tip.style.left = Math.min(r.width - 150, Math.max(0, x(i) / W * r.width - 60)) + "px";
  };
  svg.addEventListener("pointermove", (e) => move(e.clientX));
  svg.addEventListener("pointerdown", (e) => move(e.clientX));
  svg.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
}

/** Draw every card placeholder inside `root`; wire range buttons and ask buttons. */
export function hydrateCards(root, { onAsk, onRun, onFill } = {}) {
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
    const run = e.target.closest("[data-card-run]");
    const fill = e.target.closest("[data-card-fill]");
    if (run) { (onRun || onAsk)?.(run.dataset.cardRun); return; }
    if (fill) { onFill?.(fill.dataset.cardFill); return; }
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
