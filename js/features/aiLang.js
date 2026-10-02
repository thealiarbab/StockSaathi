// Query suffix for /api/ai calls that write prose for the user: "&lang=hi"
// when Hinglish mode is on in Settings, else "". The server adds the
// language rule to its prompt and caches each language separately.
import { getState } from "../state.js";

export function aiLang() {
  try { return getState()?.settings?.hinglish ? "&lang=hi" : ""; } catch { return ""; }
}
