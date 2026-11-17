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
import type { ChatEvent, ChatMessage } from "../../types/chat";

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

/**
 * The ids of the messages a replay will take off the list: the answer it is about to rebuild.
 * While the replay is still being rebuilt those messages stay on screen, so nothing aimed at the
 * transcript (a late child of an Agent card, a background agent's status) may land in them — it
 * would be thrown away with them at the swap.
 */
export function replayReplacedIds(
  prev: readonly ChatMessage[],
  userMessage: string | null,
  clientMessageId: string | undefined,
): Set<string> {
  const kept = new Set(replayActiveTurn(prev, userMessage, clientMessageId).map((m) => m.id));
  return new Set(prev.filter((m) => !kept.has(m.id)).map((m) => m.id));
}

/** What a replay rebuilt: the running answer, plus errors that came while there was none yet. */
export interface ReplayedTurn {
  content: string;
  events: ChatEvent[];
  account: Pick<ChatMessage, "accountId" | "accountLabel"> | null;
  /** Errors raised before the answer had anything in it: drawn on their own, as live. */
  standaloneErrors: ChatMessage[];
}

/**
 * The list once a replay has been rebuilt, in one step: the running answer the list showed is
 * swapped for the rebuilt one. Taking the old answer off first and drawing the new one as it was
 * rebuilt left the list ending on the reader's own message for as long as the rebuild took — at
 * the bottom of the chat, a jump back to the previous message.
 */
export function commitReplayedTurn(
  prev: readonly ChatMessage[],
  userMessage: string | null,
  clientMessageId: string | undefined,
  rebuilt: ReplayedTurn,
  now: () => number = Date.now,
): ChatMessage[] {
  const out = [...replayActiveTurn(prev, userMessage, clientMessageId, now), ...rebuilt.standaloneErrors];
  if (!rebuilt.content && rebuilt.events.length === 0) return out;
  out.push({
    id: `streaming-${now()}`,
    role: "assistant" as const,
    content: rebuilt.content,
    events: rebuilt.events,
    timestamp: new Date(now()).toISOString(),
    ...rebuilt.account,
  });
  return out;
}
