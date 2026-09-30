<div align="center">

# StockSaathi

**Invest virtually. Learn for real.**

An AI-coached investing simulator that teaches Indian teenagers how markets —
and their own reactions to markets — actually work.

[**stocksaathi.co.in**](https://stocksaathi.co.in) · Live in production · Real NSE/BSE prices · ₹0 of real money at risk

</div>

---

## The problem

Most Indian teenagers hear "SIP karo" at the dinner table years before anyone explains what a
mutual fund is. By the time they open a real broking account, their first market lesson is
delivered by a live portfolio and their own panic — the most expensive classroom there is.

Paper-trading apps don't fix that. They teach the *mechanics* of placing an order and skip the
part that actually loses people money: behaviour. Panic-selling a 12% dip. Chasing a stock
because it was on the news. Putting 60% of a portfolio into one sector without noticing.

## The product

StockSaathi gives every user a virtual ₹1,00,000 portfolio priced off real NSE/BSE quotes, then
watches how they trade and coaches the behaviour — not the tip.

| | |
|---|---|
| **Real market, virtual money** | Live quotes, OHLC charts, fundamentals, limit orders, mutual funds. Real instruments, real volatility, zero financial risk. |
| **Behavioural coach** | Nine detectors run on every trade — panic-selling, FOMO, anchoring, disposition effect, concentration, sector bias, churning, pump-chasing, overtrading — and an LLM coach grounded in historical recovery data explains what just happened, in the user's own numbers. |
| **Crash Replay** | Three hand-built replays (COVID-19 2020, the 2008 financial crisis, demonetisation 2016) plus ten featured AI-built replays — Harshad Mehta 1992, Dot-com 2000, GFC 2008, Satyam 2009, IL&FS 2018, DHFL 2019, YES Bank 2020, COVID 2020, Paytm IPO 2021, Adani–Hindenburg 2023 — scrubbed day by day, holding vs panic-selling. Any other event can be generated on request. |
| **Report card** | A letter grade for *decision quality*, not for returns, updated after every decision. Luck is not a skill and the scoring says so. |
| **News, sentiment, social** | Market news with sentiment tagging, an event marquee, friends, and portfolio digests. |

The product deliberately refuses to be a tip service. It gives no buy/sell recommendations, runs
no leaderboard of returns, and executes no real trades — by design, and because the alternative
is a compliance problem wearing an education costume.

## Compliance posture

StockSaathi is an educational simulator. It is not a broker, not an investment adviser, and not a
research analyst, and it is not affiliated with SEBI, NSE, or BSE. No real orders are ever placed
and no real money is ever handled. Published terms, privacy policy, and a grievance channel
(`grievance@stocksaathi.co.in`) ship with the product rather than being retrofitted later.

Users under 18 are asked to use the service with the knowledge and consent of a parent or guardian,
who can request deletion of the account and its data through the grievance channel.

## Engineering

~42,000 lines across a vanilla-JS front end, Python serverless API, and Postgres — no framework,
no build step, no bundler.

- **Front end** — vanilla ES modules, hash router, custom SVG charting engine with zoom, service-worker cached, installable PWA.
- **API** — Python serverless functions on Vercel plus a small set of edge functions for latency-sensitive paths.
- **Data** — Supabase Postgres with row-level security throughout; cross-user reads go through RPCs rather than relaxed policies. Seven versioned migrations.
- **Market data** — a cache-first quote layer with a TTL table in Postgres and a multi-provider fallback chain, sized to survive free-tier rate limits under real traffic.
- **AI** — an orchestrated coach (persona, templates, bias detectors, historical analogs, output filter) over a pinned LLM behind a server-side proxy with capped tokens, so cost and safety are both bounded server-side.
- **Reliability** — a full hot mirror. A Cloudflare Worker front-door serves from Vercel and fails over to Cloudflare Pages for static assets and Fly.io for the Python API on 5xx, timeout, or network error, with chat handled inline at the edge. A route-parity test fails CI if a new endpoint isn't mirrored, and the deploy gate blocks on either origin being unhealthy.
- **Also shipping** — a Kotlin/Compose Android port, and a signed Play Store build pipeline.

That failover stack exists for the same reason as the coach: a teenager who opens the app during
a crash — exactly when the lesson matters most and traffic spikes — should not get a 500.

## Status

Live in production on a custom domain, actively developed. Web is the primary surface; the
native Android client is in progress.

## Repository

This is the production source of a running product, published so the work can be read. It is not
a template, a boilerplate, or a self-hosting kit — there are no instructions for standing up your
own instance, and the deployment, keys, and data belong to the live service. All rights reserved.

## Disclaimer

Virtual money only. StockSaathi provides behavioural reflection, not investment advice. Past
performance does not guarantee future returns. No actual trades are executed. Consult a
SEBI-registered adviser before committing real money to any instrument.
