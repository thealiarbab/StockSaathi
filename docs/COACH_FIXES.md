# Saathi (the AI coach) — master bugfix record

**Date:** 2026-09-13 · **Deployed:** v270 → v279 · **Scope:** the coach only

**46 defects** across the system prompt, the tool layer, the routing heuristic,
the two chat surfaces, the model proxy, the local cache, and the database.

Almost none of these were found by testing. They were found by **reading the
1,069 logged `coach_messages` rows in Supabase** — real conversations with real
13–18 year old users — and by chatting against production on a live QA account.
The regex probe suites were repeatedly green while the replies underneath were
wrong; three separate rounds only fell to someone reading the actual answers.

The severity frame throughout: these users **cannot evaluate the coach's
answers.** A confident fabricated number is indistinguishable from a real one.
That makes hallucination, not downtime, the worst failure mode in this file.

---

## A. Fabrication — the coach inventing user data

The single largest category, and the reason most of the rest exists.

### 1. Invented an entire trading record and held it for four turns · CRITICAL
`c4ee626`

`haldenbeet`, 2026-04-22, asked *"Can u show me all the trades i have made?"*.
The coach had only `get_user_portfolio` — holdings, **no transactions** — so it
made one up and defended it across four consecutive turns:

> "You're at Rs 1,04,230 total… 4 positions, biggest is RELIANCE at Rs 28k…
> best performer this week is INFY (+6.8%)" → "your best trade is Reliance, up
> 18.5%" → "You haven't panic sold any stocks."

The next day it pulled the real portfolio: **Rs 1,00,201.90, two holdings —
Vedanta and a gold fund.** No Reliance. No Infosys. Three other users asked the
same question.

**Where the numbers came from:** the placeholder portfolio in the prompt's own
tone examples (see §3). The model had no data, so it recited its examples.

**Fix:** added `get_trade_history` — real transactions newest-first, realised
P&L per closing SELL (walked oldest-first over a running average cost), and the
behavioural flags recorded at trade time. Returns an explicit *"never traded —
say exactly that, do not invent one"* note when empty.

> Telling a model not to lie was only ever half a fix. Giving it the data is the
> other half.

### 2. Tone examples carried real-looking figures · CRITICAL
`8357ad9`

The system prompt's tone examples used concrete numbers — `1,04,230`, `4.23%`,
`42,100`, `RELIANCE 28k`. With no tool result to hand, the model recited them as
a user's actual portfolio. This is the direct source of §1.

**Fix:** replaced with `<angle bracket>` placeholders + an explicit
never-invent-the-user's-data section.

### 3. Arithmetic on cost basis presented as market value · CRITICAL
`5f9cf3a`

Asked *"what's my total portfolio value?"*:

> "Your total portfolio is worth Rs 38,100.00. You started with Rs 42,100.00 in
> cash, so you're currently down Rs 4,000.00."

Every number invented. It read the RUNTIME CONTEXT roster — which lists
**quantity @ AVERAGE BUY PRICE** — and multiplied it as though it were market
value. Same class as the Rs 1,04,230 a real user got on 2026-09-12.

**Fix:** the roster now labels itself as cost basis *inside the block*, and the
prompt forbids multiplying/totalling/subtracting from it. Plus a blanket rule:
**do not do arithmetic on numbers you were not given.**

### 4. Invented live prices once the refusal was removed · CRITICAL
`ed06c10`

Fixing the closed-market over-refusal (§17) immediately created something worse:

> Q: what's TCS trading at? → "TCS is trading at Rs 3700.00, down 0.5% today.
> Its P/E is around 28."
> Q: bitcoin price → "Bitcoin is at Rs 55,82,475.43 (about $67,000.00), up 1.15%…"

All fabricated. A made-up price is strictly worse than a refusal.

**Fix:** the note now states two constraints *separately* and demands both at
once — (1) you have no prices on this path, never state one, inventing is the
worst outcome; (2) the market being closed is **not** the reason. Correct
behaviour is to offer to fetch.

### 5. Declared the market open on a Saturday, with a Nifty level
`8357ad9`

Answered market-hours questions from training memory — declaring the market open
on a Saturday with a fabricated index level, **two minutes after agreeing it was
shut.**

**Fix:** real IST date + session status injected per turn via `runtimeFacts()`,
plus an explicit "you have no index tool" rule.

### 6. Corrupt portfolio rows explained away as a feature
`8357ad9`

Rows with quantity in the billions and zero average cost were narrated to users
as free shares. `get_user_portfolio` now **flags** them as corrupt instead.

---

## B. Denying things that exist / asserting things that don't

### 7. Told users to contact a broker that does not exist · CRITICAL
`f2f75ad`

`random_musk` (2026-08-12) and `anish.yadav` (2026-09-03..05) each spent
multiple sessions asking why a queued order never executed:

> "This usually points to an issue on your broker's side… Your best bet is to
> contact your broker's customer support directly."
> "As StockSaathi, I don't actually execute trades or place orders… you're
> likely doing that through a separate trading platform or your stockbroker's
> app."

**There is no broker. StockSaathi places the order itself.** `anish.yadav` is 11
and went four turns deep hunting an "Orders" section the coach had invented,
then gave up.

### 8. Invented an "Orders" section of the app
`8357ad9`

Users looped for four turns looking for it. **Fix:** a factual app-navigation
block — cancel lives in the Portfolio page's queued-orders card.

### 9. Told users mutual funds aren't supported
`c4ee626`

`saim` asked *"can i start mutual fund in stocksaathi"* → told no. The app
carries the **full AMFI catalogue** — thousands of schemes, real NAVs, buyable
like a stock — and users had already placed MF orders.

### 10. Told 13–18 year olds to open a Demat account
`c4ee626`

`faizsherwani` asked how to get started "here on this site" and was told to open
a Demat and trading account with a stockbroker. It is a **virtual simulator**;
they cannot and need not. The prompt now states no Demat/broker/KYC/PAN/real
money is required, and that the answer is Markets → search → tap → Buy.

### 11. Claimed to have operated the app
`c4ee626`

`haldenbeet` said *"Close the chat please"* → "Closing chat." The coach has no
ability to operate the app at all. It now says so and points at the control.

### 12. Shipped a false reassurance about queued orders
`f2f75ad`

The app-facts text added in the prior commit claimed a queued order *"fills at
the next open — it is NOT stuck or rejected."* Untrue at the time: the matcher
was client-driven, so orders only filled while the user had the app open.

### 13. …then taught the bug for an hour after it was fixed
`5f9cf3a`

Once the server-side matcher landed, the prompt still said
*"aapko app open rakhna hoga taaki aapka order execute ho sake."* **Fix:**
matching runs server-side every minute; the only two honest reasons an order is
unfilled are "market hasn't opened" or "price hasn't reached your limit". And:
if a user reports it stuck for days, say it sounds like our bug and to report it
— **never explain it away.**

---

## C. The tool layer

### 14. The streaming path had no tools but was told it did · CRITICAL
`876333c`

A live adversarial probe against production (24 cases) found one hard failure —
*"show me banking stocks"* returned, in full:

```
CALL search_stocks("Banking")
```

**Root cause:** `/api/chat` silently disables streaming whenever `tools` is
present, so the streaming path has **no tool channel**. Both surfaces sent the
tool-use prompt anyway, and the side panel's `SAATHI_SYSTEM` went further —
*"You have tools for live data… USE them whenever."* The model believed it,
tried, and typed the call out as prose. Same string a real user got 2026-08-20.

**Fix:** `NO_TOOLS_NOTE` on the streaming path; `coachPanel` streams with
`SAATHI_NO_TOOLS`; `streamChat` returns `raw` alongside stripped text so callers
can distinguish "said nothing" from "emitted only a tool call"; and
`isToolCallOnly` now **re-runs the turn through `runAgent`**, which has real
tools, instead of falling back to "Hmm, I went quiet there".

### 15. `search_stocks` searched ~110 symbols, not the universe
`876333c`

It searched `[...STOCKS, ...MUTUAL_FUNDS]` — the ~100 curated `FEATURED_SYMBOLS`
plus 10 placeholder funds — so *"show me banking stocks"* missed almost every
bank on the exchange. Now searches `getAllInstruments()`: ~2,200 NSE + ~14,000
AMFI.

### 16. `NAME_TO_SYMBOL` never contained a single company name
`8357ad9`

An IIFE snapshotting `STOCKS` at module load. `STOCKS` is an `export let`
holding **boot stubs whose name IS the symbol**, so the map was structurally
empty of real names for its entire life. Now built lazily from
`getAllInstruments()` and invalidated on `universe-loaded`.

### 17. Routing heuristic missed 72% of data questions · CRITICAL
`8357ad9`

`needsLiveData` missed **21 of 29** sampled messages that genuinely needed a
tool. Because the streaming path carries no tools, a miss meant the coach either
denied having data it has (*"I can't access your specific financial details"*)
or fabricated it.

**Fix:** rewritten with self-data, market-status, discovery and **Hinglish**
patterns, universe-backed instrument matching, and previous-turn inheritance for
short follow-ups. **0 misses and 0 false positives** against the logged corpus.

### 18. Side panel still advertised the old five tools
`aa39593` — `get_trade_history` was missing from its list.

---

## D. Tool-call scaffolding leaking to users

### 19. The stripper required both parens and a full-line anchor
`8357ad9`

So every real leak got through: `CALL get_market_news`, `CALL get_user_portfolio`,
`…for you. CALL search_stocks("Banking")`. Parens are now optional, inline forms
handled, and Gemini's reasoning preamble (*"The user is asking… I need to…"*)
stripped too. `chat.js` now delegates to the shared stripper instead of keeping a
weaker private copy, and both streaming surfaces reconcile to the cleaned text at
end-of-stream rather than persisting whatever was painted.

### 20. Mid-line leak fused into the next word
`c4ee626`

`naazakhtar` asked about Orient Electric and got, literally:

```
CALL get_stockic is trading at Rs 219.60
```

The model emitted `CALL get_stock` and ran into the tail of "Electric". Neither
the own-line nor end-of-line pattern catches prose on **both** sides.

**Fix:** a mid-line strip anchored on **real tool names only**, ordered after the
bracketed rules so `(call get_user_portfolio)` is removed whole rather than
hollowed into `()`. Verified *"call me old-fashioned"* survives.

---

## E. Wasting the user's turn

### 21. Asked permission instead of just looking things up
`aa39593`

`destroyer04`'s transcript is full of it — and it happened on the **tool path**,
so this was never a routing problem:

| user | coach |
|---|---|
| "Tell me new stocks to invest" | "Let me know what you're looking for, and I can help you search." |
| "show mw bigest movers of market" | "Let me know, and I can pull up some data for you." |
| "Banks" | five bank *names*, no prices, then "Would you like to know the current price for any of these?" |
| "All" | "Sorry, I can't show you the prices for *all* bank stocks at once." |

### 22. …and that last refusal was simply false
`aa39593` — `runAgent` executes tool calls **in parallel**; five prices is one turn.

**Fix, in two layers** — because a prompt rule is a preference, not a guarantee:

1. **Prompt:** a hard NEVER-ASK-PERMISSION section. *The question IS the
   permission.* Sector → search AND fetch prices in one reply. "All" → fetch them
   all. Discovery → pick a sensible default, name it in a few words, deliver.
2. **Code:** `looksLikeLookupOffer()` + automatic escalation on **both surfaces
   and both paths**. A short, figure-free offer silently re-runs through
   `runAgent` with *"you already offered, the user already asked, call the tools
   now"*, and the reply is replaced. The user never sees the ask.

   The detector is deliberately narrow: any reply containing a rupee figure or a
   percentage is an answer; anything over 400 chars is an explanation that
   happens to end with an offer. **12/12** on a unit suite drawn from real logged
   replies, zero false positives — including *"I can't cancel orders for you
   directly, but you can do it yourself…"*, which is a correct refusal.

### 23. Treated a closed market as "no data"
`5f9cf3a`

*"what's TCS trading at?"* on a Sunday → *"I can't pull live prices right now
because the market is closed… Want me to pull the price then?"* Prices, searches
and news all exist when the NSE is shut — they return the last close. My own
`runtimeFacts` block caused this by over-weighting "CLOSED".

**Fix:** a closed market blocks exactly **one** thing — an order filling this
second.

### 24. Then went robotic and deferred answerable questions
`ed06c10`

Round 4 turned every answer into the literal example sentence *"I'll need to pull
that up - want me to?"* — including for *"mera order abhi tak execute nahi hua,
kyu?"*, an **app** question answerable from APP FACTS.

**Fix:** phrase the offer in the user's own language and varied; and an explicit
list of what must be answered outright — app behaviour, concepts, anything
already in context. Deferring one of those is its own failure.

**Round 5: 14/14 both directions** — 0 fabrications across 4 lookup probes,
0 wrongful deferrals across 10 answerable ones, correct Hindi, correct app facts,
roster quoted as cost basis.

> **Known residue:** on the fallback path the coach still sometimes phrases the
> offer as "when the market opens Monday". Harmless — in production these route
> to the tool path via `needsLiveData` and get a real last close. Not worth
> another prompt edit; the see-saw risk is fabrication.

---

## F. The prompt itself

### 25. Half the system prompt was mojibake · CRITICAL
`8357ad9`

`persona.js` lines 71–111 were **double-encoded** (UTF-8 read as cp1252). The
entire CONTEXTUAL SHORT REPLIES / DECISIONS / TONE EXAMPLES / HARD RULES half of
the system prompt was garbage bytes, and the model was being **taught to write
`â‚¹` and `â€”`**. Four replies shipped that to users. Rewritten as clean UTF-8.

*(Also fixed two user-visible mojibake strings outside the coach, one of them
Saathi's own search-timeout message.)*

### 26. Equity P/E copy applied to funds
`8357ad9`

`STOCK_INTRO`: *"ANGEL ONE GOLD ETF is a Commodity company. P/E is —, … ₹— for
every ₹1 of annual earnings."* **54 logged rows.** Now branches on `kind`, and an
equity with no P/E drops the sentence rather than rendering an em-dash where a
number goes.

### 27. A state migration that had always been a no-op
`8357ad9` — the purge read `payload.body`; the field is `payload.reflection`.

---

## G. The UI and the two surfaces

### 28. Reply saved but never painted · CRITICAL
`aca796b`

Found by chatting on a real logged-in QA account against production. The coach
refused an injection probe correctly — and the user saw **nothing**. No bubble,
no error, no typing dots. The reply was in localStorage the whole time; it
appeared only after navigating away and back. Indistinguishable from "the coach
is broken", and a plausible source of the "coach doesn't reply" reports.

**Cause:** `reRenderOuter()` is gated on `isOwnerActive()`, comparing the
`ownerSessionId` captured at send time against `sessionsData.activeId`. But
`sessionsData` is a **module-level binding that two async listeners reassign
wholesale** — the cross-tab `storage` handler, and the `ss:coach-sync` handler
that fires when `sync.js` hydrates history from Supabase. Either landing mid-turn
makes the comparison run against a freshly-loaded object, return false, and skip
the paint silently.

**Fix:** `finalPaint()`, called once at the end of **both** paths. It reads the
*current* active session rather than the array captured at send time, and no-ops
if the user has since switched sessions. `reRenderOuter()` stays — it still
drives live streaming repaints; this only guarantees the final state.

### 29. Replies truncated mid-word
`4605227`

`max_tokens` was **512, shared with the model's internal reasoning.**

Why only *some* replies were cut is the interesting part: the two profiles use
different models. `chat` → `gemini-2.5-flash-lite`, which does **not** think, so
all 512 went to visible text and long conceptual answers were fine. `fast` →
`gemini-2.5-flash`, which **does** think, and reasoning came out of the same 512.
That is why portfolio and trade questions (routed through tools on `fast`) kept
stopping mid-word while essays did not.

`trimToSentence()` stays as a net for any cap imposed upstream — a reply that
hits a ceiling is cut back to its last complete sentence. *Ending early reads as
brevity; ending mid-word reads as broken.*

### 30. Composer stuck on "responding", Stop button inert
`4605227` — a self-inflicted regression from v273.

The lookup-offer escalation (§22) awaited `runAgent` **between** `m_pending =
false` and `restoreForm()`, so for up to five network round trips the composer
showed a disabled input and a Stop button that could no longer abort anything —
`m_abortController` was already null.

**Fix:** every retry bounded by `withDeadline()` at 12s; the whole completion
block in `try/finally` so the composer re-enables no matter what throws; and
`restoreForm()` re-reads its nodes from the DOM instead of trusting refs captured
before a re-render.

### 31. Markdown lists rendered as literal asterisks
`4605227`

The coach writes real markdown when comparing several instruments — `*   HDFC
Bank` — and `renderMarkdown` had no list handling. A five-bank comparison **is**
better as a list, so render it rather than fight it.

### 32. The composer itself
`4605227` — *"input and stop button are shit"*. Input and action now sit in one
pill that lifts on focus with a brand halo; one circular control (arrow to send,
square to stop, breathing ring so "in progress" reads at a glance); live typing
dots while streaming instead of a dead input with grey placeholder. Same tokens,
same radius scale, same green — no new palette. **Both surfaces share the
markup**, so the panel and the page finally match. 16px input on mobile to stop
iOS zoom-on-focus, larger tap target, safe-area padding, `prefers-reduced-motion`
honoured.

### 33. A syntax error in `chat.js` took the entire site down · CRITICAL
`4fc4661`

v273 shipped a double-quoted JS string split across two lines. A module that
fails to parse never runs — and because `app.js` imports the router which imports
`chat.js`, **the whole app died.** The homepage rendered with no nav at all.
Reported from production.

**Fix:** template literal (may legally span lines).

### 34. `node --check` does not reliably parse ES modules
`4fc4661` — the root cause of *how* §33 shipped. It checked the file as a
**script**, reported it fine, and I believed it. Added
`scripts/check-js-syntax.mjs`, compiling every file under `js/` (plus `sw.js`)
with `vm.SourceTextModule` — parse only, never evaluate, so module-scope timers
and network calls cannot hang it. Verified it catches exactly the construct that
got through while `node --check` still calls that file fine.

### 35. …and the CI wiring was claimed but not done
`1f9d065` — the previous commit message said the check was wired into the parity
job. **It was not.** The script existed and nothing ran it. Corrected rather than
leaving a false claim in the history.

---

## H. Privacy

### 36. Signed-out browsers showed the last user's coach chats · CRITICAL
`d6978d2`

The coach caches — `ss.chat.sessions.v1` and `ss.coachchat.v1` — are plain
localStorage keys with **no user scoping**, and logout only ever removed
`ss.sb.session.v1`. `/chat` is a **public route**, so a signed-out browser kept
rendering the previous person's entire conversation: their portfolio figures,
what they were anxious about, every question they asked. On a shared family
laptop or a school computer that is a direct privacy leak — and these users are
13–18.

### 37. Second path to the same leak
`d6978d2` — `rebuildChatSessionsFromDb()` returned early when the incoming user
had no chat rows, leaving the **previous account's cache untouched**. Signing in
as someone who had never chatted showed them the last person's history.

> **Blast radius, stated plainly:** RLS on `coach_messages` is correct
> (`auth.uid() = user_id`) and **nothing leaked server-side.** This was purely
> the local cache outliving its owner.

**Fix:** `clearChatCaches()` + `enforceChatCacheOwner(userId)` in `sync.js` with
an `ss.chat.owner.v1` marker; `logoutAccount()` clears them with a
direct-removal fallback so a failed import can never block logout;
`rebuildChatSessionsFromDb()` takes the user id and enforces ownership **before**
its early return, stamping the owner when it writes a fresh cache; and `app.js`
enforces on boot for the cases logout never sees — a session that expired on its
own, a cache written before this fix, and account switches on a shared device.

---

## I. Chat storage

### 38. Two chat write paths had silently diverged for five months
`0b4a403`

`coach_chats` was the v138 per-user blob table. v142 made `coach_messages`
authoritative (`js/db/sync.js:355`) but its rows were **never migrated** and sat
orphaned. One of those users had **no chat rows in `coach_messages` at all** —
his conversation existed only in the dead table, which is why it could not simply
be dropped.

Migrated **28 messages across 4 sessions**, verified none already existed
(matched on `user_id` + `event_type` + `created_at` within 2s). The other user
already had 86 rows in `coach_messages` and none were these — so the two paths
had diverged rather than one mirroring the other. **Chat history grew; nothing
was lost.**

### 39. A secret was sitting in the chat log
`0b4a403`

A pasted `ADMIN_PATH` value, redacted during the migration rather than carried
across; dropping the source table removed the last stored copy. Scanned all
**430** chat rows for other secret-shaped strings (JWTs, `sk-*`, `AIza*`, long
opaque tokens) — **none**.

> ⚠️ **The value still needs rotating.** It reached an LLM provider when the
> message was first answered. This only clears our own storage.

---

## J. The model proxy (`api/chat.js`)

### 40. The coach's conversation ran on the weakest model in the fleet
`c8ab192`

Probed what each profile actually served in production:

| profile | model | |
|---|---|---|
| `chat` | `gemini-2.5-flash-lite` | ← **the coach's conversation** |
| `fast` | `gemini-3-flash-preview` | |
| `reasoning` | `gemini-3.1-pro-preview` | |
| `json` | `gemini-2.5-flash-lite` | |

`GEMINI_FAST_MODEL` and `GEMINI_PRO_MODEL` were set in Vercel, so those lanes
already ran Gemini 3. `GEMINI_CHAT_MODEL` was **not** set, so the in-code default
was live — the conversational path ran on the least capable model in the fleet
while the tool path immediately beside it was served by Gemini 3 Flash.

Flash Lite was chosen for a real reason (fastest, no internal thinking,
sub-second first token). Wrong trade for this surface: the coach **is** the
product, and a non-thinking model is precisely the kind that states a confident
wrong thing — which is most of this document.

> `json` **deliberately** stays on Flash Lite, and the comment now says so
> loudly. It is the one lane where "smarter" is actively worse: Flash spends
> ~1,900 reasoning tokens on a strict-JSON request and blows the caller's
> `max_tokens` with a ~70-token payload, which broke crash replay.

### 41. …but 3.1 Pro cost a 6-second stare
`e85c77e` — corrected after measuring. Streaming TTFT against production, 2 runs each:

```
gemini-3.1-pro-preview   6.43s, 5.43s
gemini-3-flash-preview   1.94s, 2.81s
```

Pro reasons before emitting anything, so **streaming does not hide the wait**.
Shipping that right after fixing a "stuck on responding" bug would read as the
same bug returning. Flash 3 still answers the objection to Flash Lite — it is a
*thinking* model — and is already proven on the tool path. 3.1 Pro remains one
env var away: `GEMINI_CHAT_MODEL=gemini-3.1-pro-preview`.

### 42. Six seconds to first token on "hello how is u"
`70d8052`

ChatGPT answers the same thing in under 3. Measured against production with the
real 5,046-token system prompt:

```
default (full thinking)     3.85s, 6.48s
reasoning_effort "low"      1.22s, 1.32s
reasoning_effort "none"     0.15s, 0.33s
```

Shrinking that 5,046-token prompt to **21 tokens** bought only ~1s — the prompt
was never the problem. A thinking model emits **nothing** until it has finished
thinking, which is why streaming did not hide it.

### 43. The *actual* truncation bug — the proxy defaulted to 800
`70d8052` · CRITICAL

Removing the client-side cap in §29 **changed nothing**: omitting `max_tokens`
did not mean "no cap", it meant the proxy's own default of **800**. On a thinking
model most of that goes to reasoning before a single visible word exists:

```
"…which they release at the"
"That would be your mutual fund (MF_151908), which is currently flat"
```

An absent `max_tokens` now means the real ceiling — 2000 → 4000.

### 44. Thinking budget tuned off the conversational lane
`c9be679`

At `"low"` the chat lane still ran **2.0–5.6s** in real use and spiked to
**20.4s** once on upstream variance; headers confirmed no fallback, so that is
simply what the reasoning phase costs. The chat lane has no tools and no data to
reason over — greetings, concepts, explanations. The tool lane keeps `"low"`
because it genuinely must decide *which* tool to call.

> Not a quiet return to Flash Lite. The model is still Gemini 3 Flash — a much
> stronger base than 2.5 Flash Lite — it simply is not spending a turn thinking
> before saying hello.

### 45. `reasoning_effort: "none"` is invalid — **every chat request 400'd**
`882e612` · CRITICAL

```
Expected 'reasoning_effort' to be one of: 'high', 'low', 'max', 'medium',
'minimal'; found 'none'.
```

Switched to `"minimal"`, the smallest valid budget.

> **How it got through:** the 0.15s recorded for `"none"` in §44 was **the 400
> coming back fast, not a reply.** The probe timed first byte and never checked
> the body contained content. *A measurement that cannot tell success from
> failure is not a measurement.*

### 46. One slow provider 504'd the whole turn
`a636541`

*"whys monday holiday"* returned HTTP 504 `FUNCTION_INVOCATION_TIMEOUT` after
**25.2s** — no reply at all, for an ordinary question.

`callUpstream()` had **no timeout on its fetch**. Vercel kills an edge function
at ~25s, so the first slow provider consumed the entire budget and the three
healthy fallbacks behind it never got a turn. *The chain existed but could not be
reached.*

**Fix:** each attempt gets `UPSTREAM_TIMEOUT_MS` (9s, env-overridable) via
`AbortController` — room for two full attempts plus overhead inside the edge
limit. An abort throws, the existing catch continues to the next upstream. Only
time-to-**headers** is bounded; once a stream starts the body pipes through
unlimited, so long answers are unaffected.

---

## Commit index

| commit | |
|---|---|
| `0b4a403` | migrate `coach_chats` → `coach_messages`, drop dead objects |
| `8357ad9` | mojibake prompt, data-routing, tool-call leaks *(10 defects)* |
| `f2f75ad` | stop telling users to contact a broker that does not exist |
| `876333c` | stop the streaming path claiming tools it does not have |
| `5f9cf3a` | three flaws the regex probes passed but reading the replies caught |
| `ed06c10` | separate "don't blame the market" from "don't invent a number" |
| `aca796b` | reply saved but never painted on the /chat page |
| `cdf395b` | *(portfolio — out of scope)* |
| `6e5eaca` | *(notices — out of scope)* |
| `d6978d2` | signed-out browsers were still showing the last user's coach chats |
| `c4ee626` | give it real trade history; fix 4 more bugs from the chat logs |
| `aa39593` | stop asking permission to look things up — just look |
| `4fc4661` | repair syntax error that took the whole site down in v273 |
| `1f9d065` | actually wire the JS syntax check into the parity job |
| `4605227` | remove the output cap, fix the stuck composer, rebuild the UI |
| `c8ab192` | run the chat on the smartest model, not the fastest |
| `e85c77e` | use Gemini 3 Flash for chat, not 3.1 Pro — measured |
| `70d8052` | cut TTFT ~6s → ~1.2s, and fix truncation for real |
| `c9be679` | no thinking budget on the conversational lane |
| `882e612` | `reasoning_effort 'none'` is invalid — every chat request 400'd |
| `a636541` | bound each upstream attempt so one slow provider can't 504 the turn |

---

## What this run should change about how the coach is tested

1. **Regex probe suites are not enough.** Rounds 2 and 4 were 41/41 and green
   while the replies underneath contained fabricated portfolios and robotic
   deferrals. Someone has to read the answers.
2. **Timing probes must assert on the body.** §45 shipped because 0.15s was
   measured as a success when it was an HTTP 400.
3. **Prompt rules are preferences, not guarantees.** Every durable fix here has a
   code layer behind the prompt layer — §14, §21, §29.
4. **The production log is the bug tracker.** 1,069 rows produced most of this
   file. Nothing else found these.
5. **Fixing a hallucination often creates its mirror image.** §23 → §4 → §24 is a
   three-step see-saw: over-refusal → fabrication → robotic deferral. State both
   constraints at once and test both directions.

## Still open

- **Rotate `ADMIN_PATH`** (§39). It reached an LLM provider.
- The fallback-path "when the market opens Monday" phrasing (§24 residue).
- `json`-lane callers that set their own `max_tokens` are still exposed to the
  Flash-reasoning blowout described in §40 — unlike the coach, which sends no cap.
