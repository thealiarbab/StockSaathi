// =============================================================================
// CHAT SESSIONS — Multiple named conversations for the Coach Chat page.
//
// Persistence: single localStorage key "ss.chat.sessions.v1" with shape:
//   { activeId: "<id>", sessions: [{ id, title, messages: [...], createdAt, updatedAt }, ...] }
//
// Migration: on first load of v1, if the legacy single-log key
// "ss.chatlog.v1" exists, its entire history becomes one session so the
// user's previous conversation is preserved — never wiped by the upgrade.
//
// Titles: derived from the first user message (up to 42 chars) the first
// time a message gets sent. Stays "New chat" for empty sessions. Title
// is regenerated from the latest first-user-message after the first one,
// so it stays meaningful even if the user deletes the original prompt.
// =============================================================================

export const SESSIONS_KEY = "ss.chat.sessions.v1";
const LEGACY_LOG_KEY = "ss.chatlog.v1";

function genId() {
  return "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function createBlank() {
  const now = Date.now();
  return {
    id: genId(),
    title: "New chat",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function deriveTitle(messages) {
  if (!Array.isArray(messages)) return "New chat";
  const firstUser = messages.find(m => m && m.role === "user" && typeof m.text === "string" && m.text.trim());
  if (!firstUser) return "New chat";
  const clean = String(firstUser.text).replace(/\s+/g, " ").trim();
  return clean.slice(0, 42) || "New chat";
}

// Load sessions, migrating from legacy single-log if needed. ALWAYS returns
// a valid structure with at least one session.
export function loadSessions() {
  // Path 1: already on v1 — just load.
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.sessions) && data.sessions.length) {
        // Repair: ensure every session has required fields + activeId exists
        data.sessions = data.sessions.filter(s => s && s.id && Array.isArray(s.messages));
        if (!data.sessions.length) data.sessions = [createBlank()];
        if (!data.sessions.find(s => s.id === data.activeId)) {
          data.activeId = data.sessions[0].id;
        }
        return data;
      }
    }
  } catch {}

  // Path 2: legacy migration — pull the old single log into session #1.
  let migratedMessages = null;
  try {
    const legacy = localStorage.getItem(LEGACY_LOG_KEY);
    if (legacy) {
      const arr = JSON.parse(legacy);
      if (Array.isArray(arr) && arr.length) migratedMessages = arr;
    }
  } catch {}

  const firstSession = migratedMessages
    ? {
        id: genId(),
        title: deriveTitle(migratedMessages),
        messages: migratedMessages,
        createdAt: migratedMessages[0]?.ts || Date.now(),
        updatedAt: migratedMessages[migratedMessages.length - 1]?.ts || Date.now(),
      }
    : createBlank();

  const data = { activeId: firstSession.id, sessions: [firstSession] };
  saveSessions(data);
  return data;
}

// Two tabs used to overwrite each other (C17): each holds its own copy and
// wrote the whole envelope back, so the tab that saved last erased the
// other tab's new messages. Every save now merges what is stored first, IN
// PLACE (chat.js holds references to session objects and message arrays
// while a reply streams). Messages match on role + timestamp: the text of
// a streaming reply grows, its ts does not. Deleted sessions and cleared
// chats leave tombstones so a merge cannot bring them back.
const msgKey = (m) => `${m?.role}:${m?.ts}`;

function mergeStored(data) {
  let stored;
  try { stored = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "null"); } catch { return; }
  if (!stored || !Array.isArray(stored.sessions)) return;
  const deleted = new Set([...(data.deleted || []), ...(stored.deleted || [])]);
  data.deleted = [...deleted].slice(-100);
  for (let i = data.sessions.length - 1; i >= 0; i--) {
    if (deleted.has(data.sessions[i]?.id)) data.sessions.splice(i, 1);
  }
  const mine = new Map(data.sessions.map((s) => [s.id, s]));
  for (const other of stored.sessions) {
    if (!other?.id || !Array.isArray(other.messages) || deleted.has(other.id)) continue;
    const s = mine.get(other.id);
    if (!s) { data.sessions.push(other); continue; }        // a chat started in another tab
    const clearedAt = Math.max(s.clearedAt || 0, other.clearedAt || 0);
    if (clearedAt) {
      s.clearedAt = clearedAt;
      for (let i = s.messages.length - 1; i >= 0; i--) {
        if ((s.messages[i]?.ts || 0) <= clearedAt) s.messages.splice(i, 1);
      }
    }
    const have = new Set(s.messages.map(msgKey));
    let added = false;
    for (const m of other.messages) {
      if (!m || (m.ts || 0) <= clearedAt || have.has(msgKey(m))) continue;
      s.messages.push(m);
      added = true;
    }
    if (added) {
      s.messages.sort((a, b) => (a?.ts || 0) - (b?.ts || 0));
      if (!s.title || s.title === "New chat") s.title = deriveTitle(s.messages);
    }
    s.updatedAt = Math.max(s.updatedAt || 0, other.updatedAt || 0);
  }
  if (!data.sessions.length) {
    const blank = createBlank();
    data.sessions.push(blank);
    data.activeId = blank.id;
  } else if (!data.sessions.some((s) => s.id === data.activeId)) {
    data.activeId = data.sessions[0].id;
  }
}

export function saveSessions(data) {
  mergeStored(data);
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(data)); } catch {}
  // v142: no DB push here. Each chat turn is written per-row to
  // coach_messages via logChatTurn → dbAddCoachMessage at send time,
  // and rebuildChatSessionsFromDb rebuilds this envelope on next boot.
  // localStorage is now a cache, not the source of truth.
}

export function getActiveSession(data) {
  return data.sessions.find(s => s.id === data.activeId) || data.sessions[0];
}

export function setActiveSession(data, id) {
  const match = data.sessions.find(s => s.id === id);
  if (!match) return false;
  data.activeId = id;
  saveSessions(data);
  return true;
}

// Create a fresh session and make it active. Returns the new session.
export function createNewSession(data) {
  const s = createBlank();
  data.sessions.unshift(s);
  data.activeId = s.id;
  saveSessions(data);
  return s;
}

// Delete a session by id. If it was active, pick the next one. If it was
// the last one, a fresh empty session replaces it so the UI always has
// something to render.
export function deleteSessionById(data, id) {
  const idx = data.sessions.findIndex(s => s.id === id);
  if (idx === -1) return;
  const wasActive = data.activeId === id;
  data.sessions.splice(idx, 1);
  data.deleted = [...(data.deleted || []), id].slice(-100);   // tombstone, see mergeStored
  if (!data.sessions.length) {
    const blank = createBlank();
    data.sessions = [blank];
    data.activeId = blank.id;
  } else if (wasActive) {
    data.activeId = data.sessions[0].id;
  }
  saveSessions(data);
}

// Call this after every append to the active session's messages. It updates
// the updatedAt timestamp and regenerates the title if it's still "New chat".
export function touchActive(data) {
  const s = getActiveSession(data);
  if (!s) return;
  s.updatedAt = Date.now();
  if (!s.title || s.title === "New chat") {
    s.title = deriveTitle(s.messages);
  }
  saveSessions(data);
}

// Force-rename the active session (e.g. if we want to regenerate title
// after significant edits). Currently unused but exported for future UI.
export function renameActive(data, title) {
  const s = getActiveSession(data);
  if (!s) return;
  s.title = String(title || "").slice(0, 80) || "New chat";
  saveSessions(data);
}

// Clear all messages in the active session (keeps the session, wipes history).
export function clearActiveMessages(data) {
  const s = getActiveSession(data);
  if (!s) return;
  s.messages = [];
  s.title = "New chat";
  s.updatedAt = Date.now();
  s.clearedAt = s.updatedAt;   // tombstone, see mergeStored
  saveSessions(data);
}

// Pretty relative timestamp for the session picker list.
export function formatRelative(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return Math.floor(diff / 60_000) + "m ago";
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + "h ago";
  if (diff < 7 * 86400_000) return Math.floor(diff / 86400_000) + "d ago";
  return new Date(ts).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
