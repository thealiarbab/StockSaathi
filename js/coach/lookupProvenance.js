const LOOKUP_TOOL_RE = /^(?:get_[a-z0-9_]+|search_stocks)$/;
const SYMBOL_TOOLS = new Set(["get_stock_price", "get_fundamentals", "get_crypto_price", "search_stocks"]);
const NUMERIC_FACTS = {
  get_stock_price: [
    "price_inr", "prev_close_inr", "day_change_pct", "day_high_inr", "day_low_inr",
    "pe_ratio", "pb_ratio", "market_cap_crore_inr",
  ],
  get_fundamentals: [
    "pe_ratio", "pb_ratio", "eps_ttm_inr", "roe_pct", "market_cap_crore_inr", "dividend_yield_pct",
  ],
};

function safeFacts(tool, facts) {
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return undefined;
  const allowed = NUMERIC_FACTS[tool];
  if (!allowed) return undefined;
  const picked = {};
  for (const key of allowed) {
    const value = facts[key];
    if (value === null || (typeof value === "number" && Number.isFinite(value))) picked[key] = value;
  }
  for (const key of ["symbol", "name", "data_source"]) {
    if (typeof facts[key] === "string") picked[key] = facts[key].slice(0, 64);
  }
  if (typeof facts.is_live === "boolean") picked.is_live = facts.is_live;
  return Object.keys(picked).length ? picked : undefined;
}

export function normalizeLookupProvenance(records) {
  if (!Array.isArray(records)) return [];
  const seen = new Set();
  const normalized = [];
  for (const record of records) {
    if (!record || typeof record !== "object" || !LOOKUP_TOOL_RE.test(record.tool || "")) continue;
    const status = record.status === "returned" ? "returned" : "failed";
    const subject = SYMBOL_TOOLS.has(record.tool) && typeof record.subject === "string"
      ? record.subject.trim().slice(0, 48)
      : "";
    const facts = status === "returned" ? safeFacts(record.tool, record.facts) : undefined;
    const item = {
      tool: record.tool,
      status,
      ...(subject ? { subject } : {}),
      ...(facts ? { facts } : {}),
      ...(Number.isFinite(record.recordedAt) ? { recordedAt: record.recordedAt } : {}),
    };
    const key = `${item.tool}:${item.subject || ""}:${item.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(item);
    if (normalized.length >= 12) break;
  }
  return normalized;
}

export function lookupProvenanceContext(records) {
  const normalized = normalizeLookupProvenance(records);
  if (!normalized.length) return "";
  return `\n\n<stocksaathi_lookup_provenance>${JSON.stringify(normalized)}</stocksaathi_lookup_provenance>\n[Internal instruction: This record proves which lookup tools ran and may include their exact returned data. It does not prove every sentence was accurate or that the data is still current. If asked whether a lookup ran, answer from this record; do not claim it did not run when the record says it returned a result. For current figures, run a fresh lookup.]`;
}

export function withLookupProvenance(text, records) {
  return `${String(text || "")}${lookupProvenanceContext(records)}`;
}
