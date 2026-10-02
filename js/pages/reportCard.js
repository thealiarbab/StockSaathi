// =============================================================================
// REPORT CARD — Behavioral analysis of the user's trades.
// Metrics: bias hit rate, self-override rate, concentration, churn, discipline.
// Assigns a letter grade. Awards badges.
// =============================================================================

import { getState, subscribe, getPortfolioReturnPct, getPortfolioValue } from "../state.js";
import { formatRupees, formatPct, deltaClass } from "../money.js";
import { runDetectors, ALL_DETECTORS } from "../coach/biasDetectors.js";
import { getInstrument, SECTORS } from "../data/universe.js";
import { getPriceAt } from "../data/prices.js";
import { aiLang } from "../features/aiLang.js";

let aiCard = null;           // { narrative, strengths, watchouts } | null
let aiCardLoading = false;
let aiCardSignature = null;  // last user-signature we requested — refire only when stats meaningfully change

const BADGES = [
  { code: "first_trade",    title: "First Steps",    emoji: "🌱", desc: "Placed your first trade" },
  { code: "diversified",    title: "Well Diversified", emoji: "🪻", desc: "Held ≥5 positions across ≥3 sectors" },
  { code: "held_through_dip", title: "Held the Line", emoji: "🛡", desc: "Overrode a panic-sell signal" },
  { code: "time_traveler",  title: "Time Traveler",  emoji: "⏱", desc: "Completed a crash replay scenario" },
  { code: "coach_listener", title: "Coach Listener", emoji: "🎓", desc: "Received 10+ coach messages" },
  { code: "no_fomo",        title: "No FOMO",        emoji: "🧘", desc: "No pump-chase flags in last 30 days" },
  { code: "long_term",      title: "Long Termer",    emoji: "🏛", desc: "Held a position for ≥30 days" },
  { code: "curious",        title: "Curious",        emoji: "🔭", desc: "Viewed 10+ different stocks" },
];

export function renderReportCard(main) {
  render();
  // Kick off the AI narrative fetch once on mount
  const initialState = getState();
  maybeFetchAiCard(initialState).then(d => { if (d) { aiCard = d; aiCardLoading = false; render(); } });
  const unsub = subscribe(render);
  window.addEventListener("ss:navigate", () => unsub?.(), { once: true });

  function render() {
    const state = getState();
    const analysis = analyzeBehavior(state);
    const earnedBadges = computeBadges(state, analysis);

    main.innerHTML = `
      <div style="margin-bottom: var(--sp-6);">
        <h1 style="font-size: var(--text-3xl); letter-spacing: -0.02em; margin-bottom: var(--sp-2);">Report Card</h1>
        <p class="muted">Your behavioral fingerprint. Updates with every decision.</p>
      </div>

      ${renderAiCard()}

      <div class="report-grade" style="--pct: ${analysis.score};">
        <div class="report-grade-circle">
          <span class="letter">${analysis.grade}</span>
        </div>
        <div>
          <div style="font-size: var(--text-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Overall</div>
          <div style="font-size: var(--text-2xl); font-weight: 700; margin-bottom: var(--sp-2);">${analysis.title}</div>
          <p class="muted" style="max-width: 420px; line-height: 1.6;">${analysis.summary}</p>
          <div class="flex gap-2 wrap" style="margin-top: var(--sp-3);">
            <span class="pill pill-neutral">${state.transactions.length} trades</span>
            <span class="pill pill-neutral">${Object.keys(state.holdings).length} positions</span>
            <span class="pill pill-neutral">${state.coachMessages.length} coach messages</span>
          </div>
        </div>
      </div>

      <div class="grid" style="grid-template-columns: 1fr 1fr; gap: var(--sp-6);">
        <div class="card">
          <h3 style="margin-bottom: var(--sp-4);">Behavior patterns</h3>
          <div class="behavior-list">
            ${renderBehaviorRow("Panic sells", analysis.panicSellCount, analysis.panicSellCount === 0 ? "good" : analysis.panicSellCount < 2 ? "warn" : "bad",
              analysis.panicSellCount === 0 ? "Great discipline — you held through drops." : `Sold during a sharp drop ${analysis.panicSellCount} time${analysis.panicSellCount === 1 ? "" : "s"}.`)}
            ${renderBehaviorRow("Panic-sells averted", analysis.interventionHolds, "good",
              analysis.interventionHolds ? `You heeded the intervention modal ${analysis.interventionHolds} time${analysis.interventionHolds === 1 ? "" : "s"}.` : "No interventions triggered yet — and that's fine.")}
            ${renderBehaviorRow("FOMO / pump-chasing", analysis.fomoCount, analysis.fomoCount === 0 ? "good" : "warn",
              analysis.fomoCount === 0 ? "Clean — no chasing recent runners." : `Bought after a fast run-up ${analysis.fomoCount} time${analysis.fomoCount === 1 ? "" : "s"}.`)}
            ${renderBehaviorRow("Churning", analysis.churnFlags, analysis.churnFlags === 0 ? "good" : "warn",
              analysis.churnFlags === 0 ? "Low-frequency, high-intention." : "Repeatedly flipped the same symbol.")}
            ${renderBehaviorRow("Single-stock concentration", analysis.concentrationPct + "%", analysis.concentrationPct < 30 ? "good" : analysis.concentrationPct < 45 ? "warn" : "bad",
              analysis.topHolding ? `Largest position: ${analysis.topHolding}.` : "No positions yet.")}
            ${renderBehaviorRow("Sector concentration", analysis.sectorPct + "%", analysis.sectorPct < 50 ? "good" : analysis.sectorPct < 70 ? "warn" : "bad",
              analysis.topSector ? `Heaviest sector: ${analysis.topSector}.` : "No sector exposure yet.")}
          </div>
        </div>

        <div class="card">
          <h3 style="margin-bottom: var(--sp-4);">The self-override rate</h3>
          <p class="muted" style="font-size: var(--text-sm); line-height: 1.6;">
            Of all the times the coach flagged a potential panic-sell, you chose to
            <strong>hold</strong> <span class="tabular">${analysis.selfOverrideRate}%</span> of the time.
          </p>
          <div style="margin: var(--sp-4) 0;">
            <div style="height: 8px; background: var(--bg-subtle); border-radius: 4px; overflow: hidden;">
              <div style="height: 100%; width: ${analysis.selfOverrideRate}%; background: linear-gradient(90deg, var(--brand), var(--positive)); transition: width 400ms ease;"></div>
            </div>
          </div>
          <p class="muted" style="font-size: var(--text-xs); line-height: 1.6;">
            This is the one metric that actually predicts real-world investing outcomes.
            Above 70% indicates strong behavioral discipline. Above 90% means you've
            internalised the lesson most retail investors never learn.
          </p>
        </div>
      </div>

      <div class="card" style="margin-top: var(--sp-6);">
        <div class="card-head">
          <h3>Badges</h3>
          <span class="dim" style="font-size: var(--text-xs);">${earnedBadges.size} / ${BADGES.length} earned</span>
        </div>
        <div class="badges-grid">
          ${BADGES.map(b => {
            const earned = earnedBadges.has(b.code);
            return `
              <div class="badge-card ${earned ? "earned" : "locked"}" aria-label="${escapeHtml(b.title)}">
                <div class="emoji">${b.emoji}</div>
                <div class="title">${escapeHtml(b.title)}</div>
                <div class="desc">${escapeHtml(b.desc)}</div>
              </div>
            `;
          }).join("")}
        </div>
      </div>

      ${state.transactions.length === 0 ? `
        <div class="card" style="margin-top: var(--sp-6); text-align: center; padding: var(--sp-8);">
          <span class="emoji" style="font-size: 48px;">📋</span>
          <h3 style="margin: var(--sp-3) 0;">Your report card grows with you</h3>
          <p class="muted" style="max-width: 480px; margin: 0 auto;">Place a few trades. Try a panic-sell. Run a crash replay. Come back — the data here will tell you more about yourself than any personality test.</p>
          <div style="margin-top: var(--sp-5);"><a href="/stocks" class="btn btn-primary">Browse markets</a></div>
        </div>
      ` : ""}
    `;
  }
}

function analyzeBehavior(state) {
  const txns = state.transactions;
  const coachMessages = state.coachMessages;

  // Count panic-sells (from coach messages)
  const panicSellCount = coachMessages.filter(m =>
    m.biases?.some(b => b.bias === "panic_sell") && m.eventType === "SELL"
  ).length;
  const interventionHolds = coachMessages.filter(m => m.eventType === "INTERVENTION_HOLD").length;
  const fomoCount = coachMessages.filter(m =>
    m.biases?.some(b => b.bias === "fomo" || b.bias === "pump_chase")
  ).length;
  const churnFlags = coachMessages.filter(m =>
    m.biases?.some(b => b.bias === "churning")
  ).length;

  const totalPanicSituations = panicSellCount + interventionHolds;
  const selfOverrideRate = totalPanicSituations > 0
    ? Math.round((interventionHolds / totalPanicSituations) * 100)
    : 100;

  // Concentration
  const pfValue = getPortfolioValue(state);
  let topValue = 0, topSym = null;
  const bySector = {};
  for (const [sym, h] of Object.entries(state.holdings)) {
    const inst = getInstrument(sym);
    if (!inst) continue;
    const px = getPriceAt(sym, 0);
    const v = Math.round(h.qty * px);
    if (v > topValue) { topValue = v; topSym = inst.name; }
    bySector[inst.sector] = (bySector[inst.sector] || 0) + v;
  }
  const concentrationPct = pfValue > 0 ? Math.round((topValue / pfValue) * 100) : 0;
  const sectorEntries = Object.entries(bySector).sort((a, b) => b[1] - a[1]);
  const topSector = sectorEntries[0]?.[0] || null;
  const sectorPct = (pfValue > 0 && sectorEntries[0])
    ? Math.round((sectorEntries[0][1] / pfValue) * 100)
    : 0;

  // Grade calculation
  let score = 75;
  score -= panicSellCount * 10;
  score += interventionHolds * 8;
  score -= fomoCount * 5;
  score -= churnFlags * 6;
  if (concentrationPct > 50) score -= 8;
  if (sectorPct > 70) score -= 6;
  if (coachMessages.length >= 5) score += 3;
  const returnPct = getPortfolioReturnPct(state) * 100;
  if (returnPct > 0) score += Math.min(10, returnPct);
  score = Math.max(10, Math.min(100, score));

  let grade, title, summary;
  if (score >= 90) {
    grade = "A+"; title = "Disciplined trader";
    summary = "Strong behavioral hygiene. You're making fewer of the classic mistakes than most retail investors in year 1.";
  } else if (score >= 80) {
    grade = "A"; title = "Thoughtful";
    summary = "Consistent decision-making. A few tweaks from elite.";
  } else if (score >= 70) {
    grade = "B+"; title = "Steady learner";
    summary = "You're on the right track. Watch for emotional trades during drops.";
  } else if (score >= 60) {
    grade = "B"; title = "Developing";
    summary = "Behavioral patterns are showing. This is exactly when reflection matters most.";
  } else if (score >= 50) {
    grade = "C"; title = "Reactive";
    summary = "Your decisions are moving with short-term price. The coach has messages for this — read them.";
  } else {
    grade = "D"; title = "Needs review";
    summary = "Multiple bias patterns flagged. Start by running a crash replay to recalibrate.";
  }

  return {
    score, grade, title, summary,
    panicSellCount, interventionHolds, fomoCount, churnFlags,
    concentrationPct, topHolding: topSym, topSector, sectorPct,
    selfOverrideRate,
  };
}

function computeBadges(state, analysis) {
  const earned = new Set();
  if (state.transactions.length > 0) earned.add("first_trade");
  const holdings = Object.entries(state.holdings);
  if (holdings.length >= 5) {
    const sectors = new Set(holdings.map(([s]) => getInstrument(s)?.sector).filter(Boolean));
    if (sectors.size >= 3) earned.add("diversified");
  }
  if (analysis.interventionHolds > 0) earned.add("held_through_dip");
  if (state.demo.crashReplayCompleted.length > 0) earned.add("time_traveler");
  if (state.coachMessages.length >= 10) earned.add("coach_listener");
  if (analysis.fomoCount === 0 && state.transactions.length >= 3) earned.add("no_fomo");
  // Long-term held: any holding >30 days old
  const longTerm = holdings.some(([_, h]) => (Date.now() - h.firstBoughtAt) > 30 * 86400000);
  if (longTerm) earned.add("long_term");
  // We track "viewed stocks" via coachMessages with STOCK_INTRO
  const viewedStocks = new Set(state.coachMessages.filter(m => m.eventType === "STOCK_INTRO").map(m => m.triggerSymbol));
  if (viewedStocks.size >= 10) earned.add("curious");
  return earned;
}

function renderBehaviorRow(name, count, tone, desc) {
  const icons = { good: "✓", warn: "!", bad: "×" };
  return `
    <div class="behavior-row">
      <div class="icon ${tone}">${icons[tone] || "•"}</div>
      <div>
        <div class="name">${name}</div>
        <div class="desc">${escapeHtml(desc)}</div>
      </div>
      <div class="count tabular ${tone === "good" ? "up" : tone === "bad" ? "down" : ""}">${count}</div>
    </div>
  `;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}

function renderAiCard() {
  if (!aiCard && !aiCardLoading) return "";
  if (aiCardLoading && !aiCard) {
    return `
      <div class="pf-digest-card mood-flat loading" style="margin-bottom: var(--sp-5);">
        <div class="pf-digest-head"><span class="pf-digest-label">Saathi</span><span class="dim text-xs">reading your file…</span></div>
        <div class="pf-digest-body skeleton" style="height: 48px; border-radius: 6px;"></div>
      </div>
    `;
  }
  const sList = (aiCard.strengths || []).map(s => `<li>${escapeHtml(s)}</li>`).join("");
  const wList = (aiCard.watchouts || []).map(s => `<li>${escapeHtml(s)}</li>`).join("");
  return `
    <div class="pf-digest-card mood-up" style="margin-bottom: var(--sp-5);">
      <div class="pf-digest-head"><span class="pf-digest-label">Saathi</span></div>
      <div class="pf-digest-body" style="margin-bottom: var(--sp-3);">${escapeHtml(aiCard.narrative || "")}</div>
      <div class="report-ai-grid">
        ${sList ? `<div><h4 class="up" style="font-size:var(--text-sm);margin:0 0 6px 0;">Strengths</h4><ul class="report-ai-list">${sList}</ul></div>` : ""}
        ${wList ? `<div><h4 class="down" style="font-size:var(--text-sm);margin:0 0 6px 0;">Watch-outs</h4><ul class="report-ai-list">${wList}</ul></div>` : ""}
      </div>
    </div>
  `;
}

function signatureOf(state) {
  // Trigger regen on meaningful stat movement only.
  const tx = state.transactions.length;
  const holds = Object.keys(state.holdings).length;
  return `${tx}|${holds}|${Math.round(getPortfolioReturnPct(state) * 1000)}`;
}

async function maybeFetchAiCard(state) {
  const sig = signatureOf(state);
  if (aiCardSignature === sig && aiCard) return null;
  aiCardSignature = sig;
  aiCardLoading = true;

  // Build the stats payload. Compute win-rate + biggest win/loss + avg hold-days
  // from transactions. Bias flags come from runDetectors on each trade.
  const txs = state.transactions || [];
  let wins = 0, losses = 0, biggestWin = 0, biggestLoss = 0;
  let totalHoldDays = 0, closedCount = 0;
  const avgByBuy = {};
  for (const t of txs) {
    if (t.side === "BUY") {
      avgByBuy[t.symbol] = avgByBuy[t.symbol] || { qty: 0, cost: 0, firstAt: t.ts };
      avgByBuy[t.symbol].qty += t.qty;
      avgByBuy[t.symbol].cost += t.qty * t.pricePaise;
    } else if (t.side === "SELL") {
      const b = avgByBuy[t.symbol];
      if (b?.qty) {
        const avgCost = b.cost / b.qty;
        const pl = (t.pricePaise - avgCost) * t.qty;
        if (pl > 0) { wins++; if (pl > biggestWin) biggestWin = pl; }
        else if (pl < 0) { losses++; if (-pl > biggestLoss) biggestLoss = -pl; }
        b.qty -= t.qty;
        b.cost -= avgCost * t.qty;
        const holdDays = (t.ts - b.firstAt) / 86400000;
        totalHoldDays += holdDays;
        closedCount++;
      }
    }
  }
  const sectorCounts = {};
  for (const [sym] of Object.entries(state.holdings || {})) {
    const inst = getInstrument(sym);
    if (inst?.sector) sectorCounts[inst.sector] = (sectorCounts[inst.sector] || 0) + 1;
  }
  const topSectors = Object.entries(sectorCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s);

  const biasFlagSet = new Set();
  for (const msg of state.coachMessages || []) {
    (msg.biases || []).forEach(b => biasFlagSet.add(b.bias || b));
  }

  try {
    const res = await fetch("/api/ai?op=report-card" + aiLang(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        totalTrades: txs.length,
        winRate: (wins + losses) ? wins / (wins + losses) : 0,
        biggestWin: Math.round(biggestWin / 100),
        biggestLoss: Math.round(biggestLoss / 100),
        avgHoldDays: closedCount ? Math.round(totalHoldDays / closedCount) : 0,
        biasFlags: [...biasFlagSet],
        portfolioReturnPct: getPortfolioReturnPct(state) * 100,
        topSectors,
        startedAt: state.portfolio?.startedAt ? new Date(state.portfolio.startedAt).toLocaleDateString("en-IN") : "",
      }),
    });
    if (!res.ok) throw new Error("http_" + res.status);
    const data = await res.json();
    if (!data?.narrative) throw new Error("no_narrative");
    return data;
  } catch (e) {
    aiCardLoading = false;
    return null;
  }
}
