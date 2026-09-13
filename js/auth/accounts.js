// =============================================================================
// ACCOUNTS — dual-mode.
//   If Supabase is configured → real auth (email/password, cross-device).
//   Else → localStorage fallback (PBKDF2 hashed, single-device).
// Same public API so pages don't need to know which mode they're in.
// =============================================================================

import { sb, isSupabaseEnabled } from "../db/supabase.js";

// ---------- localStorage fallback (unchanged legacy path) -----------------
const ACCOUNTS_KEY = "ss.accounts.v1";
const SESSION_KEY = "ss.session.v1";
const PBKDF2_ITER = 100_000;
const SALT_BYTES = 16;

function readLocalAccounts() {
  try { const raw = localStorage.getItem(ACCOUNTS_KEY); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}
function writeLocalAccounts(list) { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)); }
function readSession() {
  try { const raw = localStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function writeSession(s) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

function bytesToHex(buf) { return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join(""); }
function hexToBytes(hex) { const a = new Uint8Array(hex.length/2); for (let i=0;i<a.length;i++) a[i]=parseInt(hex.substr(i*2,2),16); return a; }
async function hashPassword(password, saltHex = null) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMat = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" }, keyMat, 256);
  return { hash: bytesToHex(bits), salt: saltHex || bytesToHex(salt) };
}
async function verifyPassword(password, expectedHex, saltHex) {
  const { hash } = await hashPassword(password, saltHex);
  return hash === expectedHex;
}

// ---------- Validation (shared) ------------------------------------------
export function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim()); }
export function validatePassword(pw) {
  // 2026-05-04: dropped the require-letter + require-number rules.
  // Real-world impact: a teacher on mobile reported failures despite
  // "using letters and numbers" — turned out swipe-input + autocorrect
  // were mangling characters and the layered error messages compounded
  // the confusion. Modern password guidance (NIST SP 800-63B 5.1.1.2)
  // explicitly recommends AGAINST composition rules — they push users
  // toward predictable patterns ("Password1") and away from longer
  // unique passwords. We keep the 8-char minimum as the floor.
  if (!pw || pw.length < 8) return "Password must be at least 8 characters.";
  return null;
}
export function validateUsername(u) {
  const s = String(u || "").trim();
  if (s.length < 3) return "Username must be at least 3 characters.";
  if (s.length > 24) return "Username must be at most 24 characters.";
  if (!/^[a-z0-9_.]+$/i.test(s)) return "Only letters, numbers, _ and . allowed.";
  return null;
}

function pickAvatarColor(username) {
  const palette = ["green", "saffron", "purple", "blue"];
  let sum = 0;
  for (let i = 0; i < username.length; i++) sum += username.charCodeAt(i);
  return palette[sum % palette.length];
}

// =========================================================================
// Public API — detects mode at call time
// =========================================================================

export async function registerAccount({ username, email, password, displayName }) {
  // Always normalize: email + username lowercase, trimmed. This is the ONLY
  // identity we ever write to the DB — keeps "Alice" and "alice" as one user.
  const emailN = String(email || "").trim().toLowerCase();
  const usernameN = String(username || "").trim().toLowerCase();
  const displayN = String(displayName || username || "").trim();

  const client = await sb();
  if (client) {
    // --- Pre-checks: fail fast before creating an auth.users row -----------
    // Use the SECURITY DEFINER RPC — under the new locked-down RLS, anon
    // clients can't SELECT from profiles directly, so the old .ilike() call
    // always returned null and never caught duplicate usernames.
    try {
      const { data: match } = await client.rpc("profile_by_username",
        { p_username: usernameN });
      if (Array.isArray(match) && match.length > 0) {
        throw new Error("This username is already taken. Try another.");
      }
    } catch (e) {
      if (/already taken/i.test(e.message)) throw e;
      // Any other error (RPC not yet deployed, network glitch) falls through
      // to Supabase signUp; the server-side handle_new_user trigger auto-
      // appends a number to clashing usernames so the account still creates.
    }

    const avatar_color = pickAvatarColor(usernameN);
    // emailRedirectTo: when the user clicks the link in the confirmation
    // email, Supabase redirects here. The hash includes the access token;
    // Supabase-js's detectSessionInUrl picks it up and signs the user in.
    const redirectBase = (typeof location !== "undefined" && location.origin)
      ? location.origin : "https://stocksaathi.co.in";
    const { data, error } = await client.auth.signUp({
      email: emailN,
      password,
      options: {
        emailRedirectTo: `${redirectBase}/#/register?confirmed=1`,
        data: { username: usernameN, display_name: displayN, avatar_color },
      },
    });
    if (error) throw new Error(prettifySbError(error.message));
    // Supabase's email-collision obfuscation: when the email is already
    // confirmed, signUp returns success with a DECOY user object but an
    // EMPTY identities array AND sends no email. Without this check the
    // UI would show "Check your email" forever while nothing arrives.
    // See: https://supabase.com/docs/reference/javascript/auth-signup
    const identities = data?.user?.identities;
    if (Array.isArray(identities) && identities.length === 0) {
      const err = new Error("An account with this email already exists. Please log in instead.");
      err.code = "email_already_registered";
      throw err;
    }
    const hasSession = !!data.session;
    return {
      id: data.user?.id,
      username: usernameN, email: emailN, displayName: displayN,
      hasSession,
      needsConfirmation: !hasSession,
    };
  }

  // Fallback: local mode
  const accs = readLocalAccounts();
  if (accs.some(a => a.email.toLowerCase() === emailN)) throw new Error("An account with this email already exists. Try logging in.");
  if (accs.some(a => a.username.toLowerCase() === usernameN)) throw new Error("This username is already taken. Try another.");
  const { hash, salt } = await hashPassword(password);
  const account = {
    id: `u_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    username: usernameN, email: emailN, displayName: displayN,
    passwordHash: hash, passwordSalt: salt, createdAt: Date.now(),
    avatarColor: pickAvatarColor(usernameN),
  };
  accs.push(account);
  writeLocalAccounts(accs);
  writeSession({ userId: account.id, startedAt: Date.now() });
  return account;
}

/**
 * Verify the 6-digit OTP code Supabase sends after signup. On success, the
 * user is signed in and we can proceed to onboarding. Throws on bad code.
 */
export async function verifySignupOtp({ email, code }) {
  const client = await sb();
  if (!client) throw new Error("Backend not configured.");
  const emailN = String(email || "").trim().toLowerCase();
  const cleanCode = String(code).trim().replace(/\s+/g, "");
  // Supabase tokens are 6 digits by default. Accept 4-10 for any custom
  // configuration. The old UI demanded exactly 8 which rejected every real
  // code Supabase ever sent.
  if (!/^\d{4,10}$/.test(cleanCode)) {
    throw new Error("Code should be 6 digits (check the latest email from us).");
  }
  // Try all three Supabase OTP types in order: 'email' (newest, works for
  // magic-link-style), 'signup' (classic), 'email_change'. Whichever matches
  // Supabase's template wins.
  const tries = ["email", "signup"];
  let lastErr = null;
  for (const type of tries) {
    const r = await client.auth.verifyOtp({ email: emailN, token: cleanCode, type });
    if (!r.error) return { ok: true, user: r.data?.user, session: r.data?.session };
    lastErr = r.error;
  }
  throw new Error(prettifySbError(lastErr?.message || "Invalid or expired code."));
}

/**
 * Resend the signup OTP. Useful if the first email got lost.
 */
export async function resendSignupOtp(email) {
  const client = await sb();
  if (!client) throw new Error("Backend not configured.");
  const emailN = String(email || "").trim().toLowerCase();
  const { error } = await client.auth.resend({ type: "signup", email: emailN });
  if (error) throw new Error(prettifySbError(error.message));
  return { ok: true };
}

/**
 * Send a password-reset email. The link in the email brings the user back
 * to /#/reset-password with a recovery session embedded in the URL hash;
 * Supabase-js's detectSessionInUrl picks it up so setNewPassword() can
 * call auth.updateUser({ password }) without a separate verify step.
 */
export async function requestPasswordReset(email) {
  const client = await sb();
  if (!client) throw new Error("Backend not configured.");
  const emailN = String(email || "").trim().toLowerCase();
  if (!_EMAIL_RE().test(emailN)) throw new Error("Enter a valid email address.");
  const redirectBase = (typeof location !== "undefined" && location.origin)
    ? location.origin : "https://stocksaathi.co.in";
  const { error } = await client.auth.resetPasswordForEmail(emailN, {
    redirectTo: `${redirectBase}/#/reset-password`,
  });
  if (error) throw new Error(prettifySbError(error.message));
  // Supabase silently no-ops for non-existent emails (same enumeration
  // defence as signup). That's fine — UI should claim success regardless
  // so attackers can't probe valid addresses.
  return { ok: true };
}

/**
 * After the recovery link opens the app, Supabase-js parses the hash and
 * establishes a PASSWORD_RECOVERY session. Calling updateUser here
 * replaces the password and keeps the session — no re-login needed.
 */
export async function setNewPassword(newPassword) {
  const client = await sb();
  if (!client) throw new Error("Backend not configured.");
  const perr = validatePassword(newPassword);
  if (perr) throw new Error(perr);
  const { data: s } = await client.auth.getSession();
  if (!s?.session?.access_token) {
    throw new Error("Reset link has expired. Request a new one from the login page.");
  }
  const { error } = await client.auth.updateUser({ password: newPassword });
  if (error) throw new Error(prettifySbError(error.message));
  return { ok: true };
}

function _EMAIL_RE() { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/; }

export async function loginAccount({ emailOrUsername, password }) {
  const q = String(emailOrUsername || "").trim().replace(/^@/, "").toLowerCase();
  if (!q) throw new Error("Enter your email or username.");
  if (!password) throw new Error("Enter your password.");

  const client = await sb();
  if (client) {
    // Resolve to email. If input contains '@', treat as email directly.
    // Otherwise use the server-side resolver (service_role) — anon RLS on
    // the profiles table blocks us from SELECTing another user's email
    // column, which is why direct client queries were 100% returning
    // "No account with that username" for any valid username. The
    // resolver endpoint does the lookup safely.
    let email = q;
    if (!q.includes("@")) {
      try {
        const res = await fetch("/api/ai?op=auth-resolve-username", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: q }),
        });
        if (res.status === 404) throw new Error("No account with that username.");
        if (!res.ok) throw new Error("Couldn't look up that username. Try your email instead.");
        const data = await res.json();
        if (!data?.email) throw new Error("No account with that username.");
        email = data.email;
      } catch (e) {
        if (e.message) throw e;
        throw new Error("Couldn't look up that username. Try your email instead.");
      }
    }
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(prettifySbError(error.message));
    return { id: data.user?.id, email };
  }

  // Fallback: local
  const accs = readLocalAccounts();
  const acc = accs.find(a => a.email.toLowerCase() === q || a.username.toLowerCase() === q);
  if (!acc) throw new Error("No account with that email or username.");
  const ok = await verifyPassword(password, acc.passwordHash, acc.passwordSalt);
  if (!ok) throw new Error("Incorrect password.");
  writeSession({ userId: acc.id, startedAt: Date.now() });
  return acc;
}

// LOGOUT — hardened 2026-05-05 after user report "LOGOUT DOESNT WORK".
// Five parallel agents traced it to four compounding issues:
//   1. _cachedUser was never nulled here (only deleteCurrentAccount did).
//      Synchronous currentUser() callers kept seeing the old user.
//   2. ss.sb.session.v1 in localStorage could survive signOut() under
//      GoTrue lock-deadlock conditions (sync.js:17-23 documents this).
//   3. autoRefreshToken can race against signOut and write a fresh
//      token AFTER signOut tried to remove it.
//   4. Click handlers were not awaiting this promise (fixed in nav.js
//      and settings.js separately) — but even when they did, the cache
//      bug above defeated them.
// Fix order matters: clear in-memory cache FIRST so any synchronous
// re-read returns null immediately. Then race the network signOut
// against a 3s timeout (Supabase signOut can hang under network
// flakiness — better to lose the server-side session destroy than
// strand the user logged in client-side). Finally, defensively
// removeItem the storage key to defeat any auto-refresh that wrote
// a token while we were waiting.
export async function logoutAccount() {
  // 1. Null caches synchronously — any re-render between now and the
  //    next tick will see no user.
  _cachedUser = null;
  try { writeSession(null); } catch {}

  // 2. Network signOut, raced against a 3s timeout.
  const client = await sb();
  if (client) {
    try {
      await Promise.race([
        client.auth.signOut(),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch {
      // Swallow — we're forcibly logging out client-side regardless.
    }
  }

  // 3. Defensive cleanup — even if signOut "succeeded" the storage
  //    key may have been re-written by an in-flight token refresh.
  try {
    localStorage.removeItem("ss.sb.session.v1");
  } catch {}

  // 4. Drop the cached coach transcripts. They are plain localStorage keys
  //    with no user scoping, and `/chat` is a PUBLIC route — so leaving them
  //    behind meant a signed-out browser still displayed the last person's
  //    full conversation with the coach: their portfolio figures, what they
  //    were worried about, everything they asked. On a shared laptop or a
  //    school machine that is a straight privacy leak, and these users are
  //    13-18. The server copy in coach_messages is untouched and re-hydrates
  //    on the next sign-in.
  try {
    const { clearChatCaches } = await import("../db/sync.js");
    clearChatCaches();
  } catch (e) {
    // Never let this block logout — fall back to removing the keys directly.
    try { localStorage.removeItem("ss.chat.sessions.v1"); } catch {}
    try { localStorage.removeItem("ss.coachchat.v1"); } catch {}
    try { localStorage.removeItem("ss.chat.owner.v1"); } catch {}
  }
}

/**
 * SYNCHRONOUS check of the currently logged-in user.
 * Callers throughout the app use this — we cache the latest user in memory.
 */
let _cachedUser = null;
let _cachedAt = 0;

// Hotfix41: setter so completeOnboarding (in state.js) can patch the
// cached user object the moment local state flips. Without this, the
// router's getState() reads _cachedUser.onboarded=false (still the
// pre-completion DB value, since updateProfile is async and hasn't
// resolved) and bounces the just-onboarded user back to /onboarding.
// patchCachedUser does NOT trigger a refresh â€” it just edits the
// cached fields in place. The async DB write still flows through
// updateProfile().
export function patchCachedUser(patch) {
  if (!_cachedUser || !patch) return;
  _cachedUser = { ..._cachedUser, ...patch };
}

export function currentUser() {
  // Fast path: async refreshCurrentUser already filled the cache.
  if (_cachedUser) return _cachedUser;

  // Supabase mode: try to reconstruct the user SYNCHRONOUSLY from the
  // persisted session token. Without this, hard-reload kicks logged-in
  // users to /login during the ~300ms window before the async
  // refreshCurrentUser resolves — because the router calls currentUser()
  // at render time and gets null.
  if (_supabaseConfiguredSync()) {
    const sync = _readSupabaseSessionSync();
    if (sync) return sync;
    return null;
  }

  // Pure local mode (no Supabase configured anywhere) — legacy path.
  const sess = readSession();
  if (!sess) return null;
  const accs = readLocalAccounts();
  const acc = accs.find(a => a.id === sess.userId);
  if (!acc) { writeSession(null); return null; }
  const { passwordHash, passwordSalt, ...safe } = acc;
  return safe;
}

// Reads ss.sb.session.v1 synchronously and returns a minimal user object
// good enough for router guards. refreshCurrentUser() replaces this with
// the full profile (school, classCode, age, riskProfile, onboarded) as
// soon as the DB call resolves.
function _readSupabaseSessionSync() {
  try {
    const raw = localStorage.getItem("ss.sb.session.v1");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Supabase-js stores in two possible shapes depending on version.
    const sess = parsed?.currentSession || parsed;
    const u = sess?.user || parsed?.user;
    if (!u?.id) return null;
    // Also check the access_token hasn't already expired (unix seconds).
    const expSec = sess?.expires_at;
    if (expSec && Number.isFinite(expSec) && Date.now() / 1000 > expSec) return null;
    const meta = u.user_metadata || {};
    return {
      id: u.id,
      email: u.email,
      username: meta.username || (u.email?.split("@")[0] || "user"),
      displayName: meta.display_name || meta.username || "User",
      avatarColor: meta.avatar_color || "green",
      // Unknown until refreshCurrentUser fetches profile — assume true so
      // the user doesn't get bounced to /onboarding on every reload. The
      // async refresh will correct this within a few hundred ms.
      onboarded: true,
      _pendingRefresh: true,
    };
  } catch {
    return null;
  }
}

// Synchronous "is Supabase configured?" check. Critical for the first call
// to currentUser() before refreshCurrentUser has run — otherwise we'd fall
// through to legacy local mode and the router would route authed users
// based on a missing local session → /login on every hard-reload.
let _supabaseConfiguredCache = null;
function _supabaseConfiguredSync() {
  if (_supabaseConfiguredCache != null) return _supabaseConfiguredCache;
  try {
    if (typeof window !== "undefined" && window._ss_supabaseConfigured != null) {
      _supabaseConfiguredCache = !!window._ss_supabaseConfigured;
      return _supabaseConfiguredCache;
    }
    // Strong sync signal: a persisted Supabase session means the user has
    // logged in via Supabase at least once, so Supabase mode is definitely
    // live. Don't cache yet — let refreshCurrentUser make it authoritative.
    if (localStorage.getItem("ss.sb.session.v1")) return true;
  } catch {}
  return false;
}

/**
 * ASYNC — refreshes the current-user cache from Supabase (or local).
 * Call on boot + after any auth mutation.
 */
export async function refreshCurrentUser() {
  const client = await sb();
  // Set the sync flag so currentUser() knows Supabase mode is live without
  // another round-trip. Also wipe legacy localStorage keys so a ghost local
  // session can't slip back in between tabs.
  if (client) {
    try {
      window._ss_supabaseConfigured = true;
      _supabaseConfiguredCache = true;
      // Clear legacy fallback sessions — they cause "not logged in" errors
      // on every Supabase RPC when the Supabase session is missing/expired.
      localStorage.removeItem("ss.session.v1");
      localStorage.removeItem("ss.accounts.v1");
    } catch {}
    // 5-s timeout on getUser — same GoTrue _acquireLock deadlock concern
    // documented in sync.js. If auth is stuck, return the existing cached
    // user (if any) so callers that await refreshCurrentUser() can still
    // proceed with a best-effort cached identity rather than hanging
    // forever. DO NOT null out _cachedUser on timeout — that would look
    // like a logout to downstream consumers.
    let u;
    try {
      const getUserP = client.auth.getUser();
      const timeoutP = new Promise((_, rej) =>
        setTimeout(() => rej(new Error("refreshCurrentUser_timeout")), 5000));
      const { data: userData } = await Promise.race([getUserP, timeoutP]);
      u = userData?.user;
    } catch (e) {
      console.warn("[accounts] refreshCurrentUser getUser failed:", e?.message || e);
      return _cachedUser;   // return cached if any; never null on timeout
    }
    if (!u) { _cachedUser = null; return null; }
    const { data: profile } = await client.from("profiles").select("*").eq("id", u.id).maybeSingle();
    if (!profile) {
      _cachedUser = {
        id: u.id, email: u.email, username: u.email?.split("@")[0] || "user",
        displayName: u.user_metadata?.display_name || "User",
        avatarColor: u.user_metadata?.avatar_color || "green",
      };
      return _cachedUser;
    }
    _cachedUser = {
      id: profile.id,
      username: profile.username,
      displayName: profile.display_name,
      email: profile.email,
      avatarColor: profile.avatar_color,
      school: profile.school,
      classCode: profile.class_code,
      age: profile.age,
      riskProfile: profile.risk_profile,
      onboarded: profile.onboarded,
      createdAt: profile.created_at,
      _supabase: true,
    };
    _cachedAt = Date.now();
    return _cachedUser;
  }

  // Local fallback
  const sess = readSession();
  if (!sess) { _cachedUser = null; return null; }
  const accs = readLocalAccounts();
  const acc = accs.find(a => a.id === sess.userId);
  if (!acc) { _cachedUser = null; writeSession(null); return null; }
  const { passwordHash, passwordSalt, ...safe } = acc;
  _cachedUser = safe;
  return safe;
}

export async function updateProfile(patch) {
  const client = await sb();
  if (client) {
    const user = await (await client.auth.getUser()).data?.user;
    if (!user) throw new Error("Not logged in.");
    const dbPatch = {};
    const map = {
      displayName: "display_name", school: "school", classCode: "class_code",
      city: "city", age: "age", riskProfile: "risk_profile",
      onboarded: "onboarded",
    };
    for (const [k, v] of Object.entries(patch || {})) {
      if (map[k]) dbPatch[map[k]] = v;
    }
    dbPatch.updated_at = new Date().toISOString();
    const { error } = await client.from("profiles").update(dbPatch).eq("id", user.id);
    if (error) throw new Error(error.message);
    await refreshCurrentUser();
    return _cachedUser;
  }
  // Local fallback — update accounts.js compatible
  const sess = readSession();
  if (!sess) throw new Error("Not logged in.");
  const accs = readLocalAccounts();
  const idx = accs.findIndex(a => a.id === sess.userId);
  if (idx === -1) throw new Error("Account not found.");
  accs[idx] = { ...accs[idx], ...patch, updatedAt: Date.now() };
  writeLocalAccounts(accs);
  const { passwordHash, passwordSalt, ...safe } = accs[idx];
  _cachedUser = safe;
  return safe;
}

export async function changePassword({ currentPassword, newPassword }) {
  const client = await sb();
  if (client) {
    // Supabase requires re-auth for security; use updateUser — signed-in user only
    const { error } = await client.auth.updateUser({ password: newPassword });
    if (error) throw new Error(error.message);
    return true;
  }
  // Local
  const sess = readSession();
  if (!sess) throw new Error("Not logged in.");
  const accs = readLocalAccounts();
  const idx = accs.findIndex(a => a.id === sess.userId);
  if (idx === -1) throw new Error("Account not found.");
  const ok = await verifyPassword(currentPassword, accs[idx].passwordHash, accs[idx].passwordSalt);
  if (!ok) throw new Error("Current password is incorrect.");
  const { hash, salt } = await hashPassword(newPassword);
  accs[idx].passwordHash = hash; accs[idx].passwordSalt = salt;
  writeLocalAccounts(accs);
  return true;
}

export async function deleteCurrentAccount() {
  const client = await sb();
  if (client) {
    // Supabase doesn't allow client-side delete of auth user; sign out + flag profile
    try {
      const user = await (await client.auth.getUser()).data?.user;
      if (user) await client.from("profiles").update({ onboarded: false }).eq("id", user.id);
    } catch {}
    await client.auth.signOut();
    _cachedUser = null;
    return;
  }
  const sess = readSession();
  if (!sess) return;
  let accs = readLocalAccounts();
  accs = accs.filter(a => a.id !== sess.userId);
  writeLocalAccounts(accs);
  writeSession(null);
  _cachedUser = null;
}

/**
 * List user handles for friend-search — works in BOTH modes.
 */
export async function listAccountsPublic() {
  const client = await sb();
  if (client) {
    const { data } = await client.from("profiles")
      .select("id, username, display_name, email, avatar_color, school")
      .limit(200);
    return (data || []).map(r => ({
      id: r.id, username: r.username, displayName: r.display_name,
      email: r.email, avatarColor: r.avatar_color, school: r.school,
    }));
  }
  return readLocalAccounts().map(a => ({
    id: a.id, username: a.username, displayName: a.displayName,
    email: a.email, avatarColor: a.avatarColor, school: a.school,
  }));
}

export async function findAccountByHandle(handleOrEmail) {
  const client = await sb();
  const q = handleOrEmail.trim().toLowerCase();
  if (client) {
    // Try both username and email
    const { data } = await client.from("profiles")
      .select("id, username, display_name, email, avatar_color, school")
      .or(`username.ilike.${q},email.ilike.${q}`)
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    return {
      id: data.id, username: data.username, displayName: data.display_name,
      email: data.email, avatarColor: data.avatar_color, school: data.school,
    };
  }
  return readLocalAccounts().find(a =>
    a.username.toLowerCase() === q || a.email.toLowerCase() === q
  );
}

function prettifySbError(msg) {
  if (!msg) return "Something went wrong.";
  if (/already registered/i.test(msg) || /user already/i.test(msg)) return "An account with this email already exists. Try logging in.";
  if (/invalid login/i.test(msg)) {
    // 2026-05-04: bare "Incorrect email or password." gives no hint why,
    // and on mobile the most common silent culprit is auto-capitalised
    // first letter (autocorrect) or autofill capitalisation. Explicitly
    // cue the user toward the things that are usually wrong.
    return "Incorrect email or password. Passwords are case-sensitive — if you're on mobile, check that your keyboard didn't auto-capitalise the first letter. Tap the eye icon to verify what you typed.";
  }
  if (/invalid email/i.test(msg)) return "That email doesn't look valid.";
  if (/password should be/i.test(msg)) return "Password must be at least 6 characters.";
  if (/rate limit/i.test(msg) || /too many requests/i.test(msg)) return "Too many signups from this address. Wait a few minutes and try again — or turn off email confirmation in Supabase (Authentication → Providers → Email).";
  if (/email.*disabled/i.test(msg)) return "Email signups are disabled in your Supabase project. Enable them in Authentication → Providers → Email.";
  return msg;
}

// Export the backward-compat synchronous signatures used by pages
export function listAccountsPublicSync() {
  if (_cachedUser?._supabase) return [];
  return readLocalAccounts().map(a => ({
    id: a.id, username: a.username, displayName: a.displayName,
    email: a.email, avatarColor: a.avatarColor, school: a.school,
  }));
}
