import type { ChatMessage } from "../../types/chat";

/**
 * The 1-based position of each user message among the user messages, with 0 for
 * every other role. It is the stable anchor a version group is keyed on, so a
 * fork keeps pointing at the same turn.
 *
 * Counted in one pass and kept here rather than in the transcript component:
 * the obvious per-row form is a prefix `slice().reduce()`, which is O(n²) and
 * costs nothing at the couple of hundred messages a live session shows — then
 * roughly six million operations per render once a long session's history has
 * been lazily scrolled in, which is precisely when it must not.
 */
export function userMessageOrdinals(messages: Pick<ChatMessage, "role">[]): number[] {
  const out = new Array<number>(messages.length);
  let seen = 0;
  for (let i = 0; i < messages.length; i++) {
    const isUser = messages[i]!.role === "user";
    if (isUser) seen++;
    out[i] = isUser ? seen : 0;
  }
  return out;
}
