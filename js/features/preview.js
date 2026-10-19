// Owner previews. Features still being built ship to admin accounts first
// (public.admin_users + is_admin(), 2026-10-19) and reach everyone once the
// owner approves them. The flag only decides what the page offers; anything
// the server must protect checks is_admin() itself.
import { getState } from "../state.js";

export function isPreview() {
  try { return !!getState()?.user?.isAdmin; } catch { return false; }
}
