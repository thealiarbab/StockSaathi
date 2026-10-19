// =============================================================================
// CHAT PROJECTS — named groups of coach chats, like ChatGPT projects (owner
// preview). A project has a name and optional instructions Saathi follows in
// every chat inside it ("I'm studying banks for a school project, keep it
// simple"). A chat's project is session.folder = project id, stored on the
// thread (chat_threads.folder). The list lives in localStorage and in
// public.chat_projects (migration 2026-10-19e); removing one sets `removed`.
// =============================================================================

import { sb } from "../db/supabase.js";

const KEY = "ss.chat.projects.v1";

function read() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
}

/** Live projects, oldest first. */
export function listProjects() {
  return read().filter((p) => p && p.id && !p.removed);
}
export function getProject(id) {
  return id ? listProjects().find((p) => p.id === id) || null : null;
}

async function push(p) {
  try {
    const client = await sb();
    if (!client) return;
    const { error } = await client.from("chat_projects").upsert({
      id: p.id, name: p.name, instructions: p.instructions || "", removed: !!p.removed,
      created_at: new Date(p.createdAt).toISOString(), updated_at: new Date(p.updatedAt).toISOString(),
    }, { onConflict: "id" });
    if (error) console.warn("[chat-projects] save failed:", error.message);
  } catch (e) { console.warn("[chat-projects] save failed:", e?.message || e); }
}

function save(p) {
  const list = read();
  const i = list.findIndex((x) => x.id === p.id);
  p.updatedAt = Date.now();
  if (i >= 0) list[i] = p; else list.push(p);
  write(list);
  push(p);
  return p;
}

const clean = (name) => String(name || "").replace(/\s+/g, " ").trim().slice(0, 60);

export function createProject(name) {
  const n = clean(name);
  if (!n) return null;
  const now = Date.now();
  return save({ id: "p_" + now.toString(36) + Math.random().toString(36).slice(2, 6), name: n, instructions: "", createdAt: now, updatedAt: now });
}
export function renameProject(id, name) {
  const p = read().find((x) => x.id === id), n = clean(name);
  if (p && n) save({ ...p, name: n });
}
export function setInstructions(id, text) {
  const p = read().find((x) => x.id === id);
  if (p) save({ ...p, instructions: String(text || "").trim().slice(0, 1500) });
}
export function removeProject(id) {
  const p = read().find((x) => x.id === id);
  if (p) save({ ...p, removed: true });
}

/** Merge the cloud list in (newest edit wins). Returns true when it changed. */
export async function syncProjects() {
  try {
    const client = await sb();
    if (!client) return false;
    const { data, error } = await client.from("chat_projects")
      .select("id,name,instructions,removed,created_at,updated_at").order("created_at").limit(200);
    if (error || !Array.isArray(data)) return false;
    const list = read();
    const byId = new Map(list.map((p) => [p.id, p]));
    let changed = false;
    for (const r of data) {
      const cloud = { id: r.id, name: r.name, instructions: r.instructions || "", removed: !!r.removed,
        createdAt: Date.parse(r.created_at) || Date.now(), updatedAt: Date.parse(r.updated_at) || Date.now() };
      const local = byId.get(r.id);
      if (!local) { list.push(cloud); changed = true; }
      else if (cloud.updatedAt > (local.updatedAt || 0)) { Object.assign(local, cloud); changed = true; }
      else if ((local.updatedAt || 0) > cloud.updatedAt + 1000) push(local);
    }
    const cloudIds = new Set(data.map((r) => r.id));
    for (const p of list) if (!cloudIds.has(p.id)) push(p);
    if (changed) write(list);
    return changed;
  } catch { return false; }
}

/** System-prompt block for a chat inside a project ("" otherwise). */
export function projectNote(folderId) {
  const p = getProject(folderId);
  if (!p) return "";
  const ins = (p.instructions || "").trim();
  return `

# THIS CHAT'S PROJECT
This chat is in the user's project "${p.name}".` + (ins ? ` The user's instructions for chats in this project (follow them unless they conflict with your rules above):
${ins}` : "");
}
