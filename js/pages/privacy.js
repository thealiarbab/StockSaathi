// =============================================================================
// PRIVACY POLICY — Static legal page. DPDP Act 2023 + DPDP Rules 2025 aligned.
// Route: /privacy. No auth required.
// =============================================================================

export function renderPrivacy(main) {
  main.innerHTML = `
    <div style="max-width: 820px; margin: 0 auto;">
      <h1>Privacy Policy</h1>
      <p class="muted" style="margin: var(--sp-2) 0 var(--sp-5);">
        Last updated: 23 April 2026 &middot; Effective immediately.
      </p>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <p class="text-sm" style="line-height: 1.75;">
          StockSaathi (&ldquo;we&rdquo;, &ldquo;us&rdquo;) is an educational paper-trading simulator
          operated as a personal / student project at no charge to users. This policy explains
          what personal data we collect, why we collect it, how long we keep it, who we share
          it with, and the rights you have under India&rsquo;s Digital Personal Data Protection
          Act, 2023 (&ldquo;DPDP Act&rdquo;) and the DPDP Rules, 2025.
        </p>
        <p class="text-sm" style="line-height: 1.75; margin-top: var(--sp-3);">
          If you are a minor (under 18 years old in India), a parent or lawful guardian must
          provide verifiable consent before we process your personal data. Contact details for
          the grievance officer are at the bottom of this page.
        </p>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-3);">1. Who is the data fiduciary</h3>
        <p class="text-sm" style="line-height: 1.75;">
          StockSaathi is the data fiduciary for the information you provide while using this
          service. The service is hosted on Vercel Inc. (United States) and backed by Supabase
          Inc. (United States). Those companies act as data processors on our behalf.
        </p>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-3);">2. What personal data we collect</h3>
        <p class="text-sm" style="line-height: 1.75;">
          <strong>Account data:</strong> email address, display name, chosen handle, password
          (stored hashed), date of account creation.
        </p>
        <p class="text-sm" style="line-height: 1.75; margin-top: var(--sp-2);">
          <strong>Profile data you provide:</strong> optional avatar, bio, age band, school
          name (if you add it), interests.
        </p>
        <p class="text-sm" style="line-height: 1.75; margin-top: var(--sp-2);">
          <strong>Simulation data:</strong> virtual trades, virtual portfolio holdings, virtual
          cash balance, virtual watchlist, virtual transfers between users. <em>None of this
          reflects real securities, real money, or a real brokerage account.</em>
        </p>
        <p class="text-sm" style="line-height: 1.75; margin-top: var(--sp-2);">
          <strong>Coach interaction data:</strong> messages you send to the AI coach, responses
          the coach returns, behavioural signals (e.g. panic-sell detection, FOMO scoring) we
          compute from your simulated trades. These are shown back to you as reflection
          prompts; they are not sold or shared externally.
        </p>
        <p class="text-sm" style="line-height: 1.75; margin-top: var(--sp-2);">
          <strong>Technical data:</strong> IP address (seen by our hosting provider), user
          agent, referral URL, session timestamps. We do not set advertising cookies.
        </p>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-3);">3. Why we collect it (purposes)</h3>
        <ul class="text-sm" style="line-height: 1.9; padding-left: var(--sp-5); margin: 0;">
          <li>To create and maintain your account on the simulator.</li>
          <li>To show your simulated portfolio and watchlist.</li>
          <li>To provide the AI coach&rsquo;s behavioural reflection and educational prompts.</li>
          <li>To let you transfer virtual money between your friends on the platform.</li>
          <li>To debug the service and prevent abuse (rate limits, spam signup blocks).</li>
          <li>To comply with legal obligations that apply to us as a data fiduciary.</li>
        </ul>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-3);">4. Legal basis for processing</h3>
        <p class="text-sm" style="line-height: 1.75;">
          We process your personal data on the basis of your consent, given when you
          tick the acknowledgement at signup and each time you use features (coach,
          friends) that clearly require that data. You can withdraw consent
          at any time by deleting your account (Settings &rarr; Danger Zone &rarr; Delete account).
        </p>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-3);">5. Retention</h3>
        <p class="text-sm" style="line-height: 1.75;">
          Account + simulation data: retained while your account is active, deleted within 30
          days of you deleting the account. Coach chat history: can be cleared at any time
          from Settings. Backups may retain data for up to a further 90 days before being
          fully purged.
        </p>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-3);">6. Third parties we share data with</h3>
        <ul class="text-sm" style="line-height: 1.9; padding-left: var(--sp-5); margin: 0;">
          <li><strong>Supabase Inc.</strong> (US) &mdash; stores your account, profile, simulated trades.</li>
          <li><strong>Vercel Inc.</strong> (US) &mdash; hosts the app and its serverless functions.</li>
          <li><strong>Google (Gemini via Vertex AI)</strong> &mdash; the LLM that generates coach responses.
            Coach messages are sent to Google and subject to Google&rsquo;s enterprise
            data-retention terms.</li>
          <li><strong>Anthropic</strong> (optional, only if the user brings their own key) &mdash; alternative LLM backend.</li>
          <li><strong>Yahoo Finance, CoinGecko, AMFI/MFAPI</strong> &mdash; public price feeds we
            query anonymously on your behalf; no personal data is shared with them.</li>
        </ul>
        <p class="text-sm" style="line-height: 1.75; margin-top: var(--sp-3);">
          We do not sell your personal data. We do not share it with advertisers or data
          brokers. We do not use it to build advertising profiles.
        </p>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-3);">7. Cross-border data transfer</h3>
        <p class="text-sm" style="line-height: 1.75;">
          Because our hosting and LLM providers are based in the United States, your data
          is transferred out of India for processing. By using StockSaathi you consent to
          this transfer. The Government of India may notify restricted jurisdictions under
          Section 16 of the DPDP Act; we will comply with any such restriction as it
          applies.
        </p>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-3);">8. Children&rsquo;s data (under 18)</h3>
        <p class="text-sm" style="line-height: 1.75;">
          StockSaathi is an educational tool designed to be usable by teenagers learning
          about markets. If you are under 18, please use the service with the knowledge and
          consent of a parent or lawful guardian. A parent may email the grievance officer
          below at any time to request that we erase a minor&rsquo;s account and all associated
          data.
        </p>
        <p class="text-sm" style="line-height: 1.75; margin-top: var(--sp-3);">
          We do not use children&rsquo;s personal data for advertising, tracking across third-party
          websites, or targeted profiling. The behavioural coach operates only on
          the user&rsquo;s own simulated trades inside the app and exists solely to return
          educational reflection to that same user.
        </p>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-3);">9. Your rights</h3>
        <p class="text-sm" style="line-height: 1.75;">Under the DPDP Act you have the right to:</p>
        <ul class="text-sm" style="line-height: 1.9; padding-left: var(--sp-5); margin: var(--sp-2) 0 0;">
          <li><strong>Access</strong> the personal data we hold about you.</li>
          <li><strong>Correct or update</strong> any inaccurate data.</li>
          <li><strong>Erase</strong> your data (by deleting your account).</li>
          <li><strong>Nominate</strong> another person to exercise these rights on your behalf if you are unable to.</li>
          <li><strong>Grievance redressal</strong> &mdash; see the next section.</li>
        </ul>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-3);">10. Grievance officer</h3>
        <p class="text-sm" style="line-height: 1.75;">
          For any data-protection question, complaint, or a request to exercise the rights
          above, please write to:
        </p>
        <p class="text-sm" style="line-height: 1.75; margin-top: var(--sp-3); font-family: var(--font-mono, monospace);">
          <strong>Grievance Officer &mdash; StockSaathi</strong><br/>
          Email: <a href="mailto:grievance@stocksaathi.co.in">grievance@stocksaathi.co.in</a><br/>
          Response SLA: within 7 working days.
        </p>
        <p class="text-sm" style="line-height: 1.75; margin-top: var(--sp-3);">
          If you are not satisfied with our response you may escalate to the Data Protection
          Board of India once it is operational. See the Ministry of Electronics and
          Information Technology&rsquo;s DPDP Board notification for contact details.
        </p>
      </div>

      <div class="card" style="margin-bottom: var(--sp-4);">
        <h3 style="margin-bottom: var(--sp-3);">11. Changes to this policy</h3>
        <p class="text-sm" style="line-height: 1.75;">
          We will update this page when the way we collect or use data materially changes.
          The &ldquo;Last updated&rdquo; date at the top reflects the latest revision.
        </p>
      </div>

      <div class="flex gap-3" style="margin: var(--sp-6) 0 var(--sp-8); flex-wrap: wrap;">
        <a href="/terms" class="btn btn-ghost">Terms of Use</a>
        <a href="/grievance" class="btn btn-ghost">Grievance contact</a>
        <a href="/" class="btn btn-ghost">Back home</a>
      </div>
    </div>
  `;
}
