#!/usr/bin/env node
/**
 * universe-size.mjs — adds each company's market value (₹ crore, `mc`) to
 * js/data/universeFull.json so "Top by size" on /stocks is in the right order
 * on first paint, before the search snapshot arrives.
 *
 * Source: the public search snapshot (/api/ai?op=search-snapshot&v=2), which
 * already drops fundamentals filed under the wrong ticker. Values are rounded
 * to 2 significant figures so the file (and its cache hash) doesn't change
 * every day. If the snapshot can't be fetched, existing values are kept.
 *
 * Run after build-universe.mjs (universe-refresh.yml), or alone:
 *   node scripts/universe-size.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const brotli = promisify(zlib.brotliCompress);
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "js", "data");
const OUT_JSON = path.join(OUT_DIR, "universeFull.json");
const OUT_META = path.join(OUT_DIR, "universeFull.meta.json");
const SNAP_URL = "https://stocksaathi.co.in/api/ai?op=search-snapshot&v=2";

function round2(n) {
  if (!(n > 0)) return null;
  const p = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return Math.round(n / p) * p;
}

const rows = JSON.parse(await fs.readFile(OUT_JSON, "utf8"));
let mcBySym = null;
try {
  const res = await fetch(SNAP_URL, { headers: { "User-Agent": "stocksaathi-build" } });
  if (!res.ok) throw new Error("http " + res.status);
  const d = await res.json();
  const i = d.cols.indexOf("mc");
  mcBySym = new Map(d.rows.filter(r => r[i] > 0).map(r => [r[0], r[i]]));
  console.log(`[size] snapshot ${d.asOf}: ${mcBySym.size} market values`);
} catch (e) {
  console.warn(`[size] snapshot unavailable (${e.message}); keeping existing values`);
}

let set = 0;
for (const r of rows) {
  if (r.kind !== "EQUITY" || !mcBySym) continue;
  const mc = round2(mcBySym.get(r.symbol));
  if (mc) { r.mc = mc; set++; } else delete r.mc;
}
if (mcBySym) console.log(`[size] ${set} of ${rows.filter(r => r.kind === "EQUITY").length} companies have a size`);

const json = JSON.stringify(rows);
const sha8 = crypto.createHash("sha256").update(json).digest("hex").slice(0, 8);
const brBuf = await brotli(Buffer.from(json, "utf-8"), {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: json.length },
});
for (const f of await fs.readdir(OUT_DIR)) {
  const m = f.match(/^universeFull\.([0-9a-f]{8})\.json(\.br)?$/);
  if (m && m[1] !== sha8) await fs.unlink(path.join(OUT_DIR, f)).catch(() => {});
}
const meta = JSON.parse(await fs.readFile(OUT_META, "utf8"));
Object.assign(meta, { sha8, rawBytes: json.length, brotliBytes: brBuf.length, sizesAt: new Date().toISOString() });
await Promise.all([
  fs.writeFile(OUT_JSON, json),
  fs.writeFile(path.join(OUT_DIR, `universeFull.${sha8}.json`), json),
  fs.writeFile(path.join(OUT_DIR, `universeFull.${sha8}.json.br`), brBuf),
  fs.writeFile(OUT_META, JSON.stringify(meta, null, 2)),
]);
console.log(`[size] wrote universeFull.${sha8}.json (${(brBuf.length / 1024).toFixed(1)} KB brotli)`);
