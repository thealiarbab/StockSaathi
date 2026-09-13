# Master bugfix list — trade-path security, 2026-09-13

Project: StockSaathi (`hwlmwraowcylxzdpumca`, ap-south-1) · paper-trading sim for teens.
Scope: the server-side trade/ledger path. Started from an audit brief about
absurd holdings on one account; became a full red-team of the write path.

Two commits on `main`:
- `d28b2b4` — restore server-side fill pricing, lock money tables
- `8720d45` — apply_trade always books the server price, kill the 10% band

All four fixes were applied to **production** (Supabase migrations) **and** the
repo, and each was verified live by issuing the attack as the `authenticated`
role wearing the QA account's JWT (`0ac0ffee-…-beef`) inside a rolled-back
transaction — i.e. the exact gate a real logged-in attacker hits, not the
elevated MCP role.

---

## The bugs

### BUG-1 — Limit-order fill trusted the client's "market price"  ·  CRITICAL (P0)
- **Component:** `_fill_limit_order_core` (+ wrappers `fill_limit_order`, `admin_fill_limit_order`)
- **Class:** client-trusted financial input (CWE-602)
- **What:** `p_market_paise` is caller-supplied and drove **both** the "has the
  market crossed the limit" gate **and** the fill price
  (`least/greatest(v_limit_price, p_market_paise)`). `fill_limit_order` is
  granted to `authenticated`, so any user could fill their own SELL limit with
  a huge `p_market_paise` and mint arbitrary cash.
- **Why it was live:** a **regression**. `2026-09-12b` fixed `fill_limit_order`
  to price from `quote_cache`. ~24h later, `2026-09-13d` refactored the fill
  path into a shared `_fill_limit_order_core` and wrote the body from the
  **pre-12b** copy — dropping the lookup. Nothing failed; it was reviewed as a
  feature change.
- **Fix (`2026-09-13i`):** price the fill from `quote_cache`, fall back to
  `mf_master.nav` for mutual funds (they have no `quote_cache` row, so a
  quote-only rule would freeze every MF order forever), and **refuse — leaving
  the order pending for the next tick — rather than cancel** when unpriceable.
  `p_market_paise` kept in the signature for compatibility, ignored. Core
  revoked from `anon`/`authenticated`.
- **Verified live:** `fill_limit_order(order, 999999999999999)` → filled at the
  real 70825; direct call to `_fill_limit_order_core` → `42501`.

### BUG-2 — Money tables were writable directly over PostgREST  ·  CRITICAL (P0)
- **Component:** grants + RLS on `holdings`, `portfolios`, `limit_orders`,
  `transactions`, `transfers`, `portfolio_history`
- **Class:** broken access control (ownership-not-authorship RLS + default grants)
- **What:** Supabase's project template grants INSERT/UPDATE/DELETE on every
  `public` table to `anon` **and** `authenticated`, and
  `holdings`/`portfolios`/`limit_orders` carried `FOR ALL using (auth.uid() =
  user_id)` policies. `FOR ALL` is an **ownership** test, not an **authorship**
  test — it asks "is this row yours", never "did a legitimate code path write
  it". So a logged-in user could `POST /rest/v1/holdings` with
  `qty = 999999999999, avg_cost_paise = 0`, or `PATCH` their own `cash_paise`,
  bypassing `apply_trade` entirely and making the pricing fixes moot.
- **Status:** open but not exploited **via this vector** — the absurd rows that
  triggered the audit came through `apply_trade` in its pre-12b state, not this
  hole (see NOT-CHANGED-1).
- **Fix (`2026-09-13e`):** revoke INSERT/UPDATE/DELETE/TRUNCATE from
  `public, anon, authenticated` (keep SELECT — the app reads these directly);
  replace the three `FOR ALL` policies with read-only ones; drop
  `txn_self_insert` and `transfers_sender_insert` (the ledger is written by
  `apply_trade`/`apply_transfer` alone). Same revoke applied to the price
  sources `quote_cache`, `mf_master`, `dhan_instruments` as defence-in-depth.
- **Verified live:** direct INSERT/UPDATE/DELETE/TRUNCATE → `42501`; own SELECT
  still returns rows; cross-user read → 0 rows (RLS); the SECURITY DEFINER RPCs
  (owner `postgres`) still write normally.

### BUG-3 — apply_trade honored the client price within ±10%  ·  HIGH
- **Component:** `apply_trade`
- **Class:** client-trusted financial input (partial)
- **What:** `apply_trade` clamped the client price to the `quote_cache`
  reference **only when it was >10% off**; within ±10% it **booked the client's
  number**. A crafted request took the favorable edge of that window on every
  trade — buy at `ref − 10%`, sell at `ref + 10%` — ≈ **+22% per round-trip,
  compounding**. Bounded (no overflow, no unbounded mint, no cross-user), but a
  steady portfolio/leaderboard-inflation vector. Live since `2026-09-12b`.
- **Why the band existed:** to tolerate a sub-1% cache/quote timing race so an
  honest fill matched the on-screen price — cosmetic, and already covered by the
  `price_adjusted` flag. (The race is ≤5s during market hours and **zero** after
  close, where the price is frozen — so ±10% was hundreds of × too wide.)
- **Fix (`2026-09-13j`):** always book `v_ref_price`; `p_price_paise` is
  advisory only; `v_adjusted` reports when the two differed so the UI
  reconciles. No band.
- **Verified live:** buy@113175 (ref−10%) → booked **125750**; sell@77907
  (ref+10%) → booked **70825**; honest trade at the true price → `adjusted=false`.

### BUG-4 — schema.sql would reintroduce closed holes if re-run  ·  MEDIUM (latent)
- **Component:** `supabase/schema.sql`
- **What:** the header claimed *"idempotent: safe to re-run"*, but the file
  still held the **pre-12b** `apply_trade` / `fill_limit_order` bodies (client
  pricing) and the `FOR ALL` policies. A rebuild or a well-meaning re-run would
  `create or replace` the vulnerable versions back over every fix above.
- **Fix (part of `d28b2b4`):** blunt "do not re-run" warning header; policies
  corrected in place (read-only + drop the `FOR ALL`); table-grant revokes
  appended at the end (after every table exists).

---

## Guardrails added — so these can't silently regress a third time

`api-backup/tests/test_trade_pricing_guards.py` (runs in CI via
`backup-deploy.yml`, which executes `pytest api-backup/tests/`). Static checks
against the **newest** migration defining each function — the repo is what
regressed, so the repo is what's guarded. Each was confirmed to **fail** against
the pre-fix code:

1. `apply_trade` and `_fill_limit_order_core` newest definition must read `quote_cache`.
2. `_fill_limit_order_core` must not act on `p_market_paise`.
3. `_fill_limit_order_core` must have an `mf_master` fallback.
4. `_fill_limit_order_core` must be revoked from `anon`/`authenticated`.
5. Money tables must have their client writes revoked, with no `FOR ALL`
   policy created after the revoke.
6. `apply_trade` must book `v_ref_price`, never assign `p_price_paise` to the
   booked price, and carry no `v_band`.

---

## Found but deliberately NOT changed

- **NOT-CHANGED-1 — the PoC rows.** `business@stocksaathi.co.in` (username
  `admin`, id `73c89104-…`) holds 13 rows incl. `qty = 999999999999,
  avg_cost = 0` across MRF/BOSCHLTD/etc. Diagnosed as **proof-of-concept
  artifacts** from the 2026-09-12 audit (each has a matching `price_paise = 0`
  transaction; timestamps are a scripted 1-second batch). Not an exploit, not a
  code bug. Left in place pending an owner decision to clear them with
  `admin_reset_user`. Blast radius checked and clean — no other user has
  zero-cost holdings, no transfers left the account, no anomalous cash.
- **NOT-CHANGED-2 — `place_limit_order` accepts absurd limit prices (Vector E).**
  Now harmless: the **fill** is server-priced (BUG-1 fix), so an absurd limit
  simply never crosses and sits pending. Flagged as low-priority hardening
  (add a sanity band on placement); not applied.

---

## Red-team summary

24 adversarial probes across two rounds, each as the `authenticated` role with
the QA account's JWT, each rolled back; QA account verified byte-for-byte
unchanged afterward.

| Class of attack | Result |
|---|---|
| Direct write of trillions to `holdings` / cash to `portfolios` | `42501` |
| Fabricate ledger / limit order / incoming transfer; DELETE/TRUNCATE | `42501` |
| Poison the price source (`UPDATE quote_cache`) | `42501` |
| Read / write another user's rows | 0 rows (RLS) / `42501` |
| Call `admin_reset_user` / `admin_fill_limit_order` / `admin_exec_sql` | `42501` |
| `apply_trade` BUY @₹0.01 / SELL @₹1e14 / 1e12 shares @₹0 | clamped / clamped / `22003` refused |
| `fill_limit_order` with market = 1e15 (BUG-1) | filled at real price |
| ±10% band edge, buy −10% / sell +10% (BUG-3) | booked at real price (post-fix) |
| Oversell; negative price | insufficient holding; clamped |

No trillions. No unbounded mint. No overflow corruption. No cross-user write.
No admin escalation.

---

## Footnotes — corrections to my own earlier analysis in this session (not system bugs)

- Initially claimed `avg_cost_paise = 0` rows must have **bypassed** `apply_trade`.
  Corrected: they went **through** `apply_trade` while it still trusted the
  client price (matching `price_paise = 0` transactions exist).
- Initially said `quote_cache` refreshes every ~5 minutes. Corrected: **5s**
  during market hours; 5 min only when the market is closed and the price is
  frozen.
