import type { ChatMessage } from "../../types/chat";

/** Simple deterministic hash of a jsonlPath → short prefix (non-cryptographic). */
function hashPath(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * Prefix pre-compact message IDs so they don't collide with current-session IDs.
 * React keys rely on `id`; collisions cause render corruption.
 */
export function prefixPreCompactIds(msgs: ChatMessage[], jsonlPath: string): ChatMessage[] {
  const prefix = `pc-${hashPath(jsonlPath)}-`;
  return msgs.map((m) => (m.id ? { ...m, id: `${prefix}${m.id}` } : m));
}

/**
 * Flatten messages with expansions prepended before their corresponding compact message.
 * Key of `expansions` = compact message id. Values = already-prefixed ChatMessage[].
 * Preserves reference equality when expansions is empty (zero-cost for non-compact chats).
 */
export function flattenWithExpansions(
  messages: ChatMessage[],
  expansions: Map<string, ChatMessage[]>,
): ChatMessage[] {
  if (expansions.size === 0) return messages;
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const pre = m.id ? expansions.get(m.id) : undefined;
    if (pre && pre.length > 0) out.push(...pre);
    out.push(m);
  }
  return out;
}
