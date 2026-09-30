// =============================================================================
// ONBOARDING — 3 quick steps.
//   1) Welcome
//   2) Profile (school + class — optional)
//   3) Investing style
// =============================================================================

import { getState, completeOnboarding } from "../state.js";
import { navigate } from "../router.js";
import { toast } from "../components/toast.js";

let step = 0;
let form = {
  age: 16,
  school: "",
  classCode: "",
  riskProfile: null,
};

const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "profile", label: "Profile" },
  { id: "style",   label: "Style" },
];

export function renderOnboarding(main) {
  step = 0;
  const s = getState();
  if (s.user.age) form.age = s.user.age;
  if (s.user.school) form.school = s.user.school;
  if (s.user.classCode) form.classCode = s.user.classCode;
  if (s.user.riskProfile) form.riskProfile = s.user.riskProfile;
  render(main);
}

function render(main) {
  main.innerHTML = `
    <div class="onboard-wrap">
      <div class="onboard-steps">
        ${STEPS.map((s, i) => `
          <div class="onboard-step ${i === step ? "active" : i < step ? "done" : ""}">
            <div class="dot">${i < step ? "✓" : i + 1}</div>
            <div class="label">${s.label}</div>
          </div>
        `).join("")}
      </div>

      <div class="card" style="padding: var(--sp-6);">
        ${renderStep(step)}
      </div>
    </div>
  `;

  attachStepListeners(main);
}

function renderStep(s) {
  switch (s) {
    case 0: return `
      <div style="text-align: center;">
        <div style="font-size: 48px; margin-bottom: var(--sp-3);">📈</div>
        <h2 style="font-size: var(--text-2xl); margin-bottom: var(--sp-2);">Welcome to StockSaathi</h2>
        <p class="muted" style="max-width: 400px; margin: 0 auto var(--sp-5); line-height: 1.6;">
          You start with <strong style="color: var(--text-strong);">₹1,00,000 of virtual money</strong> to invest in real Indian stocks, ETFs and mutual funds. An AI coach reflects on every trade — never tells you what to buy.
        </p>
        <div style="max-width: 460px; margin: 0 auto var(--sp-5); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg-soft); text-align: left; font-size: var(--text-xs); line-height: 1.6; color: var(--text-muted);">
          <strong style="color: var(--text-strong);">Quick heads-up:</strong> StockSaathi is an
          <strong>educational paper-trading simulator</strong>. You are <em>not</em> buying real
          shares, and StockSaathi is not a SEBI-registered broker or investment adviser. Nothing
          here is investment advice. The prices are real; your money is not.
        </div>
        <button class="btn btn-primary btn-lg" data-next>Got it, get started →</button>
      </div>
    `;
    case 1: return `
      <h2 style="margin-bottom: var(--sp-4);">A bit about you</h2>
      <div class="flex-col gap-4">
        <div>
          <label class="label" for="f-age">Age</label>
          <input class="input" id="f-age" type="number" min="13" max="100" value="${form.age}" />
        </div>
        <div>
          <label class="label" for="f-school">School / college (optional)</label>
          <input class="input" id="f-school" placeholder="e.g. DPS R.K. Puram" value="${escapeAttr(form.school)}" />
        </div>
        <div>
          <label class="label" for="f-class">Class / batch code (optional)</label>
          <input class="input" id="f-class" placeholder="e.g. 12-Science or FINED-A" value="${escapeAttr(form.classCode)}" />
          <div class="dim text-xs" style="margin-top: 4px;">Useful if your teacher groups your class together for challenges.</div>
        </div>
      </div>
      <div class="flex gap-2 wrap justify-between" style="margin-top: var(--sp-5);">
        <button class="btn btn-outline" data-back>Back</button>
        <button class="btn btn-primary" data-next>Continue</button>
      </div>
    `;
    case 2: return `
      <h2 style="margin-bottom: var(--sp-2);">What's your style?</h2>
      <p class="muted text-md" style="margin-bottom: var(--sp-5); line-height: 1.6;">
        This tunes the coach's tone. You can buy or sell anything regardless.
      </p>

      <div class="risk-cards">
        <button type="button" class="risk-card ${form.riskProfile === "cautious" ? "selected" : ""}" data-risk="cautious">
          <div class="risk-icon">🛡</div>
          <div class="risk-title">Cautious</div>
          <div class="risk-desc">Index funds and blue-chips. Understand the basics safely.</div>
        </button>
        <button type="button" class="risk-card ${form.riskProfile === "balanced" ? "selected" : ""}" data-risk="balanced">
          <div class="risk-icon">⚖️</div>
          <div class="risk-title">Balanced</div>
          <div class="risk-desc">Large-caps plus a few growth names. Moderate volatility.</div>
        </button>
        <button type="button" class="risk-card ${form.riskProfile === "bold" ? "selected" : ""}" data-risk="bold">
          <div class="risk-icon">🚀</div>
          <div class="risk-title">Bold</div>
          <div class="risk-desc">New-age, high-beta. Bigger swings — I want to feel them.</div>
        </button>
      </div>

      <div class="flex gap-2 wrap justify-between" style="margin-top: var(--sp-5);">
        <button class="btn btn-outline" data-back>Back</button>
        <button class="btn btn-primary" data-finish ${form.riskProfile ? "" : "disabled"}>Open my portfolio →</button>
      </div>
    `;
  }
}

function attachStepListeners(main) {
  main.querySelector("[data-next]")?.addEventListener("click", () => {
    if (step === 1) {
      form.age = parseInt(main.querySelector("#f-age").value, 10);
      form.school = main.querySelector("#f-school").value.trim();
      form.classCode = main.querySelector("#f-class").value.trim();
      if (!form.age || form.age < 13) { alert("Please enter a valid age (13+)."); return; }
    }
    step++;
    render(main);
  });
  main.querySelector("[data-back]")?.addEventListener("click", () => {
    step = Math.max(0, step - 1);
    render(main);
  });
  main.querySelectorAll("[data-risk]").forEach(btn => {
    btn.addEventListener("click", () => {
      form.riskProfile = btn.dataset.risk;
      render(main);
    });
  });
  main.querySelector("[data-finish]")?.addEventListener("click", (e) => {
    if (!form.riskProfile) { alert("Pick a style."); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Opening portfolio…";
    // completeOnboarding is now synchronous for local state (so the route
    // guard sees onboarded:true right away) and fires the DB write in the
    // background. No race needed — navigation is always safe.
    completeOnboarding({
      age: form.age,
      school: form.school || null,
      classCode: form.classCode || null,
      riskProfile: form.riskProfile,
    });
    toast({ kind: "success", message: "Welcome to StockSaathi. ₹1,00,000 ready to deploy." });
    navigate("/portfolio");
  });
}

function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
