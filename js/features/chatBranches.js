// =============================================================================
// CHAT BRANCHES — edit a question or regenerate an answer without losing the
// old version, like ChatGPT's ‹ 1/2 › arrows.
//
// A chat is a flat array (the branch on screen). A message that has been
// edited or regenerated is a BRANCH POINT: it carries
//   vers: [[msg, ...rest], [msg, ...rest], ...]   every version, from that
//                                                 message to the end
//   vi:   index of the version on screen
// The on-screen version's slot in `vers` is refreshed whenever the user moves
// away from it, so nothing typed after a fork is lost. Versions can nest: a
// tail stored in `vers` keeps its own branch points.
//
// Pure functions over plain arrays; no DOM, no storage. Mutate in place,
// because chat.js holds references to the array while a reply streams.
// =============================================================================

/** The message without its branch bookkeeping. */
export function stripVers(m) {
  if (!m || typeof m !== "object") return m;
  const { vers, vi, ...rest } = m;
  return rest;
}

/** { n, cur } (cur is 1-based) when log[i] has more than one version, else null. */
export function branchInfo(log, i) {
  const m = log?.[i];
  if (!m || !Array.isArray(m.vers) || m.vers.length < 2) return null;
  const vi = Number.isInteger(m.vi) ? m.vi : 0;
  return { n: m.vers.length, cur: vi + 1 };
}

/**
 * Replace log[i..] with a new branch that starts with `newHead`. The current
 * log[i..] is kept as a version. Returns the messages that left the screen
 * (for merge tombstones).
 */
export function forkAt(log, i, newHead) {
  if (!Array.isArray(log) || i < 0 || i >= log.length) return [];
  const head = log[i];
  const removed = log.slice(i);
  const vers = Array.isArray(head.vers) && head.vers.length ? head.vers.slice() : [];
  const vi = Number.isInteger(head.vi) && vers.length ? head.vi : 0;
  vers[vi] = [stripVers(head), ...log.slice(i + 1)];
  vers.push([stripVers(newHead)]);
  log.splice(i, log.length - i, { ...stripVers(newHead), vers, vi: vers.length - 1 });
  return removed;
}

/**
 * Show version `target` (0-based) of the branch point at log[i]. Returns the
 * messages that left the screen, or [] when nothing changed.
 */
export function showVersion(log, i, target) {
  const head = log?.[i];
  if (!head || !Array.isArray(head.vers) || head.vers.length < 2) return [];
  const vi = Number.isInteger(head.vi) ? head.vi : 0;
  const ni = Math.max(0, Math.min(head.vers.length - 1, target));
  if (ni === vi) return [];
  const vers = head.vers.slice();
  const removed = log.slice(i);
  vers[vi] = [stripVers(head), ...log.slice(i + 1)];
  const [nh, ...rest] = vers[ni];
  log.splice(i, log.length - i, { ...stripVers(nh), vers, vi: ni }, ...rest);
  return removed;
}

/** Every message on screen and in every stored version (for search, export). */
export function allMessages(log) {
  const out = [];
  const walk = (arr) => {
    for (const m of arr || []) {
      out.push(stripVers(m));
      // Versions other than the one on screen (that one IS the rest of `arr`).
      if (Array.isArray(m?.vers)) m.vers.forEach((v, j) => { if (j !== (m.vi ?? 0)) walk(v); });
    }
  };
  walk(log);
  return out;
}

/** Keys of messages that must not come back through a cross-tab merge. */
export const msgKey = (m) => `${m?.role}:${m?.ts}`;
