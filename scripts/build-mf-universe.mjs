#!/usr/bin/env node
/**
 * build-mf-universe.mjs — fetches the entire AMFI mutual-fund catalog (~17k
 * scheme rows / ~5k unique scheme codes), parses the proprietary
 * semicolon-delimited NAVAll.txt format, and writes app/js/data/mfFull.json.
 *
 * Run locally:   node scripts/build-mf-universe.mjs
 * Check mode:    node scripts/build-mf-universe.mjs --check  (exits non-zero on sanity-gate fail)
 *
 * Output shape per row:
 *   {
 *     symbol:        "MF_118718",      // MF_<AMFI scheme code> — primary key
 *     amfi_code:     "118718",
 *     name:          "Aditya Birla Sun Life Frontline Equity Fund - Direct Plan-Growth",
 *     amc:           "Aditya Birla Sun Life Mutual Fund",
 *     category:      "Equity Scheme - Large Cap Fund",
 *     category_bucket:"Equity",         // Equity / Debt / Hybrid / Index / Solution / Other
 *     plan_type:     "Direct" | "Regular",
 *     option_type:   "Growth" | "IDCW" | "Other",
 *     scheme_kind:   "Open" | "Close" | "Interval",
 *     isin_growth:   "INF209KA12Z1",
 *     isin_idcw:     "INF209KB12Z9",
 *     nav:           498.6201,
 *     nav_date:      "2026-04-25",
 *     risk:          "low" | "med" | "high",
 *     bench:         "NIFTY 50" | …  (best-effort from category)
 *     kind:          "MF",
 *   }
 *
 * No external deps — Node 20+ built-in fetch. The output JSON gets committed
 * to the repo (this is a build-time script, not a Vercel function).
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const brotli = promisify(zlib.brotliCompress);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, "..");
const OUT_DIR  = path.join(APP_ROOT, "js", "data");
const OUT_JSON = path.join(OUT_DIR, "mfFull.json");
const OUT_META = path.join(OUT_DIR, "mfFull.meta.json");

const AMFI_URL = "https://portal.amfiindia.com/spages/NAVAll.txt";
const UA = "Mozilla/5.0 (compatible; StockSaathi-Build/1.0; +https://stocksaathi.co.in)";

const isCheck = process.argv.includes("--check");

// ── Category bucket mapping ─────────────────────────────────────────────────
// Five top-level buckets the UI exposes as filter chips: Equity, Debt, Hybrid,
// Index/ETF (passive), Solution (Retirement/Childrens), Other (Gold/Silver/
// FoF/Overseas). Match against the AMFI category string.
function bucketFor(category) {
  const c = category.toLowerCase();
  // Order matters — gold/silver beat the generic ETF check because Gold ETFs
  // are functionally commodity exposure, not passive equity. FoF / Overseas
  // beat the index check because some International index trackers ship
  // under "Fund of Fund - Overseas".
  if (/gold|silver/.test(c)) return "Commodity";
  if (/fund of fund|overseas|international|fof/.test(c)) return "FoF";
  if (/index fund|etf|exchange traded/.test(c)) return "Index";
  if (/^equity scheme|equity fund/.test(c)) return "Equity";
  if (/^debt scheme|debt fund|liquid fund|gilt|bond fund|duration fund|money market|overnight/.test(c)) return "Debt";
  if (/^hybrid scheme|hybrid fund|balanced|arbitrage|equity savings|conservative hybrid|aggressive hybrid|multi asset|dynamic asset/.test(c)) return "Hybrid";
  if (/solution|retirement|children/.test(c)) return "Solution";
  // Close-ended scheme short-name categories (no parenthesized sub-category):
  //   "Income"  → fixed-maturity debt plans (FMPs / closed-end income funds)
  //   "Growth"  → closed-end equity funds
  //   "ELSS"    → closed-end tax-saving equity (rare; mostly open-ended now)
  if (c === "income") return "Debt";
  if (c === "growth") return "Equity";
  if (c === "elss") return "Equity";
  return "Other";
}

// Risk tier — derived from the category bucket. Equity / Sectoral / Small-cap
// / Mid-cap → high; Index Equity / Large-cap / Aggressive Hybrid → med; Debt
// / Liquid / Money Market → low; Gold / FoF → med; everything else → med.
function riskFor(category, bucket) {
  const c = category.toLowerCase();
  if (/sectoral|thematic|small cap|micro cap/.test(c)) return "high";
  if (bucket === "Equity") {
    if (/large cap|focused|elss|dividend yield|value/.test(c)) return "med";
    return "high";
  }
  if (bucket === "Index") return "med";
  if (bucket === "Hybrid") {
    if (/aggressive hybrid|equity savings|multi asset/.test(c)) return "med";
    if (/conservative|arbitrage/.test(c)) return "low";
    return "med";
  }
  if (bucket === "Debt") {
    if (/credit risk|long duration|gilt fund$/.test(c) && !/10 year/.test(c)) return "med";
    return "low";
  }
  if (bucket === "Commodity") return "med";
  if (bucket === "FoF") return "med";
  if (bucket === "Solution") return "med";
  return "med";
}

// Best-effort benchmark inference from category. Only common buckets get
// explicit benches; everything else falls back to a generic "BSE/NSE Index".
function benchFor(category, bucket) {
  const c = category.toLowerCase();
  if (/large cap fund/.test(c)) return "NIFTY 100";
  if (/mid cap fund/.test(c)) return "NIFTY Midcap 150";
  if (/small cap fund/.test(c)) return "NIFTY Smallcap 250";
  if (/large & mid|large and mid/.test(c)) return "NIFTY LargeMidcap 250";
  if (/multi cap|flexi cap/.test(c)) return "NIFTY 500";
  if (/elss/.test(c)) return "NIFTY 500";
  if (/focused fund/.test(c)) return "NIFTY 500";
  if (/value fund|contra/.test(c)) return "NIFTY 500";
  if (/dividend yield/.test(c)) return "NIFTY Dividend Opportunities 50";
  if (/index fund|etf/.test(c)) return "Linked Index";
  if (/sectoral|thematic/.test(c)) return "Sectoral Index";
  if (/aggressive hybrid/.test(c)) return "CRISIL Hybrid 35+65";
  if (/conservative hybrid|equity savings/.test(c)) return "CRISIL Hybrid 75+25";
  if (/balanced advantage|dynamic asset/.test(c)) return "CRISIL Hybrid 50+50";
  if (/arbitrage/.test(c)) return "NIFTY 50 Arbitrage";
  if (/multi asset/.test(c)) return "Multi-Asset Index";
  if (/liquid fund/.test(c)) return "CRISIL Liquid Fund Index";
  if (/overnight/.test(c)) return "CRISIL Overnight Index";
  if (/gilt fund/.test(c)) return "CRISIL Gilt Index";
  if (/credit risk/.test(c)) return "CRISIL Credit Risk Index";
  if (/corporate bond/.test(c)) return "CRISIL Corporate Bond Index";
  if (/banking and psu|banking & psu/.test(c)) return "CRISIL Banking & PSU Index";
  if (/short duration|low duration|ultra short|money market/.test(c)) return "CRISIL Short-Term Index";
  if (/medium duration|medium to long|long duration|dynamic bond/.test(c)) return "CRISIL Medium-Long Index";
  if (/floater/.test(c)) return "CRISIL Floater Index";
  if (/gold/.test(c)) return "Domestic Gold";
  if (/silver/.test(c)) return "Domestic Silver";
  if (/retirement/.test(c)) return "Lifecycle Index";
  if (/children/.test(c)) return "Lifecycle Index";
  if (/overseas|international|nasdaq|s&p 500|us tech/.test(c)) return "International Index";
  if (/fund of fund|fof/.test(c)) return "Underlying Fund";
  return "AMFI Category Index";
}

// Parse plan + option type from scheme name. AMFI doesn't ship these as
// separate columns; they're embedded in the name string.
function parsePlanAndOption(name) {
  const n = name.toLowerCase();
  let plan = "Regular";
  if (/\bdirect\b/.test(n)) plan = "Direct";

  // Option order matters — IDCW (formerly Dividend) takes precedence over
  // Growth when both appear (rare but happens, "Growth - IDCW" is split).
  let option = "Growth";
  if (/\bidcw\b|\bdividend\b|payout|reinvest/.test(n)) option = "IDCW";
  else if (/bonus/.test(n)) option = "Bonus";
  return { plan_type: plan, option_type: option };
}

// AMC name → tidy display string. Strips legal-entity boilerplate so card
// titles read "HDFC Mutual Fund" instead of "HDFC Asset Management Company
// Limited - HDFC Mutual Fund".
function tidyAmc(amcRaw) {
  if (!amcRaw) return "";
  // Common sponsor prefixes we strip.
  return amcRaw
    .replace(/Asset Management Company Limited/i, "")
    .replace(/Asset Management/i, "")
    .replace(/AMC Limited/i, "")
    .replace(/Company Limited/i, "")
    .replace(/\s+-\s+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// AMFI date format: "25-Apr-2026" → "2026-04-25"
function parseAmfiDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const months = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
                   Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const mm = months[m[2]];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[mf] fetching ${AMFI_URL}…`);
  const res = await fetch(AMFI_URL, {
    headers: { "User-Agent": UA, "Accept": "text/plain, */*" },
  });
  if (!res.ok) {
    console.error(`[mf] AMFI fetch failed: ${res.status} ${res.statusText}`);
    process.exit(2);
  }
  const text = await res.text();
  const lines = text.split(/\r?\n/);
  console.log(`[mf] ${lines.length.toLocaleString()} raw lines`);

  // Walk the file linearly. Two pieces of context get carried forward:
  //   currentCategory — set by the "Open Ended Schemes(...)" / "Close Ended"
  //     header lines. AMFI groups schemes by category; every scheme below a
  //     header inherits it until the next header.
  //   currentAmc — set by lines that look like "<AMC name> Mutual Fund". AMFI
  //     groups schemes by AMC inside each category. Same inheritance rule.
  //
  // Only data lines (rows that start with a numeric scheme code followed by
  // a semicolon) become rows. Blank lines and the static "Scheme Code;…"
  // header line are skipped.
  let currentCategory = "";
  let currentSchemeKind = "Open";
  let currentAmc = "";
  const rows = [];
  const seenCodes = new Set();
  let dropped = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Category headers: "Open Ended Schemes(Equity Scheme - Large Cap Fund)"
    const catMatch = trimmed.match(/^(Open|Close|Interval) Ended Schemes\((.+)\)\s*$/);
    if (catMatch) {
      currentSchemeKind = catMatch[1];
      currentCategory = catMatch[2].trim();
      continue;
    }

    // Static column header at the very top of the file.
    if (/^Scheme Code\s*;/.test(trimmed)) continue;

    // Data rows start with a numeric scheme code followed by a semicolon.
    if (/^\d{4,7};/.test(trimmed)) {
      const cols = trimmed.split(";").map(s => s.trim());
      if (cols.length < 6) { dropped++; continue; }

      // AMFI changed the schema (observed 2026-09-12): Plan and Option became
      // their own columns, where they used to be baked into the scheme name.
      //   old (6): code;isin1;isin2;name;nav;date
      //   new (8): code;isin1;isin2;name;plan;option;nav;date
      // The old positional destructure still "worked" on 8 columns — it just
      // read navStr from the Plan column, so Number("Direct Plan") was NaN and
      // the finite-check below dropped every row. 14,361 of them, silently,
      // with only the >=1000 sanity gate at the end catching it. Handle both.
      let amfi_code, isin1, isin2, schemeName, navStr, dateStr;
      let planCol = "", optionCol = "";
      if (cols.length >= 8) {
        [amfi_code, isin1, isin2, schemeName, planCol, optionCol, navStr, dateStr] = cols;
      } else {
        [amfi_code, isin1, isin2, schemeName, navStr, dateStr] = cols;
      }
      if (!amfi_code || !schemeName) { dropped++; continue; }
      if (seenCodes.has(amfi_code)) { dropped++; continue; }
      seenCodes.add(amfi_code);

      const nav = Number(navStr);
      if (!Number.isFinite(nav) || nav <= 0) { dropped++; continue; }

      // Feed the explicit Plan/Option columns to the classifier when present.
      // Without them the new-format name carries no "Direct"/"IDCW" text and
      // every scheme would silently classify as Regular/Growth.
      const classifySrc = [schemeName, planCol, optionCol].filter(Boolean).join(" - ");
      const { plan_type, option_type } = parsePlanAndOption(classifySrc);
      const bucket = bucketFor(currentCategory || "Other");
      rows.push({
        symbol: `MF_${amfi_code}`,
        amfi_code,
        name: classifySrc,
        amc: tidyAmc(currentAmc) || "Unknown AMC",
        category: currentCategory || "Other",
        category_bucket: bucket,
        plan_type,
        option_type,
        scheme_kind: currentSchemeKind,
        isin_growth: (isin1 && isin1 !== "-") ? isin1 : null,
        isin_idcw:   (isin2 && isin2 !== "-") ? isin2 : null,
        nav,
        nav_date: parseAmfiDate(dateStr),
        risk: riskFor(currentCategory || "", bucket),
        bench: benchFor(currentCategory || "", bucket),
        kind: "MF",
      });
      continue;
    }

    // Anything else is treated as an AMC name. AMFI is consistent here:
    // "Aditya Birla Sun Life Mutual Fund" / "HDFC Mutual Fund" / etc.
    // Skip stray separator-lines (";;;;;;" type rows that some AMCs ship).
    if (/^;+\s*$/.test(trimmed)) continue;
    if (trimmed.length < 3) continue;
    if (/mutual fund$/i.test(trimmed) || /amc/i.test(trimmed)) {
      currentAmc = trimmed;
    }
  }

  // Sort: bucket priority (Equity/Index first → discoverable from the home
  // page filter), then by AMC, then by name. Stable per-row so the diff on
  // re-runs is small.
  const BUCKET_ORDER = ["Equity", "Index", "Hybrid", "Debt", "Solution", "Commodity", "FoF", "Other"];
  rows.sort((a, b) => {
    const ai = BUCKET_ORDER.indexOf(a.category_bucket);
    const bi = BUCKET_ORDER.indexOf(b.category_bucket);
    if (ai !== bi) return ai - bi;
    if (a.amc !== b.amc) return a.amc.localeCompare(b.amc);
    return a.name.localeCompare(b.name);
  });

  // ── Sanity gate (--check mode) ──────────────────────────────────────────
  const stats = {
    total: rows.length,
    dropped,
    by_bucket: rows.reduce((a, r) => (a[r.category_bucket] = (a[r.category_bucket] || 0) + 1, a), {}),
    by_plan: rows.reduce((a, r) => (a[r.plan_type] = (a[r.plan_type] || 0) + 1, a), {}),
    distinct_amcs: new Set(rows.map(r => r.amc)).size,
    distinct_categories: new Set(rows.map(r => r.category)).size,
  };
  console.log("[mf] stats:", JSON.stringify(stats, null, 2));

  // Heuristic floors. AMFI ships ~5,000-17,000 scheme rows depending on how
  // they count plan/option variants; under 1,000 means the parser misread
  // the file (or AMFI changed format), under 25 AMCs means same.
  if (rows.length < 1000) {
    console.error(`[mf] FAIL: only ${rows.length} rows — expected 1,000+`);
    process.exit(2);
  }
  if (stats.distinct_amcs < 25) {
    console.error(`[mf] FAIL: only ${stats.distinct_amcs} distinct AMCs — expected 25+`);
    process.exit(2);
  }
  if ((stats.by_bucket.Equity || 0) < 100) {
    console.error(`[mf] FAIL: only ${stats.by_bucket.Equity || 0} Equity rows — expected 100+`);
    process.exit(2);
  }

  if (isCheck) {
    console.log("[mf] --check OK");
    return;
  }

  // ── Write output ────────────────────────────────────────────────────────
  // Same hash-stamped + brotli-q11 pattern as build-universe.mjs. Front-end
  // resolves the current sha8 from mfFull.meta.json (max-age=300) and then
  // fetches the immutable mfFull.<sha8>.json (max-age=31536000, immutable).
  const json = JSON.stringify(rows);
  const sha8 = crypto.createHash("sha256").update(json).digest("hex").slice(0, 8);
  const hashedJson = path.join(OUT_DIR, `mfFull.${sha8}.json`);
  const hashedBr   = path.join(OUT_DIR, `mfFull.${sha8}.json.br`);

  const brBuf = await brotli(Buffer.from(json, "utf-8"), {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: json.length,
    },
  });

  // Cleanup stale hashed files from prior builds.
  try {
    const existing = await fs.readdir(OUT_DIR);
    for (const f of existing) {
      const m = f.match(/^mfFull\.([0-9a-f]{8})\.json(\.br)?$/);
      if (m && m[1] !== sha8) {
        await fs.unlink(path.join(OUT_DIR, f)).catch(() => {});
      }
    }
  } catch (_) {}

  const meta = {
    generated_at: new Date().toISOString(),
    source: AMFI_URL,
    row_count: rows.length,
    distinct_amcs: stats.distinct_amcs,
    distinct_categories: stats.distinct_categories,
    by_bucket: stats.by_bucket,
    by_plan: stats.by_plan,
    sha8,
    raw_bytes: json.length,
    brotli_bytes: brBuf.length,
  };

  await Promise.all([
    fs.writeFile(OUT_JSON, json + "\n", "utf-8"),
    fs.writeFile(hashedJson, json, "utf-8"),
    fs.writeFile(hashedBr, brBuf),
    fs.writeFile(OUT_META, JSON.stringify(meta, null, 2) + "\n", "utf-8"),
  ]);
  console.log(`[mf] wrote ${OUT_JSON} (${(json.length / 1024).toFixed(1)} KB)`);
  console.log(`[mf] wrote ${hashedJson} (immutable, sha8=${sha8})`);
  console.log(`[mf] wrote ${hashedBr} (${(brBuf.length / 1024).toFixed(1)} KB, brotli q11, saves ${(100 * (1 - brBuf.length / json.length)).toFixed(1)}%)`);
  console.log(`[mf] wrote ${OUT_META}`);
}

main().catch(e => {
  console.error("[mf] fatal:", e);
  process.exit(2);
});
