# Portfolio "Value over time" — master bugfix record

**Date:** 2026-09-13 · **Deployed:** v275 → v279 · **Status:** all fixed and verified in production

Started as one report — *"the portfolio chart always shows 'Make your first trade
to start charting' for ALL users"* — and turned into nine defects across the
client store, the chart renderer, the database, the scheduler, and DNS.

This file exists because **git alone does not tell the whole story**. Two
database migrations were applied through the Supabase API before they were
written to `supabase/migrations/`, and several fixes are only legible together.
Read this first, then the commits.

---

## The nine

### 1. The reported bug — `portfolioHistory` silently discarded · CRITICAL

`getState()` in `js/state.js` does **not** spread the store. It returns an
explicit object literal, and `applyFullPatch()` rebuilds `_userState` from a
second explicit literal. **Any key missing from both lists is silently dropped.**

`sync.js` had been correctly fetching `portfolio_history` and calling
`setState({ portfolioHistory })` since Hotfix66a — but the key was in neither
list, so every fetched row was written into a throwaway object and dropped on the
next line. `state.portfolioHistory` read `undefined` for **every user**,
`histValues.length` was always 1 (just the live point), `hasRealHistory` was
always false. Data-independent, which is why it hit 100% of users while 42 of
them had real rows in the table.

**Fix:** added `portfolioHistory` to `DEFAULT_STATE`, the `getState()`
projection, `applyFullPatch`, and the localStorage quota-trim list.

> **Trap for the next person:** adding a new synced field to this store requires
> editing *three* separate lists. Miss one and the field vanishes with no error.

Proved by running the real module in Node against both commits:
`pre-fix: typeof=undefined, histValues=[99100]` → `post-fix: 3 rows, hasRealHistory=true`.

---

### 2. Flat series rendered as a blank chart

`lineChart()` had no guard for `max === min`. A perfectly flat series divided by
zero, every path coordinate became `NaN`, the browser discarded the `<path>`,
and the chart rendered **blank** — indistinguishable from "no data".

Hit 11 of the 42 users with history, for the reason in §4.

**Fix:** open the band to ±1% (±1 unit at zero) and draw the flat line. Also
fixes `js/pages/admin.js`, which still uses `areaChart`.

---

### 3. No periodic snapshot ever existed

`schema.sql` documents an hourly `admin_portfolio_backfill` cron. **It existed in
no scheduler** — `vercel.json` declares no crons and no GitHub workflow called
it. All 312 rows were `source='trade'`, so a series began at the user's first
trade with one point per trade. 8 traders had exactly one row.

**Fix:** `/api/admin-snapshot-portfolios` + `.github/workflows/portfolio-snapshot.yml`,
16:00 IST weekdays.

> Deliberately **not** a step in `data-sync.yml`: that job's first step exits 1
> on the broken Dhan instrument feed (which is why `mf_master` is at 0 rows), and
> anything appended to it inherits that failure silently.

---

### 4. `admin_portfolio_backfill()` lied about what it did

Its docstring promised *"walks every user's transactions and emits daily
snapshots"*. The body inserted exactly **one** row at `now()` in both modes.

**Fix:** rewritten — see migrations `2026-09-13k` / `2026-09-13l`.

---

### 5. Cost-basis valuation carries zero information · DESIGN

The per-trade trigger values holdings at cost basis. Cost basis makes a BUY
**value-neutral** — ₹X of cash becomes ₹X of stock — so `cash + Σ(qty × avg_cost)`
never moves. A buy-and-hold user's entire series is a dead-flat line at their
starting cash and *cannot express a gain or a loss*. That is why 11 users had
flat series in §2.

**Fix:** mark-to-market daily snapshots, priced in the **app layer**.

> **`quote_cache` is NOT usable for valuation.** It is a demand-filled TTL cache —
> a row refreshes only when somebody views that symbol. On 2026-09-13 exactly
> **1 of 128** held symbols had a quote fresher than 7 days. Valuing from it
> stamps months-old prices as today's number. The handler prices via
> `live-quote.py`'s Dhan → Yahoo chain and passes a symbol→paise map into the
> RPC. `MF_*` has no quote coverage anywhere and falls back to cost basis.

---

### 6. One account's holdings aborted the snapshot for everyone · CRITICAL

Found by *running the RPC against production with a real 115-symbol price map*.

User `73c89104` holds `qty = 999,999,999,999` of ~12 of the most expensive
symbols on the exchange at `avg_cost_paise = 0`. Cost basis reads 0, so nothing
ever noticed. Valued at a real price: `999999999999 × 12829000 = 1.28e19` paise,
past bigint's `9.22e18`.

The severity is the **blast radius** — holdings are summed per user inside one
loop, and an uncaught error aborts the whole function. One nonsense row stopped
the daily snapshot for all 44 trading users.

**Fix:** numeric arithmetic throughout, clamp once, `exception when others` per
user, and report `users_value_clamped` / `users_failed` so it stays visible.
The absurd rows were deliberately **not** rewritten — a snapshot job has no
business editing holdings. See `2026-09-13e_revoke_direct_writes_on_money_tables.sql`
for the write-path hole that allowed them.

---

### 7. The chart was a list, not a timeline

`areaChart` positions points by **array index**. A trade in April and one
yesterday sat the same distance apart — five months of holding looked identical
to five minutes. No axis dates, no hover, no reference line, no last-value badge.

**Fix:** rebuilt on `stockChart()` in area mode with a real time axis — the same
engine the markets page uses. Verified: points 240 ms apart now render **0.0 px**
apart, points months apart **44 px** apart; under `areaChart` both gaps were
identical.

---

### 8. Y-axis ticks collapsed / zoomed into rounding noise

Two rounds, both caught only by **looking at the deployed page**.

**8a — duplicate ticks.** `formatAxisNumber` picks unit and precision per value.
At lakh scale a ₹1,300 spread rendered `₹1.01L` three times, and the unit flipped
at exactly `1e5` so one tick read `100.0k` and the one above it `1.01L`.
→ `makeAxisFormatter(min,max)`: one unit + precision for the whole axis, chosen
from the span. Opt-in via `axisFormat:"span"`.

**8b — auto-fit magnified noise.** `stockChart` auto-fits Y to visible data,
correct for a share price that genuinely ranges intraday. Portfolio snapshots sit
within a few rupees of each other, so 3M rendered an axis of
`99821.71 → 99824.47` — a **₹2.76** band across full chart height — and a
vertical red spike. Accurate, and completely misleading.
→ `pfYBounds()` floors the visible span at 1% of portfolio value (min ₹100).

> Stock charts have the same latent 8a bug (a ₹1,257 share with a ₹25 range
> renders `1.26k` five times). Left alone on purpose — separate surface, deserves
> its own change.

---

### 9. `www.` loaded signed-out

Not an auth bug. `www` and the apex are **separate origins**, and `localStorage`
is keyed by scheme+host+port, so the Supabase session at `ss.sb.session.v1`
written on the apex is invisible on `www`. Both resolved straight to Vercel, both
served 200.

**Fix:** host-conditional 308 in `vercel.json` (redirects run before rewrites, so
it never reaches a function; 308 preserves method+body for `POST /api/*`;
browsers re-append the `#/route` fragment themselves).

> **And in the Worker too.** `edge/front-door/src/index.js` rewrites the `Host`
> header to the origin hostname when proxying, keeping the real host only in
> `x-forwarded-host`. The moment that Worker fronts `www`, Vercel stops seeing
> `Host: www.stocksaathi.co.in` and the redirect **silently stops firing**. Two
> layers on purpose — a redirect whose failure mode is silent deserves belt and
> braces.

---

## Sparse data: why ranges came back

v278 withdrew 1M/3M because selecting 3M drew a vertical spike against an empty
quarter. That was the right symptom read and the **wrong fix** — hiding a control
because the data behind it is awkward.

The real issue: **a stock has a price at every moment; a portfolio is sampled.**
Trades plus one daily snapshot. A 90-day window can hold three points all written
on the same afternoon, and plotting only those asserts "nothing existed for 89
days", which is false.

`pfWindow()` now carries the **last known value forward** to the window's left
edge — last observation carried forward, what every broker does. Carried points
are flagged `synthetic` and never drawn as sample dots: they state what we knew,
not that we measured.

v279 restores the full ladder (`1D 1W 1M 3M 6M YTD 1Y ALL`) plus wheel/pinch
zoom, drag-pan and a reset pill, using the same `chartZoom.js` engine as the
markets chart.

---

## Production state after the work

| | before | after |
|---|---|---|
| Traders with a drawable line | 0 | **44 / 44** |
| Flat (blank-rendering) series | 11 | **0** |
| Snapshot sources | `trade` only | `trade` + `backfill` anchor + daily MTM |
| Snapshot schedule | none | 16:00 IST weekdays |

---

## What git does NOT tell you

1. **Two migrations were applied via the Supabase API before being written to
   the repo** — `20260913140516_portfolio_history_anchor_and_mtm_snapshot` and
   `20260913142652_portfolio_snapshot_overflow_safe`. Backfilled as
   `2026-09-13k` / `2026-09-13l`; **`13l` holds the authoritative bodies**.
   Check `list_migrations` against `supabase/migrations/` before assuming the
   repo describes the database.

2. **One-off data operations are not in any file.** `admin_portfolio_backfill(false)`
   was run once (44 anchors), and `admin_portfolio_snapshot_mtm` once with a live
   115-symbol price map (44 snapshots, 1 clamped, 0 failed). Re-running is safe —
   both are idempotent.

3. **The daily MTM job has run exactly once**, manually. Charts fill in ~one point
   per trading day from 2026-09-14. Until roughly a week accumulates, most users'
   charts are legitimately a handful of dots — thin data, not a broken chart.

4. **Open follow-up:** the trillion-share account (§6) is contained, not
   explained. `authenticated` held INSERT/UPDATE on `holdings`, which would let a
   client write them directly over PostgREST.

---

## Files touched

| Area | Files |
|---|---|
| Client store | `js/state.js` |
| Chart engine | `js/components/charts.js` |
| Portfolio page | `js/pages/portfolio.js` |
| Snapshot API | `handlers/admin-snapshot-portfolios.py`, `handlers/_shim.py` |
| Scheduling | `.github/workflows/portfolio-snapshot.yml` |
| Routing | `vercel.json`, `edge/front-door/src/index.js` |
| Database | `supabase/migrations/2026-09-13k…`, `…13l…` |
| Cache | `sw.js` (v275 → v279) |

## Commits

```
4b7fd87  fix(portfolio): make "Value over time" actually have data to draw
18dab8f  feat(portfolio): draw "Value over time" on the real chart engine (v276)
51cd9b5  fix(portfolio): y-axis ticks collapsed on short ranges (v277)
0e17dd6  fix(portfolio): stop the chart zooming into rounding noise; fold www into apex (v278)
24f15c2  fix(edge): canonicalise www at the Worker too, not just at Vercel
4dcb2a0  feat(portfolio): full range ladder + wheel/pinch zoom (v279)
```

§1 and §2 are **not** in those commits — they were swept into `4605227`
(`fix(coach): remove the output cap…`) by a concurrent agent's `git add -A`.
Searching the log for "portfolio" will not find the fix for the originally
reported bug.
