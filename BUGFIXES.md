# Bugfix ledger

Defects found and fixed, newest session first. Companion to `STATUS.md` — that
file describes the *current state* of the system; this one records *what was
broken and how it was proven fixed*, so a later session can tell the difference
between "this was checked" and "this was assumed".

Each entry records four things deliberately: **what broke**, **why it stayed
hidden**, **the fix**, and **the proof**. The third column is the cheap one to
write and the first two are the ones that save the next investigation.

---

## 2026-09-13 — §4.1 / §4.3 / §4.5 session

**10 defects · 9 code/CI commits · 4 migrations.** Nine of the ten were
reporting success while doing nothing — see *The pattern underneath* at the end.

### Data correctness — these reached users

The product is a paper-trading simulator for 13–18 year olds. A wrong price is
a wrong fill, not a cosmetic defect.

---

#### 1. Mutual funds priced at NAVs up to seven days old
`357560f` · `.github/workflows/universe-refresh.yml` · **wrong price**

- **Broke:** `js/data/mfFull.json` ships a `nav` for all 14,120 schemes, and
  `js/data/marketData.js` `synthMFQuote` prices a fund as `inst.nav * 100`
  straight from that file. The rebuild ran weekly. AMFI publishes NAVs every
  business day.
- **Hid behind:** the workflow comment justified weekly with "the NSE universe
  changes slowly" — true of listings, and never true of the other half of the
  same file. Two datasets with different refresh needs shared one cadence.
  `data-sync.yml` *did* refresh the `mf_master` table daily, but the front end
  reads the committed JSON, not the table, so that never covered it.
- **Fix:** `cron: "30 2 * * *"` — daily at 08:00 IST, which picks up the
  previous business day's NAVs.
- **Proof:** daily cron registered and active on the default branch.

> Not corrected: fills already executed at stale NAVs are still in the
> database. The fix stops new ones.

---

#### 2. The AMFI sync dropped all 14,120 mutual funds, every run
`a452254` · `handlers/admin-sync-mf.py` · **total data loss**

- **Broke:** AMFI split `Plan` and `Option` out of the scheme name into their
  own columns, taking `NAVAll.txt` from 6 fields to 8. The handler unpacked
  `cols[:6]`, so `nav_str` came from the *Plan* column, `float("Direct Plan")`
  raised, and every row was discarded. `mf_master` sat at 0.
- **Hid behind:** three layers. The `len(cols) < 6` guard passed, because
  8 ≥ 6. The endpoint answered **HTTP 200** while carrying
  `{"ok": false, "amfi_parse_underfilled"}` in the body, and `data-sync.yml`
  only checked the status code. And `STATUS.md` §2.7 recorded this bug as
  *fixed* — it was, in `scripts/build-mf-universe.mjs`. Nobody checked the
  Python twin.
- **Fix:** handles both layouts; plan and option are classified from the
  dedicated columns as well as the name, since the name no longer carries them.
- **Proof:** against the live feed, **14,120 rows parsed, 0 bad NAVs, 0 missing
  dates** — matching the JS build exactly. Production then upserted 14,120.
  4,235 Direct / 9,885 Regular.

> **When a parser exists in two languages here, fix both.**

---

#### 3. Fundamentals failed completely for every SME stock
`7e28700` · `handlers/fundamentals.py:474` · **feature dead**

- **Broke:** one ticker was built as `symbol + ".NS"` and fed to all three
  Yahoo tiers, so for any BSE-only or SME scrip every request queried a ticker
  that does not exist. `7NR` returned `ok: false` outright; `BMW` returned
  `source_tiers: ["tickertape"]` with `exchange: null`.
- **Hid behind:** Tickertape covers BSE main board, so it silently backfilled
  most fields and the failure only surfaced fully on SME, which Tickertape does
  not carry. `STATUS.md` §4.5 listed this line as "untested, left alone", and
  `/api/quote` had served the same symbols correctly for weeks, which made the
  area look healthy.
- **Fix:** falls back to `.BO` the way `handlers/quote.py:37` already did,
  gated on no `yahoo_*` tier reporting in — so an NSE symbol never pays for the
  retry. The retry runs *before* the `all_sources_failed` bail-out, which is
  what the SME case needs: that path returns early precisely because both
  Tickertape and the `.NS` tiers came back empty.
- **Proof:** live — `7NR` → `7NR.BO`, ₹7.15, exchange BSE, all three Yahoo
  tiers. `BMW` → `BMW.BO`. `RELIANCE` unchanged on `.NS`.

---

#### 4. The daily fundamentals refresh processed zero symbols, forever
`4dbbf9d` · `handlers/admin-sync-fundamentals.py` · **silent no-op**

- **Broke:** it pages through `dhan_instruments`, which is filled by a sync
  that fetches from NSE on Vercel — and NSE blocks Vercel. The table has always
  been empty, so there were no symbols to iterate.
- **Hid behind:** `{"ok": true, "processed": 0}` on every page. Downstream,
  `handlers/screener.py` quietly fell back to a committed JSON snapshot
  generated **2026-04-26 — 140 days stale**.
- **Fix:** falls back to the committed `js/data/universeFull.json` (4,269
  equities), as `screener.py` already does for its own data.
- **Proof:** `/api/screener` answers `source: "supabase"` instead of the static
  fallback.

> **Trap:** `idx` in `universeFull.json` is an index-tier **code**, not a rank —
> 7 = Nifty 50 (RELIANCE/TCS/HDFCBANK/INFY all carry 7), 6 = next 50,
> 12 = Midcap 150, 20 = Smallcap 250, 0 = unindexed. Sorting it descending,
> which is what `idx_tags.desc` reads like, refreshes smallcaps *before*
> Nifty 50.

---

#### 5. The history endpoint reported a ticker it had not used
`36d833f` · `handlers/history.py:193` · **wrong value, cosmetic**

- **Broke:** `fetch_yahoo` tries `.NS` then `.BO` and knows which answered —
  then threw it away, and the response re-derived `symbol + ".NS"`. A BSE
  symbol reported a ticker Yahoo had in fact 404'd on.
- **Hid behind:** nothing in `js/` reads the field. Verified cosmetic before
  fixing rather than assumed.
- **Fix:** returns the ticker the fetch actually succeeded on.

---

### Security

Both stem from one misconception, now recorded as `STATUS.md` §2.9.

---

#### 6. Anonymous callers could truncate the admin audit log
`96ec294` · migration `2026-09-13g` · **audit trail**

- **Broke:** `admin_audit_log` carried **direct** grants of `arwdDxtm` to both
  `anon` and `authenticated`. The `D` is TRUNCATE. Behind it: 25 `user_delete`
  entries.
- **Hid behind:** RLS was enabled with zero policies, which reads as deny-all
  and was logged as a benign advisor lint. But **PostgreSQL RLS does not govern
  TRUNCATE** — it covers SELECT, INSERT, UPDATE and DELETE only. Not reachable
  over PostgREST, which exposes no TRUNCATE verb, but the grant was wrong and
  the table is service-role-only by design.
- **Fix:** `revoke all … from anon, authenticated`. The grants were direct, not
  inherited from `PUBLIC`, which is why §2.4's "revoke is usually a no-op"
  warning did not apply.
- **Proof:** `has_table_privilege` per §2.4's rule, not the migration's own
  success report — anon and authenticated false on all five verbs,
  `service_role` true. `order_backfill_audit` was already correct and is the
  shape to copy.

---

#### 7. Two new cache tables arrived with the same TRUNCATE hole
`96ec294` · migration `2026-09-13h` · **write access**

- **Broke:** Supabase grants `anon` and `authenticated` the full `arwdDxtm` on
  *every* new table in the `public` schema. `fundamentals_cache` and
  `tickertape_sids` inherited it on creation.
- **Fix:** public `SELECT` kept (both hold public market data behind a
  `using (true)` read policy); `insert, update, delete, truncate` revoked.
- **Proof:** anon/authenticated `SELECT` true, all write verbs false;
  `service_role` unchanged.

---

### Automation & CI

---

#### 8. One blocked step killed the entire daily sync
`91905e8` · `.github/workflows/data-sync.yml` · **job aborted**

- **Broke:** the instruments step ended in `[ "$code" = "200" ] || exit 1` with
  no `continue-on-error`. That endpoint runs on Vercel, which NSE blocks, so it
  returned HTTP 500 every run — and took the job down with it. **The two steps
  after it never ran at all.**
- **Hid behind:** `STATUS.md` §4.4 recorded the fundamentals step as non-fatal
  by design, which was true — but the step that killed the run was the one
  *before* it. The fundamentals and MF syncs were not failing; they were never
  reached. One line is why three tables sat at zero.
- **Fix:** warns and continues, matching the fundamentals step. Nothing
  user-facing reads `dhan_instruments`.
- **Proof:**

| Table | Was | Now |
|---|---|---|
| `mf_master` | 0 | **14,120** (all with NAV + date, newest 2026-09-14) |
| `fundamentals_cache` | 0 (table absent) | **197**, climbing each run |
| `tickertape_sids` | 0 (table absent) | **162** |

---

#### 9. The cache accepted no writes because of one missing column
`96ec294` · `fundamentals_cache` schema · **silent write loss**

- **Broke:** the April migration creating `fundamentals_cache` had never been
  applied, so `read_cache`/`write_cache` were no-ops. Applying it was *not*
  enough: `write_cache` posts a `debt_to_equity` field the April definition
  never had, and PostgREST rejects the whole row with `PGRST204`.
- **Hid behind:** `write_cache` is documented "best-effort — failure is
  silent." Three live requests after creating the table, it was still empty.
  The schema and the handler drifted apart while the migration sat unapplied.
- **Fix:** column added. `read_cache` uses `select=*`, so only the write path
  was affected.
- **Proof:** RELIANCE, 7NR and BMW cached with `debt_to_equity` populated.

---

#### 10. 366 runs, 0 successes — burying the only CI this repo has
`92ac930` · `.github/workflows/backup-deploy.yml` · **CI blind**

- **Broke:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and
  `FLY_API_TOKEN` have never been set, so `wrangler` and `flyctl` failed on
  every push to main.
- **Miscategorised, not hidden:** `STATUS.md` §4.3 framed deletion as costing
  only the route-parity guard. In fact `parity-check` runs **two** test files —
  `test_route_parity.py` *and* `test_order_execution_guards.py`, the regression
  guards for the bug that left orders rotting up to 128 days with users' cash
  reserved — plus `scripts/check-js-syntax.mjs`, added after a syntax error
  blanked the homepage in v273. **It guards the main app, not the backup.**
- **Fix:** a `preflight` job reports credential presence and gates
  `deploy-pages` / `deploy-fly`; `deploy-worker` and `verify` skip by cascade.
  Green with deploys skipped; add the secrets and they deploy with no further
  edit. The `secrets` context is unavailable in a job-level `if:`, hence the
  indirection.
- **Proof:** first green run in the workflow's history, and green on every
  commit since — including both parallel agents'.

---

#### Bonus — universe auto-refresh was off on an untested claim
`8a74acd` · `.github/workflows/universe-refresh.yml`

The workflow asserted `DOES NOT WORK ON GITHUB-HOSTED RUNNERS` in capitals.
That was extrapolated from NSE blocking Vercel — measured on one host, asserted
of another, then written into a comment where it read as fact for four months.

Run `34761640980` on `ubuntu-latest`: `EQUITY_L.csv` **HTTP 200, 2,568 rows** —
the same count a residential connection gets. Plus SME 571, BSE 3,548, all 20
index CSVs, 350 ETFs.

---

### The pattern underneath

`STATUS.md` §5 already warns that source comments contradict the live system.
This session added a second failure mode deserving the same suspicion:
**a success signal is not evidence of an effect.**

| Signal that lied | What was actually true |
|---|---|
| `HTTP 200` | body carried `ok: false` or `processed: 0` |
| `{"success": true}` | a Postgres `REVOKE` that changed nothing |
| green workflow step | a script whose write was silently rejected |
| `RLS enabled` | does not cover TRUNCATE |
| "fixed in §2.7" | fixed in one of the two languages it lives in |

In each case the check was cheap and the assumption was expensive. **Verify the
effect, not the exit code.**
