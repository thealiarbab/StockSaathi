# StockSaathi — engineering status

Written 2026-09-13 as a handoff. Everything below was **verified against the
live database, live site, live Vercel API and live GitHub UI** — not inferred
from source. Read this before crawling the repo; it exists to save you that.

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

### 2.5 NSE blocks datacenter IPs
Measured both directions on 2026-09-12:
- From Ali's residential connection: `nsearchives.nseindia.com/content/equities/EQUITY_L.csv` → **200, 2,568 rows**
- From Vercel: `/api/admin-sync-instruments` → `sanity_fail: only 0 equities (expected >=1800)`

So **`dhan_instruments` can never be populated from Vercel**, and the
DB-backed universe design is not viable as built. The committed-JSON path is
not a stopgap — it is the only thing that works. See §4.1 for the open
question about GitHub-hosted runners.

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

### 2.8 `pg_trgm` must stay in `public`
The Supabase advisor flags `extension_in_public`. **Do not relocate it** — it
backs a live GIN index, `idx_dhan_name_trgm` on `dhan_instruments`.

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

Applied migrations (all recorded in `supabase/migrations/`):
`2026-09-12a`, `12b`, `12c`, `12d`, `2026-09-13a`, `13b`, `13c`.
Note `12d` exists because `12a`/`12c` were the no-op revokes from §2.4.

---

## 4. OPEN — what still needs doing

### 4.1 Universe automation — UNRESOLVED, this is the live question
The universe and MF catalogs are **fresh as of 2026-09-13**, but nothing will
refresh them automatically.

`.github/workflows/universe-refresh.yml` exists, is `workflow_dispatch`-only
(schedule deliberately removed), and has a sanity gate that refuses to commit
if the row count drops below 2,000 absolute or >20% relative — so it **fails
safe**, never wiping the universe with partial data.

**The untested assumption:** I claimed GitHub-hosted runners can't reach NSE,
reasoning from Vercel being blocked (§2.5). **I never actually tested a GitHub
runner.** That test was in flight when this handoff was written and did not
run.

**Do this first — it decides everything else:**
1. Trigger `universe-refresh` manually (Actions → universe-refresh → Run workflow).
2. It is a safe test: the universe was rebuilt hours ago, so a *successful* run
   produces identical output and commits nothing; a *blocked* run trips the
   sanity gate and commits nothing.
3. If it **succeeds** → GitHub runners can reach NSE. Restore the weekly
   schedule in the workflow (`cron: "30 2 * * 0"`) and the problem is solved.
4. If it **fails** with `only 0 equities` or a sanity-gate error → confirmed
   blocked. Then pick one:
   - **Self-hosted runner** on Ali's machine + `runs-on: self-hosted`. Workflow
     works unchanged. He already runs Windows scheduled tasks (zoombot), so
     this fits his setup.
   - **Local scheduled task**: `node scripts/build-universe.mjs && node
     scripts/build-mf-universe.mjs && git commit && git push` on a weekly
     Windows Task Scheduler entry. Simplest. Ali asked for this to be written;
     it was not written before the handoff.
   - Residential proxy for the Vercel sync. Costs money, adds a dependency.

Manual rebuild, any time, from Ali's machine (works today):
```bash
cd /g/stocksaathi/app
node scripts/build-universe.mjs
node scripts/build-mf-universe.mjs
git add js/data/ && git commit -m "chore(data): refresh universe" && git push
```

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

### 4.3 Failover stack — needs credentials only Ali can generate
`backup-deploy.yml` deploys Fly.io + Cloudflare Pages + a CF Worker front door
(Ali built it in commit `91ec661`, 2026-04-21). **336 runs, 0 successes.**

The cause was **not** the missing secrets, as first assumed — it was
`parity-check`, the first job, failing because `api-backup/main.py`'s `_ROUTES`
was missing 4 handlers. That is **fixed**; parity now passes 16/16.

It will now get past parity and fail at the deploy steps until these exist as
GitHub repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`FLY_API_TOKEN`. Whether Ali wants the failover at all is still his call — the
alternative is deleting `backup-deploy.yml`, `edge/` and `api-backup/`.

**If deleting: `api-backup/main.py` is no longer standalone.** It imports the
shared shim from `handlers/_shim.py`, and `test_route_parity.py` is what keeps
`ROUTES` honest. Removing `api-backup/` removes that guard.

### 4.4 `data-sync` workflow runs but the instruments step fails
`.github/workflows/data-sync.yml` (daily 13:15 UTC) authenticates correctly
now. Run #1 failed at the instruments step with the §2.5 NSE block. The
fundamentals step only warns on failure by design (upstream rate-limits, a
partial refresh is still useful), so it does not abort the MF step.
`dhan_instruments` and `mf_master` remain **0 rows** and, per §2.5, may be
unfillable from the cloud entirely.

### 4.5 Smaller open items
- `api/fundamentals.py:474` still appends `.NS` only. Different crumb/Tickertape control flow; untested, left alone.
- `handlers/history.py:191` echoes an assumed ticker in its response. Cosmetic.
- `fundamentals_cache` table **does not exist**. `handlers/screener.py` falls back to the committed `js/data/fundamentals_full.json` and says so in its own docstring. Migration `2026-04-25c_fundamentals_cache.sql` was never applied.
- Supabase Auth: leaked-password protection is **off**.
- `admin_audit_log` has RLS enabled with zero policies (works only because service-role bypasses RLS).
- `js/data/fundamentals_full.json` is a May snapshot, same staleness class as the universe was.

---

## 5. Claims made this session that turned out wrong

Recorded so they are not repeated.

1. **"Missing GitHub secrets are why `backup-deploy` fails"** — no, the parity test was failing first, before any secret was needed.
2. **"Every run failed"** (said after seeing 4 red icons) — true, but asserted before checking. `is:success` → 0 results confirmed it afterwards.
3. **"`ADMIN_TOKEN` is unset, so the admin surface is closed"** — it was set. The admin surface is armed.
4. **"A user pasted the admin path"** — it was Ali's own account, testing.
5. **"The token is almost certainly in `coach_messages` too"** — it was in `coach_chats` only.
6. **"`coach_chats` is 2 rows of vestigial junk"** — it held one user's only copy of a real conversation.
7. **"GitHub runners can't reach NSE"** — plausible, never tested. See §4.1.

Pattern: the DB and the live services disagree with the source comments
constantly. `schema.sql:810` claims the leaderboard was dropped in April; it
was still serving minors' school names to anonymous callers in September.
**Check the live system, not the comment.**

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
