# StockSaathi — project context

Vanilla-JS SPA + Python serverless (Vercel) + Postgres (Supabase). Virtual-money Indian stock-trading simulator for teens. Live at https://stocksaathi.co.in.

## Stack
- **Frontend:** vanilla JS modules (no framework, no build step), SW-cached, hash router
- **Backend:** Vercel Python serverless functions in `api/*.py`
- **Database:** Supabase Postgres, RLS-enforced, RPCs for cross-user reads
- **Data:** Yahoo Finance free tier (rate-limited for Vercel IPs) with Supabase `quote_cache` TTL layer on top
- **LLM:** Groq (Llama 3.3 70B), proxied via `api/chat.py` with pinned model + capped tokens

## Workflow rules
- **Always push + let Vercel deploy** after any task. User pre-authorised.
- **Push target:** `origin` remote — **only** `aliarbab2009/StockSaathi.git`. Never add a second pushurl.
- **Style:** terse, blunt, no ceremony. User prefers honesty > padding.
- **No attribution** in anything committed to this repo — no co-author trailers, no "built by X" comments, no vendor-branded filenames or identifiers. This is a hard rule.
- **SW cache bump:** every JS/CSS change → bump `CACHE_NAME` in `sw.js` (format `stocksaathi-vN-YYYYMMDDx`)

## Order execution — SERVER-SIDE. Never make this client-driven again.

Limit orders and AMOs are matched by `/api/match-orders` (`handlers/match-orders.py`)
on a schedule. The user does **not** need the app open.

- **Primary tick:** Cloudflare front-door Worker cron, `* * * * *` (see
  `edge/front-door/wrangler.toml` + its `scheduled()` export). Needs the
  `CRON_SECRET` secret bound on the Worker.
- **Backup tick:** `.github/workflows/order-matcher.yml`, every 5 min during
  market hours. Two vendors, because one scheduler failing silently is exactly
  what caused the original outage.
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

The site has a full hot mirror. Primary serving path: Cloudflare Worker (`edge/front-door/`) → Vercel. On Vercel 5xx / timeout / network error, the Worker falls back to:
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
