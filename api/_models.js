// Gemini model IDs that Vertex has retired or is about to, mapped to the GA
// successor. Applied to every Gemini model this app sends, env overrides
// included, so a stale GEMINI_*_MODEL value on Vercel can never point a lane
// at a model that now 404s.
//
// Vertex lifecycle page, read 13 Oct 2026: gemini-2.5-pro, -flash and
// -flash-lite all retire 20 Oct 2026. Successors are the GA 3.x models
// (3.1 Flash-Lite and 3.5 Flash: available until May 2027 or later).
// 3.1 Pro is still preview; it is what the chat lanes already run.
const RETIRED = {
  "gemini-2.5-flash-lite": "gemini-3.1-flash-lite",
  "gemini-2.5-flash": "gemini-3.5-flash",
  "gemini-2.5-pro": "gemini-3.1-pro-preview",
  "gemini-2.0-flash": "gemini-3.5-flash",
  "gemini-2.0-flash-lite": "gemini-3.1-flash-lite",
};

export function liveGeminiModel(model) {
  const m = String(model || "").trim();
  const bare = m.replace(/^google\//, "");
  const next = RETIRED[bare] || RETIRED[bare.replace(/-(preview|\d{3})(-[\w-]+)?$/, "")];
  if (!next) return m;
  return m.startsWith("google/") ? `google/${next}` : next;
}

// Gemini 3.x thinks by default. The lanes that used to sit on non-thinking
// 2.5 Flash-Lite (json, and ai.js's chat profile) ask for the minimum.
export function isGemini3(model) {
  return /^(google\/)?gemini-3/.test(String(model || ""));
}
