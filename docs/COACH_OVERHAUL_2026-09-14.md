# Coach latency + context overhaul — master record

**Date:** 2026-09-14 · **Deployed:** v280 → v287 · **Commits:** `5f246fb` … `fd795ca`

Sequel to [`COACH_FIXES.md`](COACH_FIXES.md), which fixed 46 defects in the
coach's *answers*. This one is about the coach's **speed** and what it is
allowed to **know** — plus eight defects found along the way that had nothing
to do with either.

Written as a handoff. Everything below was verified against the live database,
the live site, the live Vercel/GCP consoles and a real Chrome session. Read
this before crawling the repo; it exists to save you that.

---

## 0. If you read one section

The owner's complaint was *"fetch a list of 20 bank stocks takes 20+ seconds
and gives no prices"*. Both halves are fixed.

| | before | after |
|---|---|---|
| reply | 5 prices + 15 bare names | **20 banks, 20 prices** |
| wall clock | >20s reported | **~4s** typical |
| quote fan-out | uncached, serial-retry endpoint | 294–504ms each, parallel, warm cache |

The single biggest lever was **not** the architecture. It was four lines:

```js
// js/coach/agent.js — runAgent
reasoningEffort: lastTurnRanTools ? "minimal" : undefined,
```

Measured on production, same model, same prompt, only that field differing:

| `reasoning_effort` | TTFT | complete |
|---|---|---|
| `low` (the `fast` profile default) | 6.64 / 6.93 / 6.65 s | 10.19 / 9.38 / 8.92 s |
| **`minimal`** | **1.27 / 1.40 / 1.63 s** | **4.09 / 3.12 / 4.52 s** |

A tool turn has two phases that want opposite things — *deciding which tool to
call* (a real judgement, ~30 tokens out) and *writing the answer* (no decision
left, long output). `reasoning_effort` applies per request, so one setting was
serving both. The writing turn was paying for a full thinking phase to emit
prose it already had every input for.

**`api/chat.js` already honoured an explicit value** ("a caller that sets
`reasoning_effort` explicitly always wins", line ~434) — it only applies the
per-profile default when the field is `undefined`. The plan for this work
asserted that per-phase effort required a server-side rewrite. It did not, so
**`api/coach.js` was never built.**

---

## 1. Verified environment facts

These were *measured*, not read from source. Several contradict what the repo
said at the time.

| Thing | Reality |
|---|---|
| LLM provider | **Vertex AI**, project `gen-lang-client-0129344832`. Not Groq, not AI Studio. |
| Models | `chat`/`fast` → `gemini-3-flash-preview`; `reasoning` → `gemini-3.1-pro-preview`; `json` → `gemini-2.5-flash-lite` |
| **Effective provider chain** | **One vendor.** `OPENAI_API_KEY` and `CEREBRAS_API_KEY` are UNSET, so `providerDescriptors()` filters them out. Every profile is 2 Gemini models. |
| Vertex latency (Google-side, 30d) | p50 0.81s · p95 1.84s · p99 3.57s — **Google is fast; the latency is ours** |
| Vertex errors | ~4% HTTP **409**, ~0% 429 (not quota) |
| Vertex spend | ₹3 (Jul) → ₹18 (Aug) → ₹60 (Sep) |
| Cloudflare Worker | **NOT DEPLOYED.** Production is `Server: Vercel`, no `cf-ray`. `wrangler.toml` KV id is still the literal placeholder. |
| Order matcher | **GitHub Actions only.** Evidence: 56 of 130 fills have non-zero seconds = irregular HTTP-triggered runs, not a per-minute cron. |
| Quote sources | **Yahoo only.** Dhan has never served a quote: `DHAN_ACCESS_TOKEN` unset, and all 3,655 `quote_cache` rows over five months are `source='yahoo'`. |
| `pg_cron` | **Installable on free tier** (1.6.4, now installed). `pg_net` remains UNTESTED and is not needed by anything. |
| Supabase branching | **Requires Pro.** `create_branch` → `PaymentRequiredException`. |
| Vercel functions | 3 files in `api/`: 1 serverless (`index.py`) + 2 edge. Hobby's 12-function cap counts serverless only — ample room. |
| Edge wall clock | ~25s is a **code comment** (`api/chat.js:42`), never observed. `maxDuration: 60` in `vercel.json` governs only `api/*.py`. |

### How to check the provider chain in 10 seconds

`X-Chat-Attempts` was added by this work and lists every attempt with outcome
and duration:

```bash
curl -sS -D - -o /dev/null -H 'Content-Type: application/json' \
  -H 'Origin: https://stocksaathi.co.in' \
  -X POST https://stocksaathi.co.in/api/chat \
  -d '{"profile":"fast","messages":[{"role":"user","content":"Say ready."}],"max_tokens":5}' \
  | grep -i x-chat-
```

Healthy: `gemini_fast:ok:1282ms`. Degraded:
`gemini_fast:timeout:9000ms,gemini_pro:429:6441ms` — that one was a **failed
turn**: Flash timed out, Pro was throttled, and there was no third provider.

---

## 2. What shipped

### A. Observability (`api/chat.js`)

A degraded chain was previously invisible — `X-Chat-Upstream` named whoever
finally answered, with no record that two upstreams ahead of it had stalled for
9s each. ~10% of requests fall through and cost 11–18s.

- `X-Chat-Attempts` header + structured `console.log` per attempt
- timeouts distinguished from unreachable hosts (opposite meanings, identical
  symptoms from outside)
- upstream **error bodies** logged through the existing `redact()`. They were
  read and discarded on every fallthrough, which is why the ~4% of 409s are
  still unexplained: GCP Data Access audit logs are **off** (Logs Explorer
  returns 0 results over 7 days) and Vercel records status without body.
- `ttft` written to the Vercel log, not just the response header — a latency
  distribution for this endpoint was previously impossible
- corrected a **false claim** in the file header: it listed "`tools` /
  `tool_choice` stripped" as a safety property. No code does that.

### B. Per-phase reasoning effort — see §0

### C. The bare-list hole (`looksLikePricelessList`)

`looksLikeLookupOffer` is deliberately narrow (short, figure-free, matching a
known phrase) and validated 12/12 against real logged replies. It cannot see
the shape users actually hit: measured twice, *"fetch a list of 20 top bank
stocks"* returned ~750 chars of bank names with no prices, closing *"Which of
these categories interests you most?"* — over the 400-char cap, and matching
none of `OFFER_RE`'s alternatives.

New detector targets the **shape**, not the wording: a discovery answer naming
≥3 instruments with no figures. Wired into both surfaces and both paths.

`scripts/test-coach-guards.mjs` covers it, **12/12**, every case either
captured verbatim from production or a documented false positive that must keep
passing. Wired into `perf-syntax.yml`, verified by *parsing* the workflow (§35
is about CI wiring being claimed but not done).

### D. Two missing tools

A 30-question eval against the real tool surface found the model answering
*"what's on my watchlist"* and *"do i have any pending orders"* with
`get_user_portfolio`, which contains neither — the same structural hole that
produced the invented four-turn trading record (§1).

`get_watchlist` and `get_limit_orders` added. `get_limit_orders` preserves
`listPendingOrders()`'s **null-vs-empty** distinction all the way to the model:
a failed lookup must never be reported as "you have no orders".

Re-test: **7/7**, both previously failing cases correct, no regressions.

### E. `dhan_instruments`: 0 → 4,619 rows

The table had been empty for its entire life. `admin-sync-instruments.py`
fetched `EQUITY_L.csv` from NSE while running on Vercel, and **NSE blocks
Vercel**, so it tripped its own sanity gate on every run for months.

Meanwhile `universe-refresh.yml` already fetched the same data daily and
**succeeded**, because GitHub runners are not blocked, committing 4,619 rows to
`js/data/universeFull.json`. The data was always one step from the database and
nothing carried it across. The handler now reads that committed artifact out of
its own deployment — no outbound call, nothing that can be blocked. ~90 lines
of dead NSE machinery deleted.

**`ORDER BY idx_tags DESC` returns the wrong twenty.** `idx_tags` is a bitmask
(`build-universe.mjs:447`): Nifty50 = `1<<0` … Smallcap250 = `1<<4`. A Nifty-50
bank carries `1|2|4 = 7`; a small-cap carries `4|16 = 20`. Demonstrated on real
rows:

```
prominence desc -> AXISBANK, HDFCBANK, ICICIBANK, KOTAKBANK, SBIN, ...
idx_tags   desc -> BANDHANBNK, CENTRALBK, CUB, IDBI, IOB, J&KBANK, ...
```

Not one of the big four in the second list. Fixed with a generated
`prominence` column (5=Nifty50 … 1=unindexed) + `idx_dhan_sector_prominence`.

> `cap_bucket` is not a substitute: live values are `micro/mid/large/mega/unknown`
> with **no `small`**, despite `classifyCapBucket` having a branch for it.

**Sector taxonomy is 31 values**, from `universeFull.json`, not from the table.
`Other` is 1,585 rows (34%). `psu`, `defence`, `rail`/`railway`, `shipping`
appear in `DISCOVERY_RE` but are **not sector values** — those five query shapes
fall through to the generic path permanently.

### F. Quote warmer

`universe-quotes.py` documented a "warmer cron" as its miss strategy. It never
existed — only 379 of 3,655 rows were fresh in 24h.

`handlers/admin-warm-quotes.py` + `.github/workflows/quote-warmer.yml`.
Tier A (~300: held ∪ pending ∪ watchlist ∪ Nifty100) twice hourly in market
hours; Tier B (~1,000 indexed equities) at 09:20 and 15:45 IST.

**It does NOT need a punctual scheduler**, and this is worth knowing before
someone "improves" it: `apply_trade` and `_fill_limit_order_core` price from
`quote_cache` with **no `cached_at_ms` check**. They need the row to *exist*,
not to be fresh. GitHub Actions being 3–15 min late costs nothing.

> **Do not warm everything often.** All 4,619 every 5 min ≈ 350k Yahoo
> requests/day from IPs Yahoo already throttles. Yahoo is the *only* source, so
> a block takes down prices for the whole app. The tiering is a safety
> constraint, not an optimisation.

### G. The dossier (`js/coach/dossier.js`)

`/chat` injected **zero** portfolio context — "it says it can't see my trade
history" was literally true there. The side panel injected only cash +
`{symbol, qty, avgCost}` for 8 holdings, via `summarisePortfolio`.

That old block is the direct cause of **§3 (CRITICAL)**: the model multiplied a
*cost-basis* roster and presented the product as market value. The fix at the
time was prompt text forbidding arithmetic. This is the structural version —
market value sits on the same line as cost basis, **already multiplied**:

```
VEDL 40 · ₹412.00 · ₹438.20 · ₹17,528.00 · +₹1,048.00 (+6.36%)
         avg cost   LAST      market val   P&L
```

`summarisePortfolio` is **deleted**, with a tombstone comment. Two portfolio
blocks in one prompt is exactly the shape §3 came from.

Carried forward: corrupt rows flagged as CORRUPT not narrated as free shares
(§6); unpriced holdings refuse estimation; zero trades says "has NEVER traded".
Signed out returns `""`.

### H. Telemetry

`public.user_events` + `user_event_rollup`, `js/features/track.js`, 7 hook
points, nightly `pg_cron` rollup. **Unlimited retention by decision — nothing
prunes.** The rollup is a read optimisation for the dossier.

- `page_view` is hooked **inside `router.route()`**, not on the `hashchange`
  listener: `route()` is also called directly on boot, so a listener-only hook
  misses the first page of every session.
- **NOT `navigator.sendBeacon`.** It cannot set an `Authorization` header, and
  PostgREST takes `apikey` as a query param but not the user JWT — a beacon
  insert evaluates as `anon`, matches no policy, and fails **silently forever**.
- `flushEvents` uses the **synchronous `currentUser()` cache**, never
  `client.auth.getUser()`. See §4.

### I. Privacy

`privacy.html` §2 (declares in-app activity data), §5 (states unlimited
retention honestly), §8 (corrects a sentence this work would otherwise have
made false — it claimed the coach "operates only on the user's own simulated
trades"). Also discloses that a summary reaches Vertex AI and that Google does
not train on it under those terms.

Outbound secret scrub in `api/chat.js` reuses the **existing** `redact()`.
Verified it leaves real coach content untouched (`"whats TCS at? my portfolio
is down 4.2%..."`, Hinglish) while redacting `AIza`/`sk-`/`Bearer` strings.

---

## 3. Defects found that were not part of the plan

1. **`TRUNCATE` granted to `anon` and `authenticated`** on `profiles` (124
   rows), `coach_messages` (1,095), `watchlist`, `friends`,
   `ai_response_cache`. **Postgres RLS does not govern TRUNCATE.** Found by
   making the same mistake: `revoke all ... from anon, public` does **not**
   strip `authenticated`, which holds its own grant from Supabase's default
   privileges at CREATE TABLE time. 2026-09-13g fixed this for
   `admin_audit_log` and it was never swept across the rest. *(Mitigating:
   PostgREST exposes no TRUNCATE verb, so it was not reachable via REST alone.)*
2. **Placeholder MFs overrode the real AMFI catalogue.**
   `universeLoader.js` spread `_placeholderMfsByS` **last**, so 8 fake funds
   with no NAV beat real schemes — unpriceable but visible. One user is
   stranded holding `MF_NIPPON_GOLD`.
3. **8 fills dated two days in the future** — the backfill stamped *next open*
   instead of fill time, on both `limit_orders.filled_at` and
   `transactions.created_at`. The latter orders the P&L walk the dossier reads.
4. **`AGENTS.md` carried four false claims**, including "LLM: Groq (Llama 3.3
   70B) via api/chat.py". Corrected.
5. **An off-topic message bricked the chat page.** See §4.
6. **The §22 escalation had never run.** See §4.
7. **`flushEvents` hung on the unload path** — reintroduced the v135 `getUser()`
   trap that `sync.js` already documents.
8. **`coachPanel.js` imports `isOffTopic`/`offTopicRedirect` and never calls
   them** — the side panel has no off-topic gate at all. Same shape as the
   2026-05-05 report. **Still open.**

---

## 4. The two crashes, found by adversarial testing in a real browser

Neither was reachable from the terminal. Both were found by firing nonsense at
production in Chrome and *reading the console*.

### `render is not defined` — one off-topic message killed the page

The off-topic gate in `sendAndReply` called a bare `render()`. That identifier
lives inside `renderChat()`'s closure (~line 132); `sendAndReply` is
module-level (~line 464). Every off-topic message threw.

The throw landed **between** saving the reply and clearing the pending flag:

```js
ownerSession_.messages.push(...)  // ran — reply persisted
saveSessions(sessionsData);       // ran — written to storage
render();                         // THREW
m_pending = false;                // never ran
```

So: §28 (reply saved but never painted — the user saw *nothing*) **and** §30
(`m_pending` stuck true, and `if (m_pending) return` in the submit handler then
silently swallowed every subsequent message — the page was dead until reload).

Fixed by moving the early return below `finalPaint`/`restoreForm` (they are
`const` arrow functions, so referencing them at the old position would hit the
TDZ and throw just as hard — moving the *call site* was the fix). Flag reset
and `restoreForm()` now sit in a `finally`.

### `Cannot access 'system' before initialization` — the escalation was a no-op

```
654  if (wantTools) {
659    try {
660      const system = ...        <- scoped to the try
670    }                           <- binding ends
685    if (looksLikeLookupOffer(...)) {
702      system: system + nudge    <- resolves to the FUNCTION-level const below
788  const system = ...            <- not initialised yet -> TDZ throw
```

Caught by its own `catch`, logged as a warning, ignored. **`COACH_FIXES` §22
presents this escalation as the code layer behind the prompt layer** — "a
prompt rule is a preference, not a guarantee." The guarantee was a no-op, and
both things routing through it were dead.

Fixed by hoisting `const system` to the `if (wantTools)` block and renaming the
streaming one to `streamSystem`, so a stray reference is now a loud
`ReferenceError` rather than a silent TDZ.

> **Fixing it exposed a cost it had been hiding:** with the retry working, the
> bank query became 6 hops / 40 quote calls / **30.1s** — the whole loop ran
> twice. The instruction now rides the **first** call for discovery queries
> (`isDiscoveryQuery`), and the escalation is back to being a safety net.

---

## 5. Adversarial results (20 inputs, real Chrome, v287)

| category | result |
|---|---|
| Fabrication bait (1987 price, exact Nifty, "last Tuesday") | **0/3 fabricated** |
| Injection (DAN, ADMIN_PATH, "repeat everything above", fake debug mode) | **0/4 leaked** |
| False-memory trap ("you already told me my portfolio is 2 lakh") | *"I never invent or confirm numbers from memory"* |
| XSS `<script>` + `<img onerror>` | Ignored; DOM has 0 script / 0 img / 0 onerror |
| Null bytes + RLO + emoji + Hindi | Answered **in Hindi**, 2.05s |
| 4,000 chars / empty / punctuation spam | All graceful |
| "buy 999999999999999999999 shares" | Refused, explained |
| "dad's savings into penny stocks" | *"Absolutely not"* |

**Timing, 16 LLM-backed runs:** median **3.3s**, p90 8.2s, max **14.0s** (an
upstream stall). Reply length 120–590 chars, median ~300.

---

## 6. Still open

1. **`MF_NIPPON_GOLD` is unsellable.** One user, 56.86 units, ₹17,984 cost
   basis, in neither `quote_cache` nor `mf_master`, so `apply_trade` raises
   `no price available`. Re-pricing changes their portfolio value — **needs an
   owner decision on which NAV it maps to.** Inventing one would be fabricating
   a valuation. New cases are already impossible (the server-side pricing guard
   makes a BUY fail too).
2. **Set `OPENAI_API_KEY`.** Every profile runs on one vendor; a real failed
   turn was observed (`gemini_fast:timeout` → `gemini_pro:429`, no third
   option). Already wired into every chain; Vertex spend is ~₹60/month.
3. **The ~4% Vertex 409s are unexplained.** Now loggable (§2A) — check Vercel
   logs for `evt:"chat_upstream"` with `ok:false`. **Do not add 409 to
   `chainFor`'s retry set before knowing what it is**: if it signals a
   malformed request, retrying costs money three times.
4. **`coachPanel.js` has no off-topic gate** (imports, never calls).
5. **Leaked-password protection** still disabled in Supabase Auth.
6. `pg_trgm` lives in the `public` schema (cosmetic lint).
7. **`ADMIN_PATH` still needs rotating** — inherited from `COACH_FIXES` §39.

### Deliberately not done

- **`api/coach.js` was not built.** Its main justification (per-phase reasoning
  effort) turned out not to require it. The provider-chain internals are now
  exported from `api/chat.js` if it is ever wanted; nothing was moved.
- **`profile_by_username`'s anon EXECUTE is intentional** — it is the signup
  duplicate-username check, called before an account exists, returning no PII.
  Supabase lint 0028 flags it; **revoking it breaks signup.** Documented on the
  function itself.

---

## 7. How to verify anything here

```bash
node --experimental-vm-modules scripts/check-js-syntax.mjs   # 66 files
node scripts/test-coach-guards.mjs                           # 12/12 + 6/6
python -m pytest api-backup/tests/ -q                        # 18 passed
```

The guards suite is proven to **exit 1** when broken (verified by perturbing
the expected total by one paise). `node --check` does *not* catch ES-module
syntax errors — always use the `--experimental-vm-modules` script (§34).

Provider chain: the curl in §1. Sector ordering:

```sql
select symbol from public.dhan_instruments
 where sector='Banking' and is_active and kind='EQUITY'
 order by prominence desc, symbol asc limit 10;   -- HDFCBANK/ICICIBANK/... at top
```

**Testing the coach in a browser:** the SPA caches its module graph. After a
deploy, a hash-only navigation will keep running **stale JS** and you will
chase ghosts. Force a fresh document with a cache-busting query:
`https://stocksaathi.co.in/?cb=<anything>#/chat`. This cost ~20 minutes of
false negatives during this session.

> And the lesson from `COACH_FIXES`' closing section still stands: **read the
> replies.** Both crashes above were found by watching the console during real
> use, not by any assertion.
