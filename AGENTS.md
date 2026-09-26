# StockSaathi — project context

Vanilla-JS SPA + Python serverless (Vercel) + Postgres (Supabase). Virtual-money Indian stock-trading simulator for teens. Live at https://stocksaathi.co.in.

## Stack
- **Frontend:** vanilla JS modules (no framework, no build step), SW-cached, hash router
- **Backend:** Vercel Python serverless functions in `api/*.py`
- **Database:** Supabase Postgres, RLS-enforced, RPCs for cross-user reads
- **Data:** Yahoo Finance free tier (rate-limited for Vercel IPs) with a Supabase
  `quote_cache` TTL layer. **Yahoo is the ONLY source.** `fetch_dhan_ltp` exists
  in `handlers/live-quote.py` but has never served a single quote:
  `DHAN_ACCESS_TOKEN` is unset and all 3,655 `quote_cache` rows across five
  months are `source='yahoo'` (verified 2026-09-14). There is no second price
  source behind Yahoo - treat its rate limit as a hard ceiling, not a
  degraded mode.
- **LLM:** Google **Vertex AI** Gemini, proxied via `api/chat.js` (Edge). Project
  `gen-lang-client-0129344832`. Profiles: `chat`/`fast` -> `gemini-3-flash-preview`,
  `reasoning` -> `gemini-3.1-pro-preview`, `json` -> `gemini-2.5-flash-lite`.
  **Groq is deliberately excluded** from the provider list (`api/chat.js:240`).
  The chains look 4-deep but only `GEMINI_API_KEY` is set, so every profile is
  effectively 2 Gemini models on ONE vendor - `OPENAI_API_KEY` and
  `CEREBRAS_API_KEY` are unset (verified 2026-09-14 via `X-Chat-Attempts`).
  A Vertex outage takes the coach, command palette, crash replay and report
  card down together, with no fallback.

## Workflow rules
- **Always push + let Vercel deploy** after any task. User pre-authorised.
- **Push target:** `origin` remote — **only** `aliarbab2009/StockSaathi.git`. Never add a second pushurl.
- **Style:** terse, blunt, no ceremony. User prefers honesty > padding.
- **No attribution** in anything committed to this repo — no co-author trailers, no "built by X" comments, no vendor-branded filenames or identifiers. This is a hard rule.
- **SW cache bump:** every JS/CSS change → bump `CACHE_NAME` in `sw.js` (format `stocksaathi-vN-YYYYMMDDx`)

## Order execution — SERVER-SIDE. Never make this client-driven again.

Limit orders and AMOs are matched by `/api/match-orders` (`handlers/match-orders.py`)
on a schedule. The user does **not** need the app open.

- **PRIMARY tick:** Supabase `pg_cron` job `order-matcher` (`*/5 3-10 * * 1-5`)
  → `pg_net` POST to `/api/match-orders`, bearer from Vault secret `cron_secret`
  (migration `2026-09-26b`). Responses: `net._http_response`; runs:
  `cron.job_run_details`. Same pattern ticks `portfolio-snapshot`.
- **Backstop tick:** `.github/workflows/order-matcher.yml`. It *says* every 5 min
  but GitHub drops most `*/5` runs: measured 2026-09-21..25 it ran **2x/day**,
  ~08:00 UTC and after 13:00 UTC (market closed → skip), and every workflow
  here fires ~5h late. Median order-to-fill was 2,384 min. Double ticks are
  safe (fill core locks the row; "already filled" is treated as a lost race).
- **Aspirational tick:** Cloudflare front-door Worker cron, `* * * * *` (see
  `edge/front-door/wrangler.toml` + its `scheduled()` export). **NOT DEPLOYED** -
  `wrangler.toml` still carries the literal placeholder
  `id = "REPLACE_WITH_KV_ID_AFTER_wrangler_kv_namespace_create"`, and production
  returns `Server: Vercel` with no `cf-ray` header (verified 2026-09-14). This
  file previously described it as the primary tick, which is how at least one
  later plan came to be designed around a scheduler that does not run.
  Evidence it is GitHub Actions doing the work: of 130 filled orders across 73
  distinct fill times, 56 have non-zero seconds - irregular, HTTP-triggered
  runs, not a per-minute cron.
- **Fill path:** `admin_fill_limit_order` / `admin_pending_orders` (service_role
  only). Both wrap `_fill_limit_order_core`, which takes the owner from the
  order row instead of `auth.uid()` and is revoked from `anon`/`authenticated`.
- The client loop in `js/features/limitOrders.js` is a **latency optimisation
  only**. If it never ran again every order would still execute.

**History (2026-09-13):** execution used to run ONLY inside the user's browser
tab, gated on `marketStatus().open`. For teenagers that window is the school
day, so orders rotted: 75 pending, 42 already past their fill condition, oldest
128 days, cash reserved throughout. Users were told in the coach to "contact
your broker" — there is no broker. 74 orders were backfilled at their frozen
limit price and 24 users got an apology notice.

Guarded by `api-backup/tests/test_order_execution_guards.py` (runs in CI via
backup-deploy.yml). Do not delete those tests to make a change pass.

**Never auto-cancel an order the matcher cannot price.** The old client
cancelled after ~2 min of missing quotes; `getQuoteBatch` has no mutual-fund
coverage, so every MF order was guaranteed to be destroyed. A missing price is
our problem — retry next tick. MF pricing: `mf_master`, falling back to
`js/data/mfFull.json` (the same file the browser uses).

## User notices

`public.user_notices` + `ack_notice()` RPC + `js/components/noticeModal.js`
deliver a one-off personal message to specific users on next login. RLS scopes
reads/updates to `auth.uid()`; only the service role inserts. Used for the
order-backfill apology. Grants are `authenticated: SELECT, UPDATE` only —
do not let Supabase's default grants hand `anon` TRUNCATE, which bypasses RLS.

## Key endpoints
- `/api/live-quote?symbols=A,B,C` — **primary quote path**, cache-first Supabase + Dhan→Yahoo fallback
- `/api/history?symbol=X&range=1mo&interval=1d` — OHLC for charts
- `/api/fundamentals?symbol=X` — 3-tier fallback (v7 → v10 → v8/chart)
- `/api/chat` — LLM proxy
- `/api/send-consent` — parent email

## Do not
- Commit secrets (`.env` is gitignored)
- Force-push to main
- Rotate `GROQ_API_KEY` or `RESEND_API_KEY` (user declined despite Vercel's "Need to Rotate" warnings — their call)
- Hand-curate `universe.js` entries at scale — user is planning NSE-wide import; the architecture needs to move to a Supabase `instrument_master` table

## Failover infrastructure

**NOT DEPLOYED — this section describes intent, not production.** Verified
2026-09-14: `stocksaathi.co.in` resolves straight to Vercel (`Server: Vercel`,
`X-Vercel-Id: bom1::...`, no `cf-ray`), the Worker's KV id is still a
placeholder, and the deploy secrets (`CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `FLY_API_TOKEN`) are absent. Deploying it is a
production cutover of the entire serving path, not a config tweak.

The intended design: primary serving path Cloudflare Worker (`edge/front-door/`) → Vercel. On Vercel 5xx / timeout / network error, the Worker falls back to:
- **Cloudflare Pages** (`stocksaathi.pages.dev`) for static assets
- **Fly.io** (`stocksaathi-backup.fly.dev`) for `/api/*.py`
- **Inline in the Worker** for `/api/chat` + `/api/ai` (Vercel's edge JS is imported directly)

### Adding a new `/api/<name>.py` handler

1. Create `api/<name>.py` as usual (BaseHTTPRequestHandler subclass, `class handler`).
2. Register it in `api-backup/main.py`'s `_ROUTES` dict: `"/api/<name>": "<name>",`.
3. The parity test (`api-backup/tests/test_route_parity.py`) fails CI if you skip step 2.

### Adding a new `/api/<name>.js` Edge function

1. Create `api/<name>.js` with `export const config = { runtime: "edge" }` and a default-exported `handler(req)`.
2. Import it in `edge/front-door/src/index.js`, add its path to `INLINE_EDGE_PATHS`, and route it in `serveBackup`.
3. Env vars are read via `globalThis.process.env.X` — the Worker installs that shim per-request.

### Testing failover

- **Laptop test:** `curl -H "X-Force-Backup: 1" https://stocksaathi.co.in/api/health` — expect `"runtime":"fly"`. Requires your IP in the Worker's `TEST_IP_ALLOWLIST` secret.
- **CI health-gate:** `.github/workflows/backup-deploy.yml` fails the deploy if either Vercel `/api/health` or Fly `/api/health` is unhealthy.
- **Never simulate by killing Vercel.** Use the header switch.

### Cache coherency

`sw.js` caches static by `CACHE_NAME`. Since Vercel and Pages serve byte-identical HTML (same repo, same build), a mid-session origin swap is safe. Still bump `CACHE_NAME` on any frontend change.
