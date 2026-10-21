import assert from "node:assert/strict";
import {
  normalizeLookupProvenance,
  lookupProvenanceContext,
  withLookupProvenance,
} from "../js/coach/lookupProvenance.js";

const records = normalizeLookupProvenance([
  {
    tool: "get_stock_price", subject: "TCS", status: "returned",
    facts: { symbol: "TCS", name: "TCS Limited", price_inr: 2269.3, pe_ratio: 17.3, private_note: "discard" },
    recordedAt: 1792579200000,
  },
  { tool: "get_fundamentals", subject: "TCS", status: "returned" },
  { tool: "get_stock_price", subject: "FAKE", status: "failed" },
  { tool: "get_user_portfolio", subject: "user@example.com", status: "returned" },
  { tool: "not_a_tool", subject: "TCS", status: "returned" },
  null,
]);

assert.deepEqual(records, [
  {
    tool: "get_stock_price", subject: "TCS", status: "returned",
    facts: { price_inr: 2269.3, pe_ratio: 17.3, symbol: "TCS", name: "TCS Limited" },
    recordedAt: 1792579200000,
  },
  { tool: "get_fundamentals", subject: "TCS", status: "returned" },
  { tool: "get_stock_price", subject: "FAKE", status: "failed" },
  { tool: "get_user_portfolio", status: "returned" },
]);

const context = lookupProvenanceContext(records);
assert.match(context, /"tool":"get_stock_price","status":"returned","subject":"TCS"/);
assert.match(context, /"tool":"get_stock_price","status":"failed","subject":"FAKE"/);
assert.match(context, /"price_inr":2269\.3/);
assert.match(context, /does not prove every sentence was accurate/);
assert.doesNotMatch(context, /user@example\.com/);
assert.equal(lookupProvenanceContext([]), "");
assert.match(withLookupProvenance("Earlier answer.", records), /^Earlier answer\.\n\n<stocksaathi_lookup_provenance>/);

console.log("coach lookup provenance: 9 assertions passed");
