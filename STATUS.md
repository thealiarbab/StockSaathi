# StockSaathi — engineering status

Written 2026-09-13 as a handoff. Everything below was **verified against the
live database, live site, live Vercel API and live GitHub UI** — not inferred
from source. Read this before crawling the repo; it exists to save you that.

> **Companion file: [`BUGFIXES.md`](BUGFIXES.md).** This file describes the
> *current state*. That one records *what was broken, why it stayed hidden, and
> how it was proven fixed* — newest session first. Read it when you are about
> to touch a subsystem, or when something here reads as settled and you want to
> know whether it was checked or assumed. Append to it; don't rewrite history
> in it.

---

## 0. Bugfix records — read the one that matches your area

Long-form root-cause write-ups live in `docs/`. Each covers a cluster of
defects that is **only legible together**, and each records things git alone
does not carry: migrations applied through the Supabase API before they were
written to `supabase/migrations/`, measurements taken against production, and
failure modes that are still open.

| File | Covers | Open items |
|---|---|---|
| [`docs/COACH_FIXES.md`](docs/COACH_FIXES.md) | **Saathi, the AI coach** — 46 defects, v270→v279. Fabricated portfolios, the prompt/tool/routing layers, both chat surfaces, the model proxy, the local-cache privacy leak. | `ADMIN_PATH` still needs rotating; `json`-lane `max_tokens` blowout |
| [`docs/SECURITY_FIXES_2026-09-13.md`](docs/SECURITY_FIXES_2026-09-13.md) | **Trade-path / ledger security** — server-side fill pricing, money-table locks, the 10% price band. | see file |
| [`docs/PORTFOLIO_CHART_FIXES.md`](docs/PORTFOLIO_CHART_FIXES.md) | **Portfolio "Value over time"** — 9 defects across the client store, chart renderer, database, scheduler and DNS. | see file |

If you are about to debug the coach, read `COACH_FIXES.md` **first**. Most of
its 46 entries were found by reading logged `coach_messages` rows, not by
testing — and its closing section explains why the regex probe suites were
green while the replies underneath were wrong.

---

## 1. Context

| Thing | Value |
|---|---|
| Repo | `G:\stocksaathi\app` — its own git repo, `main`, deploys to Vercel on push |
| Remote | `github.com/thealiarbab/StockSaathi` (public) |
| Outer dir | `G:\stocksaathi` is a *different* repo with no remote. Deploys nothing. Work in `app/`. |
| Supabase | project `hwlmwraowcylxzdpumca`, ap-south-1, 118 users / 86 onboarded |
| Vercel | project `prj_EnsEmBUp905QAg88YlS2n0SBabCe`, team `team_uDFTGZMVEwrjtxi21s7Pb0Nl`, slug `thealiarbab`, project name `stock-saathi-jtmn` |
| **Vercel plan** | **Hobby.** 12 serverless functions per deployment, 2 cron jobs at daily granularity. Both limits have already bitten. |
| Audience | Paper-trading simulator for Indian teens 13–18. Several past bugs exposed **minors'** names, schools and balances. Weight accordingly. |

### Guardrails

- **Never touch the `kotlin` branch.** Not a checkout, not a commit, not a merge. Stated repeatedly.
- **Never put AI attribution in commits.** No `Co-Authored-By: Claude`, no `Claude-Session:`, no `🤖 Generated with`. Ali saw GitHub render "thealiarbab and claude committed" and objected strongly. Six commits had to be rewritten and force-pushed to strip it.
- Verify before asserting. Several claims in this session looked obvious and were wrong (see §5).
- Ali is impatient with stalling. Do the work; don't stop to ask permission for things already authorised.

---

## 2. Gotchas that cost real time to discover

**Read this section. Each item below was a multi-step investigation.**

### 2.1 Vercel reads `uv.lock`, NOT `requirements.txt`
The repo has `pyproject.toml` + `uv.lock`, so Vercel's build runs the **uv**
path (`Installing required dependencies from uv.lock` appears in the build
log) and never reads `requirements.txt`. Declaring a dependency only in
`requirements.txt` produces a **clean build** and then
`FUNCTION_INVOCATION_FAILED` on every request, because the import fails at
cold start. Put Python deps in `pyproject.toml` and run `uv lock`.

### 2.2 `api/` holds exactly 3 functions now — do not add more
Vercel creates one serverless function per file under `api/`. There were 21
against a limit of 12, so **every deploy from 2026-05-05 to 2026-09-13 failed**
at `patchBuild` with `exceeded_serverless_functions_per_deployment`. The build
*succeeds* first and the site keeps serving the last good deployment, so
nothing looks broken. Four months of commits silently never shipped.

Current layout:
```
api/index.py   <- single ASGI entrypoint, exposes `app`
api/ai.js      <- node function
api/chat.js    <- node function
handlers/*.py  <- the 16 real handlers. Vercel does NOT functionize these.
handlers/_shim.py <- dispatches to them
```
**Adding a file to `api/` adds a function.** Add handlers to `handlers/` and
register them in `handlers/_shim.py`'s `ROUTES` dict.

### 2.3 Route resolution goes through `?__path=`
`vercel.json` rewrites `/api/:path` → `/api/index?__path=:path`. Under a
rewrite the ASGI path is **always** `/api/index`, which is itself a valid
route — so resolving from the path first makes *every* endpoint return the
index banner. `__path` is authoritative; the ASGI path is only consulted when
`__path` is absent. There is a comment in `_shim.py` saying so. Don't "fix" it.

### 2.4 Postgres `REVOKE ... FROM anon` is usually a no-op
Functions get `EXECUTE` granted to **`PUBLIC`** on creation, and `anon`
inherits it rather than holding a direct grant. `revoke execute ... from anon`
therefore succeeds, reports success, and **changes nothing**. Two migrations
returned `{"success": true}` and left the exposure wide open. The correct form
is `revoke ... from public, anon` then `grant ... to authenticated`.
**Always verify grants with `has_function_privilege` after revoking.**

`CREATE OR REPLACE FUNCTION` *preserves* existing grants — verified — so it
does not silently undo the revokes. Verify anyway.

### 2.5 NSE blocks **Vercel**, not datacenters generally
Measured on 2026-09-12:
- From Ali's residential connection: `nsearchives.nseindia.com/content/equities/EQUITY_L.csv` → **200, 2,568 rows**
- From Vercel: `/api/admin-sync-instruments` → `sanity_fail: only 0 equities (expected >=1800)`

Measured 2026-09-13, run `34761640980` — **GitHub-hosted `ubuntu-latest`
reaches NSE fine**: EQUITY_L.csv 200 with **2,568 rows**, the same count the
residential connection gets. Plus NSE SME 571, BSE main 3,548, all 20
niftyindices CSVs, 350 ETFs.

The original heading here read "NSE blocks datacenter IPs" and was an
extrapolation from the single Vercel data point. **Do not generalise a block
from one host to another — measure the host.**

`dhan_instruments` still cannot be populated *from Vercel*, so the committed
JSON remains the serving path; but CI on GitHub can rebuild it, which is what
§4.1 now does.

### 2.6 `quote_cache` is no longer just a cache
As of migration `2026-09-12b`, `apply_trade` and `fill_limit_order` **refuse to
price a symbol that has no `quote_cache` row**. Purging stale rows — harmless
before — now makes those symbols untradeable. 2,089 rows are >7d old. Do not
purge without accounting for this.

### 2.7 AMFI changed their feed schema
`NAVAll.txt` went from 6 columns to 8: `Plan` and `Option` became their own
columns, where they used to be baked into the scheme name.
```
old: code;isin1;isin2;name;nav;date
new: code;isin1;isin2;name;plan;option;nav;date
```
The old positional destructure still "worked" on 8 columns — it read `navStr`
from the Plan column, `Number("Direct Plan")` was `NaN`, and the finite-check
dropped **all 14,361 rows**. The `cols.length < 6` guard passed because 8 ≥ 6.
Fixed in `scripts/build-mf-universe.mjs`; it now handles both layouts.

**The identical bug also lived in `handlers/admin-sync-mf.py` and was missed
until 2026-09-13** — `cols[:6]`, same `len(cols) < 6` guard, same total
row loss, surfacing as `amfi_parse_underfilled rows=0` behind an HTTP 200.
Both are fixed now. When a parser exists in two languages here, **fix both.**

### 2.8 `pg_trgm` must stay in `public`
The Supabase advisor flags `extension_in_public`. **Do not relocate it** — it
backs a live GIN index, `idx_dhan_name_trgm` on `dhan_instruments`.

### 2.9 RLS does not protect against TRUNCATE
Supabase grants `anon` and `authenticated` the full `arwdDxtm` on every new
table in the `public` schema. The instinct "RLS is enabled and there's no write
policy, so writes are blocked" is **wrong for TRUNCATE** — Postgres RLS governs
SELECT/INSERT/UPDATE/DELETE and does not apply to TRUNCATE at all. The `D` in
that ACL is TRUNCATE.

`admin_audit_log` sat this way with 25 `user_delete` entries in it. PostgREST
does not expose TRUNCATE, so it was not reachable over the REST API, but the
grant was wrong and the table is service-role-only by design.

For any service-role-only table: `revoke all ... from anon, authenticated`.
For a public-read table: keep `SELECT`, revoke
`insert, update, delete, truncate`. Then **verify with `has_table_privilege`**
— see §2.4 for why "it returned success" is not evidence.

---

## 3. What is fixed and verified

| # | Issue | Verification |
|---|---|---|
| 1 | `search_public_profiles` + `leaderboard` were anon-executable and returned minors' **school** (leaderboard also portfolio value, with a `p_school` filter = per-school roster, and `SET row_security TO 'off'`) | Called both with the real anon key from `/api/config` while signed out → **401 permission denied**. `profile_by_username` still **200** (needed pre-session at signup). |
| 2 | `apply_trade` / `fill_limit_order` took the execution price as a **client parameter** and never checked it. Buy RELIANCE at ₹0.01, sell at market. | Both bodies now read `quote_cache`; verified `quote_cache` present and raw-param use absent in both. |
| 3 | Every `admin-sync-*` cron 401'd — `CRON_SECRET` was unset | Set in Vercel (Production) **and** as a GitHub Actions repo secret. Endpoint now 401s without it, authenticates with it. |
| 4 | 21 serverless functions vs limit 12; nothing deployed since May 5 | 5 consecutive `READY` production deploys. `lambdaRuntimeStats: {"python":1,"nodejs":1}` |
| 5 | Quote handlers appended `.NS` to every symbol, so 1,145 BSE + 542 SME rows were unpriceable | Live: `BMW`→`BMW.BO` ₹54.38, `7NR`→`7NR.BO` ₹7.15, `CUPIDALBV`→`CUPIDALBV.BO` ₹26.93, `RELIANCE`→`.NS` unchanged |
| 6 | `js/state.js` wrote trades to local state when the server rejected them — user saw a fill, DB had no row, next sync erased it | Supabase branch now always returns or throws; routes through `handleSessionLost()`. Local path reachable only when `sb()` is null. |
| 7 | Universe frozen at 2026-05-03 | Rebuilt locally: **4,619 rows** (was 4,367), sha8 `aa27fa18`, live |
| 8 | MF parser dropping 100% of rows | Rebuilt: **14,120 schemes**, sha8 `be3a5839`, NAVs dated 2026-09-11, 0 bad NAVs, 0 missing dates |
| 9 | `.env.vercel` (contains `VERCEL_OIDC_TOKEN`) untracked *and* not gitignored | `.gitignore` now `.env*` + `!.env.example`; verified with `git check-ignore` |
| 10 | `coach_chats` orphaned since v142; one user's chats existed **only** there | 28 messages / 4 sessions migrated into `coach_messages`, then table dropped. Ali 86→106 rows. |
| 11 | Pasted `ADMIN_PATH` value stored in plaintext in chat | Redacted during migration; **0 occurrences** across `coach_messages`, `ai_response_cache`, `admin_audit_log`. All 430 chat rows scanned for other secrets — none. |
| 12 | Dead `leaderboard()`, `leaderboard_view`, `public_profiles` | Dropped. Public tables 16 → 15. |

Verified 2026-09-13 (this session):

| # | Issue | Verification |
|---|---|---|
| 13 | GitHub runners assumed unable to reach NSE; universe had no auto-refresh | Run `34761640980` **succeeded** — EQUITY_L.csv 200/2,568 rows. `cron: "30 2 * * 0"` restored and live |
| 14 | Fundamentals broken for BSE/SME | Live: `7NR` was `ok:false` → now `7NR.BO` ₹7.15 BSE; `BMW` → `BMW.BO`; `RELIANCE` unchanged |
| 15 | `backup-deploy` 366 runs / 0 successes, burying the repo's only CI | Deploys gated on credential presence; first green run `34762615727`, green since |
| 16 | `data-sync` aborted at step 1, so steps 2–3 never ran | Job completes; `mf_master` 0 → **14,120**, `fundamentals_cache` 0 → 197, `tickertape_sids` 0 → 162 |
| 17 | `handlers/admin-sync-mf.py` still had the §2.7 AMFI bug | Live feed: 14,120 rows, 0 bad NAVs, 0 missing dates; production upserted 14,120 |
| 18 | `admin_audit_log` truncatable by `anon` (RLS ≠ TRUNCATE) | `has_table_privilege` false for all verbs, both roles; `service_role` unchanged |
| 19 | Screener served a 140-day-old static snapshot | `/api/screener` now answers `source: "supabase"` |

Applied migrations (all recorded in `supabase/migrations/`):
`2026-09-12a`, `12b`, `12c`, `12d`, `2026-09-13a`, `13b`, `13c`,
`13g` (lock `admin_audit_log`), `13h` (apply the fundamentals cache).
`13d`–`13f` belong to work that ran in parallel.
Note `12d` exists because `12a`/`12c` were the no-op revokes from §2.4.

---

## 4. OPEN — what still needs doing

### 4.1 Universe automation — RESOLVED 2026-09-13
`universe-refresh` was dispatched manually (run `34761640980`). It **succeeded**
in 38s. GitHub-hosted runners reach NSE; see §2.5 for the numbers.

The workflow's comment block has been rewritten — it previously asserted
`DOES NOT WORK ON GITHUB-HOSTED RUNNERS` in capitals, which was false.

**The schedule is `cron: "30 2 * * *"` — DAILY, not the weekly the old comment
specified.** Weekly was restored first, on the inherited reasoning that "the
NSE universe changes slowly". That reasoning covers the equity half only.
This workflow also rebuilds `js/data/mfFull.json`, which ships a `nav` and
`nav_date` for **all 14,120 schemes**; AMFI publishes NAVs every business day;
`js/data/universeLoader.js` loads that file straight into the browser; and
`js/data/marketData.js` `synthMFQuote` prices a fund as `inst.nav * 100` from
it. Weekly therefore meant **every mutual fund in the app traded at a NAV up
to 7 days old** — a wrong execution price for 13–18 year olds, not a stale
label. The cost argument did not hold either: the SME churn below means a run
commits and deploys every time regardless of cadence.

Note `data-sync.yml` already refreshed the `mf_master` **table** daily, but the
front end reads the committed JSON, not the table — that never covered this.

**One correction to the prediction made here.** The handoff said a successful
run "produces identical output and commits nothing". It committed: `d07bc1f`.
Row counts were identical (4,619 equity / 14,120 MF) and *all 4,619 rows are
identical as a set* — zero added, zero removed — but NSE serves the Emerge SME
CSV in a varying row order, so ~129 rows (all series SM/ST) change array
position between runs and the sha8 moves (`aa27fa18` → `464c6681`) while
`rawBytes` stays byte-identical at 1,036,344.

So **every run will commit and trigger a production deploy even when nothing
changed.** Cosmetic — array position only feeds search-result ordering
among micro-caps — but if it becomes annoying, sort deterministically before
serialising in `scripts/build-universe.mjs`. Documented in the workflow.

Manual rebuild, any time, from Ali's machine (still works):
```bash
cd /g/stocksaathi/app
node scripts/build-universe.mjs
node scripts/build-mf-universe.mjs
git add js/data/ && git commit -m "chore(data): refresh universe" && git push
```

No Windows Task Scheduler script was needed — that was the fallback for the
"NSE blocks GitHub" branch, which did not happen.

### 4.2 Rotate `ADMIN_TOKEN` and `ADMIN_PATH` — BLOCKED ON USER
`admin_exec_sql(text)` runs **arbitrary SQL as the function owner** and is
exposed via `/api/ai` behind a single static `ADMIN_TOKEN` stored in
`localStorage`. No rotation, no rate limit, no IP allowlist. `admin_audit_log`
shows 25 `user_delete` actions through it.

`ADMIN_PATH` was pasted into a coach chat in April (by Ali himself, testing —
not a third party). Redacted from the DB now, but it **reached an LLM provider**
when the message was answered. Storage cleanup does not undo that.

A replacement token was generated but **not applied** — Vercel secret edits are
blocked by the auto-mode classifier as `[Secret-Store Writes]` (adding a *new*
secret is allowed; overwriting an existing one is not). Ali must edit them in
the Vercel dashboard, or approve the action.

Generated but unused: `02ebbbfcda9f97705c350977818c5db22c1c494ec71494ff29e4c7731a015b16`
Keep `ADMIN_TOKEN` **different** from `CRON_SECRET` — the sync handlers accept
either, and there is no reason the cron path should carry admin-panel powers.

### 4.3 Failover stack — no longer red; still needs Ali's credentials
`backup-deploy.yml` had **366 runs, 0 successes**. Verified 2026-09-13: the
parity fix holds — `parity-check` now passes in 18s. What remained was only the
missing credentials, exactly as predicted:
- Cloudflare: `it's necessary to set a CLOUDFLARE_API_TOKEN environment variable`
- Fly.io: `FLY_API_TOKEN:` empty → `no access token available`

**Do not delete this workflow.** The handoff undersold what that would cost.
`parity-check` runs `pytest api-backup/tests/ -v`, which is **two** files, not
one: `test_route_parity.py` *and* `test_order_execution_guards.py` — the
regression guards for the bug that left orders rotting up to 128 days with
users' cash reserved. The job also runs `scripts/check-js-syntax.mjs`, added
after a syntax error blanked the homepage in v273. **This job is the only CI
this repo has, and it guards the main app, not the backup.**

Changed instead of deleted: a `preflight` job now reports credential presence
and gates `deploy-pages` / `deploy-fly`; `deploy-worker` and `verify` skip by
cascade. With no secrets the run is **green with deploys skipped**; add the
secrets and they deploy with no further edit. First green run ever:
`34762615727`. (The `secrets` context is unavailable in a job-level `if:`,
hence the preflight indirection.)

**Two things the handoff did not know, both verified:**
1. Adding the Cloudflare secrets is **not sufficient** for `deploy-worker`.
   `edge/front-door/wrangler.toml` still carries the literal placeholder
   `id = "REPLACE_WITH_KV_ID_AFTER_wrangler_kv_namespace_create"` for
   `HEALTH_KV`. Wrangler will reject the deploy.
2. That job binds routes for `stocksaathi.co.in/*`. Production currently
   answers `Server: Vercel` with **no `cf-ray`** — no Worker has ever fronted
   it. **Its first successful run is a production cutover, not a backup step.**

Related: `test_at_least_two_independent_schedulers` asserts two schedulers
exist *in the repo*. In production there is **one**. The Worker cron has never
deployed, so `order-matcher.yml` is the only live scheduler — and it has 3
runs, all `workflow_dispatch`, **zero scheduled**. Its cron is
`*/5 3-10 * * 1-5` and it was added today (Sunday), so its first real
scheduled tick is Monday 03:30 UTC, untested. Same repo-says-X / live-says-Y
pattern as §5.

Still Ali's call whether the failover is wanted at all. If yes, he needs
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `FLY_API_TOKEN`, plus a real
KV namespace id.

### 4.4 `data-sync` — was aborting early; now completes
The instruments step is still blocked (NSE blocks Vercel; re-confirmed
2026-09-13, HTTP 500 `sanity_fail: only 0 equities`). **But the handoff missed
why that mattered:** the step ended in `[ "$code" = "200" ] || exit 1` with no
`continue-on-error`, so it **killed the whole job** and the two steps after it
never ran at all. The fundamentals and MF syncs were not failing — they were
never reached.

Now warns and continues, matching what the fundamentals step already did.
Result, from 0 rows each:

| Table | Before | After |
|---|---|---|
| `mf_master` | 0 | **14,120** (all with NAV + date, newest 2026-09-14) |
| `fundamentals_cache` | 0 (table absent) | **197** and climbing |
| `tickertape_sids` | 0 (table absent) | **162** |

Two real bugs were hiding behind HTTP 200 responses carrying `ok: false`,
which the workflow's status-code-only check could not see:

1. **`handlers/admin-sync-mf.py` had the §2.7 AMFI bug** — `cols[:6]` on an
   8-column line, `float("Direct Plan")` raising, every row dropped,
   `amfi_parse_underfilled rows=0`. §2.7's fix was applied to
   `scripts/build-mf-universe.mjs` **only**; the handler still had it. Fixed
   and verified against the live feed: 14,120 rows, 0 bad NAVs, 0 missing
   dates.
2. **`admin-sync-fundamentals` iterated `dhan_instruments`**, which is empty
   and unfillable from Vercel, so it answered `{"ok": true, "processed": 0}`
   for every page forever. Now falls back to the committed
   `js/data/universeFull.json` (4,269 equities), the way `screener.py` already
   reads its committed JSON.

Note `idx` in `universeFull.json` is an index-tier **code**, not a rank:
7 = Nifty 50 (RELIANCE/TCS/HDFCBANK/INFY all carry 7), 6 = next 50,
12 = Midcap 150, 20 = Smallcap 250, 0 = unindexed. Sorting it descending
refreshes smallcaps *before* Nifty 50.

Each page is time-bounded at ~50s by the function budget, so a run processes
~200 symbols rather than the nominal 2,500. It accumulates across daily runs.
Fetching instruments **on the GitHub runner** (which can reach NSE, §2.5) and
POSTing them would fix the root cause properly.

### 4.5 Smaller open items — mostly closed 2026-09-13

**Done:**
- ~~`api/fundamentals.py:474` appends `.NS` only~~ — the path was stale (`api/`
  holds 3 files per §2.2; it is `handlers/fundamentals.py:474`). It was also
  **not** harmless. One ticker was built as `symbol + ".NS"` and fed to all
  three Yahoo tiers, so for BSE/SME scrips every Yahoo request queried a ticker
  that does not exist. Measured before the fix: **7NR returned `ok: false`,
  total failure** (Tickertape does not carry SME) while `/api/quote?symbol=7NR`
  served it fine as `7NR.BO`; **BMW returned `source_tiers: ["tickertape"]`
  with `exchange: null`**, the Yahoo failure masked by Tickertape. Now falls
  back to `.BO` like `handlers/quote.py:37`, gated on no `yahoo_*` tier having
  reported so NSE symbols never pay for the retry. Live: 7NR → `7NR.BO`, BMW →
  `BMW.BO`, RELIANCE unchanged.
- ~~`handlers/history.py:191` echoes an assumed ticker~~ — genuinely cosmetic
  (nothing in `js/` reads the field), but `fetch_yahoo` already did the
  `.NS`/`.BO` fallback and knew the right answer, then threw it away. Now
  returns the ticker it actually succeeded on.
- ~~`fundamentals_cache` does not exist~~ — applied
  (`2026-09-13h`). Creating it was **not** enough: the first three live
  requests still left it empty, because `write_cache` posts a
  `debt_to_equity` field the April definition never had and PostgREST rejects
  the whole row with `PGRST204` — silently, by design. Column added. The
  screener now answers `source: "supabase"` instead of the static fallback.
- ~~`admin_audit_log` RLS with zero policies~~ — it was worse than a lint. The
  table carried **direct** grants of `arwdDxtm` to `anon` **and**
  `authenticated`. RLS-with-no-policies blocks SELECT/INSERT/UPDATE/DELETE —
  but **Postgres RLS does not govern TRUNCATE**, and the `D` in that ACL is
  TRUNCATE. Revoked (`2026-09-13g`); `has_table_privilege` now false across the
  board for both roles, true for `service_role`. `order_backfill_audit` was
  already correct and is the shape to copy.
  **Watch for this generally:** Supabase grants `arwdDxtm` to `anon`/
  `authenticated` on every new public-schema table, so "RLS on, no write
  policy" always leaves TRUNCATE open. `fundamentals_cache` and
  `tickertape_sids` arrived with the same hole and were locked down at
  creation.
- ~~`js/data/fundamentals_full.json` is a May snapshot~~ — it is a
  **2026-04-26** snapshot, 140 days old, and it no longer backs the screener.
  Still committed as the fallback for when the cache is cold.

**Still open:**
- **Supabase Auth leaked-password protection is off.** Needs Ali in the
  Supabase dashboard — the MCP surface has no auth-config write. Same class as
  §4.2.
- `handlers/admin-sync-fundamentals` covers ~200 symbols per run against a
  ~50s per-page function budget; full coverage of 4,269 equities accumulates
  over days. See §4.4 for the proper fix.

## 5. Claims made this session that turned out wrong

Recorded so they are not repeated.

1. **"Missing GitHub secrets are why `backup-deploy` fails"** — no, the parity test was failing first, before any secret was needed.
2. **"Every run failed"** (said after seeing 4 red icons) — true, but asserted before checking. `is:success` → 0 results confirmed it afterwards.
3. **"`ADMIN_TOKEN` is unset, so the admin surface is closed"** — it was set. The admin surface is armed.
4. **"A user pasted the admin path"** — it was Ali's own account, testing.
5. **"The token is almost certainly in `coach_messages` too"** — it was in `coach_chats` only.
6. **"`coach_chats` is 2 rows of vestigial junk"** — it held one user's only copy of a real conversation.
7. **"GitHub runners can't reach NSE"** — **tested 2026-09-13 and false.**
   Run `34761640980` fetched EQUITY_L.csv with 2,568 rows on `ubuntu-latest`.
   The claim was extrapolated from Vercel. See §2.5, §4.1.

Added 2026-09-13, same pattern, found while working §4.1/§4.3/§4.5:

8. **"A successful universe-refresh run commits nothing"** — it committed
   `d07bc1f`. Identical row *set*, different row *order* (NSE varies the SME
   CSV ordering). §4.1.
9. **"Deleting `backup-deploy.yml` costs only the route-parity guard"** — it
   also carries the order-execution regression guards and the JS syntax check,
   and is the repo's only CI. §4.3.
10. **"The instruments step fails but the other data-sync steps still run"** —
    it `exit 1`s and kills the job; the other two never ran. §4.4.
11. **"§2.7's AMFI fix is done"** — done in the JS build script, **not** in
    `handlers/admin-sync-mf.py`, which still dropped all 14,120 rows. §4.4.
12. **"`api/fundamentals.py:474` is untested, leave it alone"** — tested: SME
    fundamentals were failing completely in production. §4.5.
13. **"Weekly is the right cadence for universe-refresh"** — mine, and wrong.
    I restored the schedule the old comment specified without checking whether
    its reasoning still applied. `mfFull.json` carries a NAV per scheme and is
    what `synthMFQuote` prices MFs from, so weekly priced every fund up to 7
    days stale. Now daily. **Restoring a setting is not the same as validating
    it** — the comment justifying it deserved the same scrutiny as the comment
    claiming NSE was blocked.

Pattern: the DB and the live services disagree with the source comments
constantly. `schema.sql:810` claims the leaderboard was dropped in April; it
was still serving minors' school names to anonymous callers in September.
**Check the live system, not the comment.**

Second pattern, new: **HTTP 200 is not success.** `admin-sync-mf` and
`admin-sync-fundamentals` both answer 200 while carrying `ok: false` or
`processed: 0`, and `data-sync.yml` only checked the status code. Read the
body. Likewise `{"success": true}` from a Postgres `REVOKE` (§2.4) and a green
workflow step whose script silently no-opped — **verify the effect, not the
exit code.**

---

## 6. Verification commands

```bash
# API health + the .BO fix
curl -s https://stocksaathi.co.in/api/health
curl -s "https://stocksaathi.co.in/api/quote?symbol=BMW"       # expect BMW.BO
curl -s "https://stocksaathi.co.in/api/quote?symbol=RELIANCE"  # expect RELIANCE.NS
curl -s -o /dev/null -w "%{http_code}\n" https://stocksaathi.co.in/api/not-a-real-route  # 404

# Anon exposure must stay closed
KEY=$(curl -s https://stocksaathi.co.in/api/config | python -c "import sys,json;print(json.load(sys.stdin)['supabaseAnonKey'])")
URL=$(curl -s https://stocksaathi.co.in/api/config | python -c "import sys,json;print(json.load(sys.stdin)['supabaseUrl'])")
curl -s -X POST "$URL/rest/v1/rpc/search_public_profiles" -H "apikey: $KEY" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"p_query":"a"}'            # expect 401 permission denied

# Cron auth
curl -s -o /dev/null -w "%{http_code}\n" https://stocksaathi.co.in/api/admin-sync-instruments  # 401
# with -H "Authorization: Bearer $CRON_SECRET" -> authenticates, then fails on the NSE block

# Function count (must stay <= 12)
ls api/ | grep -v __pycache__ | wc -l

# Universe freshness
curl -s https://stocksaathi.co.in/js/data/universeFull.meta.json | head -5
```

SQL for grant checks after any function change:
```sql
select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') anon_can
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in
  ('apply_trade','apply_transfer','search_public_profiles','profile_by_username');
-- only profile_by_username should be true
```
