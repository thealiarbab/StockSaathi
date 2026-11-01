# SEO + AI-discovery plan

Living reference for the search / AI-answer-engine work. Every public claim the
site makes must trace to a line in §2 ("Honest claims"). If a claim is not in
§2, it does not ship. This file is excluded from the deployment
(`.vercelignore` → `docs/`), so it is never served on stocksaathi.co.in.

Audit date: 2026-11-02 (first audit 2026-09-30). Numbers below were recounted
from the repo and the production database on 2026-11-02.

---

## 1. Feature inventory (verified in code)

### Routes (`js/router.js`)

| Path | Access | What it is |
|---|---|---|
| `/` | public | Landing page. Pre-rendered into `index.html`, so non-JS crawlers see it. |
| `/stocks` | public | Markets: browse 4,501 stocks + 370 ETFs + mutual funds, sector filters, plain-English search ("cheap IT stocks with low debt"). |
| `/stocks/<symbol>` | public (trading needs login) | Candle / area chart (1D, 1W, 1M, 3M, 6M, YTD, 1Y, 5Y, MAX, custom), fundamentals where available, a SIMULATED order book, buy / sell ticket. |
| `/crash-replay` | public | Scenario picker: 3 curated replays, 10 featured AI-built replays, and "replay any event". |
| `/crash-replay/<id>` | public | Scrubbable replay of a held portfolio vs one panic-sold on day 3. Only `COVID_2020`, `GFC_2008`, `DEMO_2016` resolve for a first-time visitor; `CUSTOM_*` ids live in the generating browser's localStorage. |
| `/news` | public | Headlines from Indian business-news RSS feeds (`handlers/news.py` `FEEDS`), tagged bullish / bearish / neutral. |
| `/chat` | public | Full-page chat with the coach, "Saathi": saved conversations, branches, projects, slash-command cards, share links (`/share/<id>`). |
| `/privacy`, `/terms`, `/grievance` | public | Built from `partials/pages/` by `prerender.py`. |
| `/login`, `/register`, `/reset-password-request`, `/reset-password` | public, not indexed | Email + password (signup confirmed by emailed OTP) or Google sign-in (since 2026-10-17). |
| `/onboarding` | login | Age (13+), optional school + class code, investing style. |
| `/portfolio`, `/report-card`, `/settings` | login | Private. |
| `/orders` | — | Redirects to `/portfolio`. |
| `/a/<slug>` | hidden | Admin console. Slug checked server-side against `ADMIN_PATH`; a wrong slug gets the same 404 shape as any unknown route. |

### Product mechanics

- **Starting balance:** ₹1,00,000 virtual (`STARTING_CASH_PAISE = 1_00_00_000`, `js/state.js`).
- **Universe** (`js/data/universeFull.json`, rebuilt weekly by `.github/workflows/universe-refresh.yml`):
  - 2,636 NSE mainboard + 581 NSE Emerge (SME) + 1,284 BSE-only = **4,501 stocks**. Dual-listed companies appear once (ISIN dedupe, NSE wins); 2,509 NSE rows also carry their BSE scrip code.
  - **370 ETFs** (NSE).
  - **14,200 mutual-fund schemes** from AMFI (`js/data/mfFull.json`); **8,945 active** (a NAV in the last year), the count `prerender.py` checks.
  - BSE-only stocks are priced: quote / history / fundamentals fall back from `.NS` to `.BO`.
- **Prices:** Yahoo Finance through the Supabase `quote_cache` layer during market hours; NSE's official end-of-day bhavcopy as a second source since 2026-09-27. Whether intraday quotes are real-time or delayed is not established in code → never say "real-time".
- **Orders:** market, limit, and after-market orders (AMO). Limit orders and AMOs are matched server-side on a schedule (`handlers/match-orders.py`), so the app does not need to be open.
- **Coach — nine deterministic detectors** (pure functions in `js/coach/biasCore.js`, inputs built by `js/coach/biasDetectors.js`, rewritten 2026-10-24): panic-sell, pump-chase, FOMO (≥18% up in 7 sessions, new position), anchoring (buy near the 52-week high/low), single-stock concentration (>40%), sector concentration (>55%), disposition effect, churning (≥3 round-trips in 30 days), overtrading (≥10 trades in 24 h). Price thresholds scale with each stock's own volatility (stdev of 60 daily returns); a trade price >25% from the last close is treated as a data mismatch and not judged on price. Mutual funds are excluded from the price-based detectors.
  - **Every trade is checked (verified 2026-11-02):** market orders are judged before they are booked (`js/pages/stockDetail.js` ~2356, flags stored in `transactions.bias_flags`); AMO and limit orders are judged when placed (`noteAfterOrder`, ~2089 and ~2156).
- **After-trade note** (`js/components/tradeNote.js`, copy `js/coach/biasCopy.js`, since 2026-10-24): when a decision fits a pattern, a quiet note appears AFTER the order goes through, with the user's own numbers (e.g. for panic-selling: the fall, the stock's usual daily move, the result) and a "What is …?" explainer. **There is no longer any pause before an order:** the pre-sell modal (`interventionModal.js`) was removed on 2026-10-24 (owner's option C).
- **Dip records:** real falls and recoveries from daily closes since 2011 or listing (`scripts/build_dip_stats.py` → `js/data/dipStats.js`, refreshed by workflow): 2,099 stocks pass the data-quality gate (2026-11-01 build). Shown on stock pages; the coach uses them in answers.
- **LLM coach "Saathi":** `api/_messages.js` puts a Messages-API model at the head of every chain in `api/chat.js` and `api/ai.js` (live since 2026-10-20, on Google Cloud Vertex AI); Gemini models are the fallback. Public copy names no model vendor. Explains; the persona + `outputFilter.js` stop it recommending trades. Optional Hinglish mode (Settings). Can look up crypto prices (lookup only — crypto is not tradable).
- **Notifications:** bell inbox + web push for order fills and account notices (every signed-in user since 2026-10-19); pushes held overnight (22:00–07:00 IST).
- **Removed features:** sending/receiving virtual cash between users and redeem codes were removed on 2026-10-17 (commit c64275eb). Never mention them.
- **Crash replays** (`js/data/crashes.js`, `js/pages/crashReplay.js`):
  - Curated, every frame a real daily Nifty 50 close (`scripts/build_crash_frames.py`): **COVID-19 crash** (Feb 19 – Nov 9 2020; holding +5.6%), **Global Financial Crisis** (Jan 8 – Oct 27 2008; panic-selling won, Nifty −59.9%), **Demonetisation** (Nov 8 2016 – Feb 28 2017; holding +7.0%). Model: ₹1,00,000 tracking the Nifty 50; the panic-seller sells at the day-3 close and stays in cash. `prerender.py` refuses to build if the frames and summary numbers disagree. The first versions recorded the day-3 sale far below the portfolio's value that day (COVID ₹66,800 vs ₹95,900), which produced the false "holding won by 38.4%".
  - Featured (AI-written narration over Yahoo price data, cached cross-user): Harshad Mehta 1992, Dot-com 2000, GFC 2008, Satyam 2009, IL&FS 2018, DHFL 2019, YES Bank 2020, COVID 2020, Paytm IPO 2021, Adani–Hindenburg 2023.
  - Plus a free-text "replay any event" generator.
- **Report card** (`js/pages/reportCard.js`): letter grade A+ → D recomputed after every decision (not monthly), self-override rate, 8 badges, AI-written narrative. Score adds up to +10 for positive returns, but is driven mainly by behaviour.
- **No leaderboard.** Removed on purpose (Apr 2026).
- **PWA:** installable, service-worker cached; light / dark theme.
- **No payment code anywhere** (no Razorpay / Stripe / subscriptions).
- **Legal:** privacy policy (DPDP Act 2023), terms, grievance officer (`grievance@stocksaathi.co.in`).

## 2. Honest claims (the only statements public copy may make)

1. StockSaathi is free. There is no paid plan and no payment of any kind.
2. You start with ₹1,00,000 of virtual money. No real money is ever involved; nothing can be deposited or withdrawn.
3. 4,000+ Indian stocks from both NSE and BSE — including NSE Emerge SME listings — plus 300+ ETFs and 8,000+ active mutual fund schemes. (The MF file has ~14,000 rows, but the app hides schemes with no NAV in a year, leaving ~8,900. `prerender.py` fails the build if the data drops below any of these floors.)
4. Real market prices (never "real-time" / "live" as a promise; say prices can be delayed).
5. The AI coach checks every trade for nine common investing mistakes: panic-selling, FOMO, pump-chasing, anchoring, putting too much in one stock, putting too much in one sector, the disposition effect, churning, and overtrading. (Verified 2026-11-02, §1: market, AMO and limit orders are all judged.)
6. When a trade fits one of those patterns, a short note appears after the order goes through, using the user's own numbers, and explains the pattern; it never blocks or delays the order. Stock pages show each stock's real falls and recoveries, measured from daily prices since 2011 or listing. (Never say the app "pauses" a sale: that pause was removed on 2026-10-24.)
7. The coach explains; it never tells you what to buy or sell.
8. Replay real Indian market crashes — COVID-19 2020, the 2008 financial crisis, demonetisation 2016 — built from real daily Nifty 50 closes, and compare holding against panic-selling. Results: COVID holding +5.6% by 9 Nov 2020; 2008 selling early won within the window; demonetisation holding +7.0%. Featured replays also cover Harshad Mehta 1992, Satyam 2009, YES Bank 2020, Adani–Hindenburg 2023 and more.
9. Market orders, limit orders and after-market orders, like a real trading app.
10. A report card that grades your decisions, not just your returns.
11. Built for Indian teens, ages 13–18. (Positioning. Signup accepts 13+ and has no upper limit, so never say "only".)
12. Markets, crash replays, news and the coach can be explored without an account.
13. No leaderboard of returns — by design.
14. Hinglish mode for the coach.
15. Educational simulator; not a SEBI-registered broker or adviser; not affiliated with SEBI, NSE or BSE.
16. Account and data deletion: on request to grievance@stocksaathi.co.in. (Settings → "Delete account" currently only signs out and flags the profile; never claim deletion from Settings until a real self-delete ships.)
17. A stock page is indexable only if the stock is in the Nifty 500 AND carries its own record of falls from `js/data/dipStats.js` (`rich_page()` in `scripts/prerender.py`): 423 stock pages on 2026-11-02 (it was 1,727 on 2026-10-01, cut on 2026-10-02 and 2026-10-14 to avoid scaled template content). Every other stock page exists for visitors as `noindex, follow`. Reasons per stock: `scripts/dip-quality.json`.
18. User statistics may be published only as percentages and rankings from `scripts/data/public_stats.json` (source queries `scripts/public_stats.sql`, test and temp-mail accounts excluded), never as counts of accounts, signups, trades or replays (owner, 2026-11-02).

## 3. Cannot verify / contradicted — never publish

| Claim | Where it was | Action |
|---|---|---|
| "92% of Indian teens can't define a mutual fund" | landing stat + "Why" | No source. Removed (Phase 2). |
| "1st AI coach grounded in historical recovery data" | landing stat | Unprovable superlative. Removed (Phase 2). |
| "Live quotes… your own Finnhub key… always a synthetic fallback" | landing feature card | No Finnhub setting exists; invented prices are forbidden. Removed (Phase 2). |
| "Monthly grade" | landing | Grade is continuous. Fixed (Phase 2). |
| "Real NSE end-of-day prices" | FAQ JSON-LD | Wrong. Fixed (Phase 2 FAQ; Phase 3 metadata). |
| Negative claims about Moneybhai / StockGro / Sensibull | landing "Why" | Unverified. Removed (Phase 2). |
| "Invest in real Indian stocks and crypto" | onboarding | Crypto is not tradable. Fixed (Phase 2). |
| "No third-party analytics" | privacy policy | Vercel Web Analytics is loaded. Flagged to owner. |
| Masters' Union AI Buildathon | — | Owner instruction: never mention. |
| Anything about lessons, courses, modules or quizzes | — | StockSaathi has none. Never imply a curriculum. |
| "Send virtual cash to friends", redeem codes | llms.txt | Feature removed 2026-10-17. Removed from llms.txt (2026-11-02). |
| "Pauses you before a panic-sell" | §2 claim 6, llms.txt, WebApplication featureList | Pause removed 2026-10-24. Reworded (2026-11-02). |
| Any user count ("N users", "thousands of students", signup/trade/replay totals) | — | Owner, 2026-11-02: never publish counts. Percentages and rankings only (§2 claim 18). |


## 5. Keyword universe → target page

| Cluster | Representative queries | Page |
|---|---|---|
| Core simulator | stock market simulator india, virtual trading app india, paper trading india, demo trading app india, mock trading app, stock market game india, fantasy stock market, virtual stock market | `/` |
| Audience | …for teenagers / students / beginners / kids / class 11 / class 12 / college; stock market game for school students; can a 15 year old invest in india | `/` + `/for-students` |
| Beginner / learn | how can a teenager learn the stock market, learn stock market from zero, learn investing without real money, stock market practice app, is paper trading good for beginners | `/learn-stock-market` |
| Feature long-tail | NSE BSE simulator free, simulator with real prices, practice trading with virtual money, fake money stock trading india, practice limit orders, mutual fund simulator | `/`, `/stocks` |
| Hinglish | share market kaise sikhe, stock market sikhne ka app, virtual paise se trading, share market practice app free, demo trading kaise kare | Hinglish FAQ on `/` and `/learn-stock-market` |
| Questions to AI | best app to practice stocks in india, is there a free stock simulator for students, safest way for a teen to learn investing | `/` FAQ, `/learn-stock-market` |
| Behaviour | panic selling, FOMO investing, why beginners lose money, AI stock market tutor | `/`, `/chat` |
| Crash history | covid crash 2020 nifty, 2008 crash sensex, demonetisation stock market, harshad mehta scam replay, crash simulator | `/crash-replay`, `/crash-replay/COVID_2020`, `/crash-replay/GFC_2008`, `/crash-replay/DEMO_2016` |
| Stock pages | practice trading <company>, <symbol> share simulator | `/stocks/<symbol>` — Nifty 500 indexed, the rest `noindex` (thin-content guard) |
| Not indexed | — | login, register, reset-*, onboarding, portfolio, report-card, settings, `/a/*`, `/news` (third-party headlines → `noindex, follow`) |
| Redirect | /market, /markets | 308 → `/stocks` |

## 6. Architecture decisions

- **Phase 1 — clean URLs.** History-API router. Old `#/…` links are converted on load with `history.replaceState`. Vercel rewrites only the known SPA route patterns to the app shell, so unknown paths still return a real 404.
- **Phase 3 — pre-rendering: build-time static snapshots** (`scripts/prerender.py`, stdlib Python, output committed). Chosen over a per-request Python handler because: no function cold start on every page view (TTFB / LCP), no single runtime point of failure for every page, byte-identical HTML for every visitor (no user-agent sniffing → no cloaking risk), and it extends the pattern `index.html` already uses. The SPA renders over the snapshot exactly as it renders over the landing snapshot today.
- **Admin.** `/a/<slug>` stays a path (owner's call). The slug is redacted from Vercel Web Analytics and from `page_view` events; Phase 4 replaces it in the address bar with `/a` after validation. Vercel's own request logs will still record the path.

## 7. Phase log

- Phase 0 — this document.
- Phase 1 — clean URLs.
- Phase 2 — homepage copy. Source: `partials/landing.html` → `python scripts/build_landing.py` (injects into index.html + js/pages/landingContent.js, rebuilds the FAQPage JSON-LD from the visible FAQ).
- Phase 3 — metadata, pre-rendering, structured data, sitemap, robots, llms.txt, manifest, icons.
  - `scripts/prerender.py` writes 513 pages from `index.html` + `universeFull.json` + `crashes.js` + `partials/pages/`. The daily `universe-refresh` workflow re-runs it.
  - Indexable: `/`, `/stocks`, 1,727 stock pages that passed the dip-history quality gate (Nifty 500 pages that fail are generated but `noindex, follow`), `/crash-replay` + 3 curated replays, `/chat`, `/learn-stock-market`, `/for-students`, legal pages. `noindex`: `/news`, `/app-shell` (gated routes + stocks outside the Nifty 500 + `CUSTOM_*` replays), `404.html`.
  - Images: `scripts/render_assets.py` renders `images/*.png` + `favicon.ico` from `logo.svg` / `og-image.svg` (the old OG image showed invented ticker moves; replaced).
  - Data fix: `GFC_2008.finalDelta` was `0.4` (claimed holding won); its own numbers say the panic-seller finished 41.5% ahead within the window.
- Phase 4 — admin URL cleanup.

## 8. Search Console + Bing Webmaster Tools (owner to do)

1. **Google Search Console** → Add property → **Domain** `stocksaathi.co.in` → verify with the DNS TXT record at the registrar (covers `www` and every path; no code change). If you prefer the URL-prefix method instead, send the `google-site-verification` meta tag content and it goes in `index.html`'s `<head>` above `<!-- meta:start -->` (outside the generated block), then `python scripts/prerender.py` copies it to every page.
2. GSC → **Sitemaps** → submit `https://stocksaathi.co.in/sitemap.xml`.
3. GSC → **URL inspection** → request indexing for `/`, `/stocks`, `/crash-replay`, `/learn-stock-market`, `/for-students`, `/crash-replay/COVID_2020`.
4. **Bing Webmaster Tools** → **Import from Google Search Console** (fastest; copies the verified site and sitemap). Otherwise add the site, verify by DNS CNAME or the `msvalidate.01` meta tag (same placement rule as step 1), and submit the sitemap.
5. **IndexNow** (Bing, Yandex, Seznam, Naver; no account needed): the key file `448b5ef0e83555a5524be82dbe99f74d.txt` is served at the site root. After deploying changed pages, run `python scripts/indexnow.py /changed/path ...`; with no arguments it submits every page URL in `sitemap.xml`. Ping only changed URLs, because resubmitting unchanged pages gets a host throttled.
6. Recheck in 1–2 weeks: GSC **Pages** report (indexed vs "Crawled — currently not indexed" for stock pages), **Enhancements** for breadcrumbs and FAQ parse errors.

## 9. Wikidata entity draft (owner to review and submit; not submitted)

Wikidata requires notability (serious, public, independent references). Create the item only once there is at least one independent source (press coverage, an event results page, an app-store listing); otherwise it is likely to be deleted.

- **Label (en):** StockSaathi
- **Description (en):** free web-based stock market simulator for Indian teenagers
- **Aliases:** Stock Saathi
- **instance of (P31):** web application (search Wikidata for the item's QID before adding)
- **genre / main subject (P921):** stock market simulator; financial literacy
- **country of origin (P495):** India (Q668)
- **language of work (P407):** English (Q1860)
- **official website (P856):** https://stocksaathi.co.in/
- **founded by (P112):** Ali Arbab (create/link a person item only if it meets notability separately)
- **inception (P571):** 2026
- **source code repository (P1324):** https://github.com/thealiarbab/StockSaathi
- **use (P366):** education; financial literacy
- **References:** each statement needs a reference URL (the official site suffices for self-descriptive facts like website and repository; independent sources are needed for notability).
