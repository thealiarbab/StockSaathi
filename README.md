<div align="center">

# StockSaathi

**Invest virtually. Learn for real.**

A free stock market simulator for students in India, with a coach that watches how you trade.

[stocksaathi.co.in](https://stocksaathi.co.in)

</div>

---

StockSaathi gives every student a virtual ₹1,00,000 portfolio priced off real NSE and BSE quotes,
then coaches the behaviour behind each trade rather than handing out tips.

| | |
|---|---|
| **Real market, virtual money** | Live quotes, OHLC charts, fundamentals, limit orders and mutual funds. Real instruments and real volatility, with no money at risk. |
| **Behaviour coach** | Detectors run on every trade (panic-selling, FOMO, anchoring, concentration, overtrading and more), and a coach grounded in historical recovery data explains what just happened, using the student's own numbers. |
| **Time Travel** | Market crashes replayed day by day, from 1992 to 2023, so students can see what holding would have done compared with selling in a panic. |
| **Report card** | A grade for decision quality, not returns, updated after every decision. |

StockSaathi gives no buy or sell recommendations, runs no returns leaderboard and places no real orders.
It is an educational simulator, not a broker or an adviser, and is not affiliated with SEBI, NSE or BSE.

## How it's built

- **Front end:** vanilla ES modules, a hash router and a custom SVG charting engine. It's an installable PWA with no framework and no build step.
- **API:** Python serverless functions on Vercel, plus edge functions for the paths where latency matters.
- **Data:** Postgres with row-level security throughout. Cross-user reads go through RPCs.
- **Market data:** a cache-first quote layer with a multi-provider fallback chain.
- **Reliability:** a Cloudflare Worker front door that fails over to a hot mirror on 5xx, timeouts or network errors.

## About this repository

This repository is the public home of StockSaathi. The application source lives in a separate repository.

All rights reserved.
