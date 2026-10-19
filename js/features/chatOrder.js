// =============================================================================
// CHAT ORDER — one rule for the order of chat messages, used by every path
// that stores, merges or rebuilds a chat.
//
// Why this exists (19 Oct): replies were showing ABOVE their own question.
//   1. logChatTurn wrote the question row and the reply row to coach_messages
//      in parallel. Each took the server's now() as created_at, and the reply
//      often landed first (by 16 ms in one chat).
//   2. The boot rebuild sorted those rows by created_at: reply, question.
//   3. A command reply was stamped in the same millisecond as its question,
//      so any sort could flip the pair.
// Now every message gets a timestamp strictly after the one before it
// (nextTs), rows carry the client's ts (payload.ts), ties sort the question
// first (byTurn), and stored chats already flipped are put back
// (repairTurnOrder).
// =============================================================================

/** A timestamp later than every message in `list` (and not before now). */
export function nextTs(list) {
  let last = 0;
  for (const m of list || []) if (m?.ts > last) last = m.ts;
  return Math.max(Date.now(), last + 1);
}

/** Sort comparator: by time, and a question before its answer on a tie. */
export function byTurn(a, b) {
  const d = (a?.ts || 0) - (b?.ts || 0);
  if (d) return d;
  return (a?.role === "user" ? 0 : 1) - (b?.role === "user" ? 0 : 1);
}

/**
 * Put back question/answer pairs stored the wrong way round: an answer
 * directly followed, within 2 s, by a question it cannot be answering
 * (the message before it is not a question). Mutates `messages` in place and
 * returns true when anything moved. A user cannot read an answer and send a
 * new question inside 2 s, so a real "answer, then next question" is safe.
 * Timestamps are left alone: merges match messages by role + ts, and a
 * changed ts made the old copy look new, so it came back as a duplicate.
 * Run it after every sort(byTurn), which would undo it for a reply stamped
 * before its question.
 */
export function repairTurnOrder(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return false;
  let moved = false;
  for (let i = 0; i < messages.length - 1; i++) {
    const a = messages[i], q = messages[i + 1];
    if (a?.role !== "assistant" || q?.role !== "user") continue;
    if (Math.abs((q.ts || 0) - (a.ts || 0)) > 2000) continue;
    if (i > 0 && messages[i - 1]?.role === "user") continue;
    messages[i] = q;
    messages[i + 1] = a;
    moved = true;
    i++;
  }
  return moved;
}
