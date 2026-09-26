"""Pick a trustworthy last price out of a Yahoo v8 chart result.

WHY THIS EXISTS

Yahoo labels a batch of NSE SME listings as instrumentType "MUTUALFUND", and
for those `meta.regularMarketPrice` is frozen at its 2024-07-23 value while the
chart bars keep updating with real trades. Measured 2026-09-26: AILIMITED's
meta said Rs 94.00 (regularMarketTime 2024-07-24) while it traded Rs 15.60-
20.10 with volume every day; GIRIRAJ Rs 360.20 vs Rs 67.25; NIDAN Rs 33 vs
Rs 13.30. Every parser here read the meta price blindly, so users bought and
held ten stocks at up to 6x their real price, and the limit matcher filled a
956-share order at Rs 94 for a Rs 16 stock.

The fix is to believe the bars when they are newer than the meta price.
"""

# Meta price older than the newest traded bar by more than this is stale.
_STALE_S = 3 * 24 * 3600


def pick_price(result):
    """Return (price, ts_seconds, prev_close_from_chart) or (None, None, None).

    `result` is chart.result[0]. The meta price wins when it is as fresh as the
    bars (the normal case, and the only live intraday price); the last bar
    close wins when the meta price is older than that bar.
    """
    meta = result.get("meta") or {}
    stamps = result.get("timestamp") or []
    closes = ((result.get("indicators", {}).get("quote") or [{}])[0].get("close") or [])

    last_close, last_ts, prev_close = None, None, None
    for i in range(min(len(stamps), len(closes)) - 1, -1, -1):
        if closes[i] is not None:
            if last_close is None:
                last_close, last_ts = closes[i], stamps[i]
            else:
                prev_close = closes[i]
                break

    price = meta.get("regularMarketPrice")
    mts = meta.get("regularMarketTime") or 0
    if price is not None and not (last_ts and mts and last_ts - mts > _STALE_S):
        return float(price), int(mts) or None, prev_close
    if last_close is not None:
        return float(last_close), int(last_ts), prev_close
    return None, None, None
