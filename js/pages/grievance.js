// =============================================================================
// GRIEVANCE — Public contact page for IT Rules 2021 + DPDP Rules 2025 compliance.
// Route: /grievance. Public.
// =============================================================================

export function renderGrievance(main) {
  main.innerHTML = `
    <div style="max-width: 740px; margin: 0 auto;">
      <h1>Grievance Officer</h1>
      <p class="muted" style="margin: var(--sp-2) 0 var(--sp-5);">
        How to contact us with a complaint, a data-protection request, or a takedown notice.
      </p>

      <div class="card" style="margin-bottom: var(--sp-4); background: var(--bg-soft);">
        <h3 style="margin-bottom: var(--sp-3);">Contact</h3>
        <p class="text-sm" style="line-height: 1.75; font-family: var(--font-mono, monospace);">
          <strong>Grievance Officer &mdash; StockSaathi</strong><br/>
          Email: <a href="mailto:grievance@stocksaathi.co.in">grievance@stocksaathi.co.in</a><br/>
          Response SLA: within <strong>7 working days</strong>.
        </p>
        <p class="text-sm" style="line-height: 1.75; margin-top: var(--sp-3);">
          If your complaint involves content that needs to be removed, we aim to act
          within <strong>72 hours</strong> of a valid notice (or <strong>24 hours</strong> for
          the categories listed under Rule 3(2)(b) of the IT Rules, 2021).
        </p>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-3);">What to write to us about</h3>
        <ul class="text-sm" style="line-height: 1.9; padding-left: var(--sp-5); margin: 0;">
          <li>A request to <strong>access, correct, or erase</strong> your personal data under the DPDP Act 2023.</li>
          <li>A request to exercise your right to <strong>nominate</strong> another person to act on your behalf.</li>
          <li>A complaint about something that appears on the service and should not (e.g. impersonation, harassment, misleading content).</li>
          <li>A <strong>takedown notice</strong> from a rights holder or government authority.</li>
          <li>A <strong>dispute</strong> about the operation of the simulator (e.g. incorrect trade execution,
              stuck balance, account lockout).</li>
          <li>Any question about this Privacy Policy or these Terms.</li>
        </ul>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-3);">What to include</h3>
        <p class="text-sm" style="line-height: 1.75;">
          To help us respond quickly, please include:
        </p>
        <ul class="text-sm" style="line-height: 1.9; padding-left: var(--sp-5); margin: var(--sp-2) 0 0;">
          <li>Your registered email on StockSaathi (if you have an account).</li>
          <li>A clear description of the issue or request.</li>
          <li>Screenshots or URLs if applicable.</li>
          <li>If you are a parent writing about a minor&rsquo;s account, the minor&rsquo;s account email.</li>
          <li>If you are a rights holder, a description of the material and your claim to it.</li>
        </ul>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-3);">Escalation</h3>
        <p class="text-sm" style="line-height: 1.75;">
          If you are not satisfied with the response from the grievance officer, you may
          escalate:
        </p>
        <ul class="text-sm" style="line-height: 1.9; padding-left: var(--sp-5); margin: var(--sp-2) 0 0;">
          <li>
            <strong>Data-protection matters</strong> &mdash; to the Data Protection Board of India
            once its operational contact details are published by the Ministry of
            Electronics and Information Technology.
          </li>
          <li>
            <strong>Content and intermediary matters</strong> &mdash; to the appropriate authority
            under the IT Rules, 2021.
          </li>
        </ul>
        <p class="text-sm" style="line-height: 1.75; margin-top: var(--sp-3);">
          <strong>Note:</strong> StockSaathi is a non-commercial educational simulator and is
          not a SEBI-registered intermediary. Investor grievances about real-world securities
          transactions should be raised with a SEBI-registered broker or through
          <a href="https://scores.sebi.gov.in/" target="_blank" rel="noopener noreferrer">SEBI SCORES</a>.
          StockSaathi cannot adjudicate real-market grievances because no real trading occurs
          on this service.
        </p>
      </div>

      <div class="flex gap-3" style="margin: var(--sp-6) 0 var(--sp-8); flex-wrap: wrap;">
        <a href="/privacy" class="btn btn-ghost">Privacy Policy</a>
        <a href="/terms" class="btn btn-ghost">Terms of Use</a>
        <a href="/" class="btn btn-ghost">Back home</a>
      </div>
    </div>
  `;
}
