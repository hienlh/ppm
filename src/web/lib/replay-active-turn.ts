/**
 * The live list as a reconnect's `turn_events` replay leaves it: the running turn is rebuilt from
 * the replayed events, so whatever of it the list already shows is cleared first.
 *
 * - The list ends with the turn's own prompt and its answer so far (a history copy, or the
 *   optimistic bubble this tab sent): the answer goes and the prompt stays — the same message,
 *   not a copy. It carries the ids its turn is found by: `clientId`, which `turn_started` binds to
 *   the turn, and the `turnId` history stamped. A copy without them left Copy turn link waiting on
 *   a binding that could never match it.
 * - Otherwise only an answer still streaming goes, and the prompt is added with the id the server
 *   says it was sent under (`clientMessageId`), so a tab that never saw the send binds it as well.
 *
 * A completed earlier turn (a different prompt) is left as it is.
 */
import type { ChatMessage } from "../../types/chat";

export function replayActiveTurn(
  prev: readonly ChatMessage[],
  userMessage: string | null,
  clientMessageId: string | undefined,
  now: () => number = Date.now,
): ChatMessage[] {
  let updated = [...prev];
  let k = updated.length;
  while (k > 0 && updated[k - 1]!.role === "assistant") k--;
  if (userMessage != null && k > 0 && updated[k - 1]!.role === "user" && updated[k - 1]!.content === userMessage) {
    updated = updated.slice(0, k);
  } else {
    const last = updated[updated.length - 1];
    if (last?.role === "assistant" && last.id.startsWith("streaming-")) updated = updated.slice(0, -1);
  }
  if (!userMessage) return updated;
  const lastAfter = updated[updated.length - 1];
  if (lastAfter?.role === "user" && lastAfter.content === userMessage) {
    if (clientMessageId && !lastAfter.clientId) updated[updated.length - 1] = { ...lastAfter, clientId: clientMessageId };
    return updated;
  }
  return [...updated, {
    id: `user-replay-${now()}`,
    role: "user" as const,
    content: userMessage,
    timestamp: new Date(now()).toISOString(),
    ...(clientMessageId ? { clientId: clientMessageId } : {}),
  }];
}
