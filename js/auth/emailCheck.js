// =============================================================================
// Email typo check for signup: "Did you mean ananya@gmail.com?"
//
// Every account whose confirmation never arrived because of a typo was a lost
// signup: gamil.com, gmal.com, gail.com, gimale.com, gmaill.com, gmail.co,
// gmail.comm, gmail.cim, gmail.comgmail.com, 3333gmail.com, gmail.zisra ...
// (auth.users, Oct 2026: every one unconfirmed). Those bounces also hurt the
// sending domain's reputation, which pushes everyone's code toward spam.
//
// Deterministic rules, not a model: the answer is needed while the user types,
// must never be wrong in a confident way, and costs nothing per keystroke.
// Suggestions never block: the user can always say "No, mine is right".
// =============================================================================

// Providers people in India actually use, most common first (ties go to the
// earlier one).
const POPULAR = [
  "gmail.com", "yahoo.com", "yahoo.co.in", "outlook.com", "hotmail.com",
  "icloud.com", "rediffmail.com", "live.com", "yahoo.in", "ymail.com",
  "protonmail.com", "proton.me", "aol.com", "zoho.com", "msn.com",
];
const POPULAR_SET = new Set(POPULAR);
const SINGLE_HOME = new Set(["gmail", "rediffmail", "icloud"]);
const REAL_ENDINGS = new Set(["com", "in", "co.in", "co.uk", "net", "org", "me", "ch", "de", "fr", "ca", "com.au", "jp", "sg", "ae", "it", "es", "nl"]);

// Optimal string alignment distance (Levenshtein + adjacent transposition), so
// "gamil" -> "gmail" costs 1, not 2.
function osa(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// "gimale" holds every letter of "gmail" plus one: a scrambled gmail.
function sameLettersPlusOne(word, target) {
  if (word.length < target.length || word.length > target.length + 1) return false;
  const bag = {};
  for (const ch of word) bag[ch] = (bag[ch] || 0) + 1;
  for (const ch of target) { if (!bag[ch]) return false; bag[ch]--; }
  return true;
}

const sld = (domain) => domain.split(".")[0];

function closestProvider(domain) {
  const label = sld(domain);
  if (label.length < 3) return null;
  let best = null, bestScore = Infinity;
  for (const p of POPULAR) {
    const pl = sld(p);
    // Same provider name, wrong ending: gmail.co / gmail.comm / gmail.zisra.
    // Gmail, Rediffmail and iCloud live at one address only; the others also
    // exist at real country endings (live.in, protonmail.ch), left alone.
    if (label === pl) {
      const ending = domain.slice(label.length + 1);
      if (!SINGLE_HOME.has(pl) && REAL_ENDINGS.has(ending)) continue;
      // A cut-off ending wins (yahoo.co -> yahoo.co.in), then the nearest.
      const score = p.startsWith(domain) ? -1 - p.length * 0.001 : osa(domain, p) * 0.01;
      if (score < bestScore) { best = p; bestScore = score; }
      continue;
    }
    const nameDist = osa(label, pl);
    const fullDist = osa(domain, p);
    const close = (pl.length >= 5 && nameDist <= 2) || (pl.length < 5 && nameDist <= 1) || sameLettersPlusOne(label, pl);
    if (close && fullDist <= 4) {
      const score = 1 + nameDist + fullDist * 0.1;
      if (score < bestScore) { best = p; bestScore = score; }
    }
  }
  return best;
}

/**
 * Returns a corrected address when the one typed is very likely a typo, else
 * null. The local part is kept as typed (minus stray spaces).
 */
export function suggestEmail(raw) {
  const email = String(raw || "").trim().replace(/\s+/g, "");
  if (!email) return null;
  const lower = email.toLowerCase();

  // No "@" at all: "ananyagmail.com" -> "ananya@gmail.com"
  if (!lower.includes("@")) {
    for (const p of POPULAR) {
      if (lower.endsWith(p) && lower.length > p.length) {
        return `${email.slice(0, email.length - p.length)}@${p}`;
      }
    }
    return null;
  }
  const at = lower.lastIndexOf("@");
  const local = email.slice(0, at);
  let domain = lower.slice(at + 1).replace(/^\.+|\.+$/g, "").replace(/\.{2,}/g, ".").replace(/,/g, ".");
  if (!local || !domain || local.includes("@")) return null;
  if (POPULAR_SET.has(domain)) {
    return domain === lower.slice(at + 1) ? null : `${local}@${domain}`;
  }

  // A provider glued onto something: "gmail.comgmail.com", "3333gmail.com",
  // "kushwahaariteshgmail.com". Repeats collapse; anything else most likely
  // belonged before the "@" (ananya@3333gmail.com -> ananya3333@gmail.com).
  for (const p of POPULAR) {
    if (domain.endsWith(p) && domain.length > p.length) {
      const prefix = domain.slice(0, domain.length - p.length);
      if (prefix.endsWith(".")) continue;                    // a real subdomain
      const prefixIsProvider = POPULAR.some(q => prefix === q) || closestProvider(prefix.replace(/\.$/, "")) === p;
      if (prefixIsProvider) return `${local}@${p}`;
      if (/^[a-z0-9._-]+$/.test(prefix)) return `${local}${prefix}@${p}`;
    }
  }

  const best = closestProvider(domain);
  return best ? `${local}@${best}` : null;
}

/**
 * Does the domain exist and accept mail? DNS-over-HTTPS, so it needs no
 * backend. Resolves to "ok" | "nodomain" | "nomx" | "unknown"; anything
 * uncertain is "unknown" and must not block signup.
 */
export async function checkEmailDomain(email, timeoutMs = 3500) {
  const domain = String(email || "").trim().toLowerCase().split("@")[1];
  if (!domain || POPULAR_SET.has(domain)) return "ok";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const q = (type) => fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, {
      headers: { accept: "application/dns-json" }, signal: ctrl.signal,
    }).then(r => (r.ok ? r.json() : null));
    const mx = await q("MX");
    if (!mx) return "unknown";
    if (mx.Status === 3) return "nodomain";                  // NXDOMAIN
    if (mx.Status !== 0) return "unknown";
    if ((mx.Answer || []).some(a => a.type === 15)) return "ok";
    // No MX: mail can still go to the A record (rare, but legal).
    const a = await q("A");
    return a && (a.Answer || []).some(x => x.type === 1) ? "ok" : "nomx";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

/** Where to look for the code: a web inbox link for the big providers. */
export function inboxLinkFor(email) {
  const d = String(email || "").toLowerCase().split("@")[1] || "";
  if (d === "gmail.com" || d === "googlemail.com") {
    return { label: "Open Gmail", href: "https://mail.google.com/mail/u/0/#search/from%3Aaccounts%40stocksaathi.co.in+in%3Aanywhere" };
  }
  if (/^(yahoo|ymail|rocketmail)\./.test(d)) return { label: "Open Yahoo Mail", href: "https://mail.yahoo.com/" };
  if (/^(outlook|hotmail|live|msn)\./.test(d)) return { label: "Open Outlook", href: "https://outlook.live.com/mail/" };
  if (/^(icloud|me|mac)\.com$/.test(d)) return { label: "Open iCloud Mail", href: "https://www.icloud.com/mail" };
  if (d === "rediffmail.com") return { label: "Open Rediffmail", href: "https://mail.rediff.com/" };
  return null;
}
