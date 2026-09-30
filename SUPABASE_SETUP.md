# StockSaathi — 10-minute production setup

Ship to real users with a real Postgres backend, cross-device accounts, email from `accounts@stocksaathi.co.in`, and an LLM coach that handles any load.

---

## 1. Supabase project (3 min)

1. Go to **https://supabase.com** → **Start your project** → sign in with GitHub.
2. **New project**:
   - Name: `stocksaathi`
   - Database password: generate + save it
   - Region: `Asia South (Mumbai)` — lowest latency for Indian users
   - Plan: **Free** is fine for launch (500MB DB, 50k monthly active users, 2GB file storage). Upgrade later.
3. Wait ~90s for the project to provision.
4. Open **SQL Editor → New query** → paste the **entire contents** of `supabase/schema.sql` → **Run**.
   - Creates all tables, RPCs, RLS policies, triggers, and enables Realtime.
5. **Authentication → Providers → Email**:
   - Confirm email: **ON** if you want the 6-digit code flow (recommended).
   - Secure email change: optional.
6. **Authentication → Email Templates → Confirm signup** — replace the body with this so the email contains a visible **6-digit code** instead of only a clickable link:

   ```html
   <h2>Welcome to StockSaathi</h2>
   <p>Your 6-digit verification code:</p>
   <p style="font-size: 28px; font-weight: 700; letter-spacing: 0.25em; font-family: monospace; background: #F1F3F7; padding: 16px 24px; border-radius: 10px; display: inline-block;">{{ .Token }}</p>
   <p>Paste it into the StockSaathi signup screen to activate your account.</p>
   <p style="color: #5C6473; font-size: 13px;">If copy-paste is easier, you can also just click this link: <a href="{{ .ConfirmationURL }}">Confirm signup</a></p>
   <p style="color: #5C6473; font-size: 13px;">Didn't ask for this? Ignore this email — no account will be created.</p>
   ```

   The key variable is `{{ .Token }}` — it's what turns Supabase's default link-only template into a code-bearing email. The app's signup screen shows the 6-digit input as the primary field; the link still works as a fallback if the user prefers to click.

7. **Authentication → URL Configuration**:
   - **Site URL**: `https://stocksaathi.co.in` (or your production domain).
   - **Redirect URLs** (allowlist) — add every URL the app may redirect auth emails to. For production-only:
     ```
     https://stocksaathi.co.in/**
     https://*.vercel.app/**
     ```
     Add `http://127.0.0.1:7350/**` ONLY if you test auth emails against the local dev server (`python scripts/dev_server.py`) — production users don't need it.

   Without a matching allowlist entry, password-reset and confirm-signup links get rejected by Supabase with "redirect URL not allowed."

8. **Authentication → Email Templates → Reset Password** — replace the body so users get a clear "set new password" email:

   ```html
   <h2>Reset your StockSaathi password</h2>
   <p>Click the button below to set a new password. The link expires in 60 minutes.</p>
   <p>
     <a href="{{ .ConfirmationURL }}" style="display:inline-block; padding: 14px 28px; background:#00B386; color:#fff; border-radius:10px; font-weight:700; text-decoration:none;">
       Set new password
     </a>
   </p>
   <p style="color:#6B7280; font-size:13px;">
     If the button doesn't work, copy and paste this URL into your browser:<br>
     <code>{{ .ConfirmationURL }}</code>
   </p>
   <p style="color:#6B7280; font-size:13px;">
     Didn't request this? Ignore this email — your password stays the same.
   </p>
   ```

9. **Project Settings → API** → copy two values:
   - `Project URL` (looks like `https://xxxxxxxx.supabase.co`)
   - `anon public` key (long JWT, safe to expose — RLS is what protects data)

---

## 2. Vercel environment (2 min)

Project → **Settings → Environment Variables** — add/update these:

```
# Supabase (required for cross-device accounts, friends, transfers)
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...
# Service role key — server-only, never exposed to client. Enables the
# /api/live-quote endpoint to upsert into quote_cache so all users share
# one cached view of each stock. Get it from Project Settings → API →
# "service_role" (reveal + copy). NEVER put this in frontend code.
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...

# Optional — DhanHQ API for real-time NSE data (replaces Yahoo primary).
# Free with a Dhan account (dhan.co). Once set, /api/live-quote tries Dhan
# first, Yahoo as fallback. Without these vars the endpoint uses Yahoo only.
# DHAN_ACCESS_TOKEN=eyJ...
# DHAN_CLIENT_ID=1100XXXXXX

# LLM — server-side Groq key, user never sees it (free tier, 500 tok/s)
GROQ_API_KEY=gsk_xxxxxxxx
CHAT_RATE_PER_HOUR=240

# Email — Resend with verified stocksaathi.co.in (see step 3)
RESEND_API_KEY=re_xxxxxxxx
RESEND_FROM=StockSaathi <accounts@stocksaathi.co.in>
SUPPORT_EMAIL=accounts@stocksaathi.co.in

# Rate limits are DISABLED by default (default 100000/hr).
IS_UPSTREAM=1
```

After adding these, **Deployments → ⋯ → Redeploy** the latest build so env vars take effect.

---

## 2.5 CRITICAL: Supabase auth — Site URL, OTP, custom SMTP

You need to set THREE things in the Supabase dashboard for production:

### A. Site URL (fixes "redirects to localhost")

**Authentication → URL Configuration → Site URL:** set to
`https://stocksaathi.co.in`. Add the same to **Redirect URLs**. Without this,
all confirmation/reset emails point at `localhost:3000`.

### B. Use OTP code (no clickable link)

We use 6-digit OTP verification, not magic links. Update the email template:

**Authentication → Email Templates → "Confirm signup"** — replace the body with:

```
Your StockSaathi verification code is: {{ .Token }}

Enter it in the app within 10 minutes.

— StockSaathi
```

Just `{{ .Token }}`, no `{{ .ConfirmationURL }}`. The signup screen shows a
6-digit input; after the user types it, we call `verifyOtp` and they're in.
No localhost issues, no broken links.

### C. Custom SMTP through Resend (so emails come from accounts@stocksaathi.co.in)

**Authentication → Email Templates → SMTP Settings** — toggle **"Enable Custom
SMTP"** ON, fill in exactly:

- **Sender email:** `accounts@stocksaathi.co.in`
- **Sender name:** `StockSaathi`
- **Host:** `smtp.resend.com`
- **Port:** `465`
- **Username:** `resend` (literal)
- **Password:** your `RESEND_API_KEY`

Save.

This eliminates the 2-4/hour Supabase rate limit (Resend = 3000/mo free,
50k/mo on $20 tier) and brands every email as `accounts@stocksaathi.co.in`.

---

## 3. Custom email: `accounts@stocksaathi.co.in` (3 min)

Resend hands this to you in one panel.

1. **resend.com** → **Domains → Add Domain** → enter `stocksaathi.co.in`.
2. Resend shows 3 DNS records — **SPF (TXT)**, **DKIM (TXT)**, **MX** — copy each Name/Value exactly.
3. Your DNS provider (Cloudflare if you set that up earlier, otherwise your `.co.in` registrar) → add the 3 records as shown.
4. Back in Resend → **Verify**. Takes 1–5 min after DNS propagates.
5. Once the domain is **Verified** (green check), `RESEND_FROM=accounts@stocksaathi.co.in` above just works. No other changes needed.

---

## 4. Verify it works (1 min)

After redeploy:

```
https://stocksaathi.co.in/api/health
```

Should return:
```json
{
  "ok": true,
  "runtime": "vercel",
  "email_configured": true,
  "llm_configured": true,
  "db_configured": true
}
```

All three of `email_configured`, `llm_configured`, `db_configured` should be **true**.

Now:
1. Open the live site → **Sign up** with a fresh email.
2. Open it on a **different device** (your phone) → **Log in** with the same email — you should see the same portfolio.
3. Sign up a second account on that phone → go to **Friends** → search the first account's username → **Add**.
4. Send them ₹500 → the first device sees it appear instantly.
5. Both accounts can transact with each other and trade independently.

---

## 5. What's actually hardened for scale

- **Supabase free tier**: 500 concurrent DB connections, 50k MAU, 2M reads/month. For 200 concurrent pitch users, you'll use <5% of any limit.
- **Vercel hobby**: 100GB bandwidth/month, unlimited requests on the free plan. Upgrade to Pro ($20/month) only if you exceed.
- **Groq free tier**: 14,400 chat requests/day. With `CHAT_RATE_PER_HOUR=240` per-IP limit, one abuser can't drain it.
- **Stock prices**: server-side proxied through Yahoo Finance + 45-second cache. All 200 users hitting at once = 1 upstream call every 45s.
- **Atomic trades and transfers**: `apply_trade` and `apply_transfer` RPCs run inside a Postgres transaction with row-level locking. Zero race conditions even under contention.
- **RLS** on every table: a malicious user cannot read or write anyone else's data — enforced by Postgres itself.

---

## 6. Fallback if you don't set up Supabase

The app **still works without Supabase** — it falls back to per-browser localStorage. Useful for first-run or if Supabase is ever down. Set only `GROQ_API_KEY` and you already have a functioning deploy.

---

## 7. Monitor launch

- **Supabase dashboard** → **Reports** → live graphs of requests, errors, slow queries.
- **Vercel dashboard** → **Analytics** → requests per minute, error rate.
- **Resend dashboard** → delivered / bounced / complained emails.
- **Groq console** → requests / tokens used.

If any one service hits limits, the others keep running — the app gracefully degrades section by section.
