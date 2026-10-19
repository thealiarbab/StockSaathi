// Owner previews. Features still being built ship to admin accounts first
// (public.admin_users + is_admin(), 2026-10-19) and reach everyone once the
// owner approves them. The flag only decides what the page offers; anything
// the server must protect checks is_admin() itself.
//
// 19 Oct: the coach chat preview (commands and cards, the guide, charts in
// answers, edit / regenerate / versions, projects, share links) was approved
// for everyone, signed out included. Features that need an account (cloud
// history, sharing, projects sync) fail quietly without one. Gate the next
// preview with isOwner().
import { getState } from "../state.js";

export function isPreview() {
  return true;
}

/** Owner accounts only (for the next preview). */
export function isOwner() {
  try { return !!getState()?.user?.isAdmin; } catch { return false; }
}
