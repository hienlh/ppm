/**
 * Unlinking a session hides it from one chat's Sessions list. It never stops or deletes anything:
 * links are derived from the transcript and the server's live links, so "unlinked" is a separate
 * record — per chat, which linked session was hidden and when — filtered out on top.
 *
 * A hidden session comes back on its own when it messages this chat again after it was hidden, and
 * whenever it is running or waits on the person, so a reply or a request is never missed behind an
 * unlink. For the same reason only a session that has finished can be hidden.
 *
 * "After it was hidden" is measured on the server's clock: an unlink records the time of the last
 * message that session had sent here (0 when none), never this device's clock, so a device whose
 * clock runs fast or slow cannot hide a later reply or undo an unlink by itself.
 *
 * Pure, so the rules are tested without the stores; the record itself is a synced UI pref, which
 * is why it lives in `shared`: the server validates what it is sent with `isUnlinkMap`.
 */
import { decodeMessageBlocks } from "./chat-message-blocks";
import type { ChatMessage } from "../types/chat";

/** Chat session id → linked session id → when it was unlinked (epoch ms). */
export type UnlinkMap = Record<string, Record<string, number>>;

/** Chats remembered at most; the oldest unlink falls off first. */
export const MAX_UNLINK_CHATS = 300;
/** Hidden sessions remembered per chat. */
export const MAX_UNLINKS_PER_CHAT = 200;

/** Idle and finished sessions can be hidden; one still working or waiting on the person cannot. */
export function canUnlink(status: "running" | "idle" | "needs_approval" | "new_message"): boolean {
  return status === "idle" || status === "new_message";
}

/** When each session last messaged this chat, from the messages it sent here. */
export function lastMessageFrom(messages: readonly ChatMessage[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of messages) {
    if (m.role !== "user") continue;
    const from = decodeMessageBlocks(m.content).fromSession;
    if (!from) continue;
    const at = Date.parse(from.sentAt || m.timestamp);
    if (!Number.isFinite(at)) continue;
    if (at > (out.get(from.sessionId) ?? 0)) out.set(from.sessionId, at);
  }
  return out;
}

/**
 * The linked sessions still shown, and those hidden. A later message from a hidden one, or one that
 * is running or waits on the person again, shows it again.
 */
export function splitUnlinked<T extends { sessionId: string; status?: string }>(
  linked: readonly T[],
  unlinked: Readonly<Record<string, number>> | undefined,
  lastFrom: ReadonlyMap<string, number>,
): { visible: T[]; hidden: T[] } {
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const l of linked) {
    const at = unlinked?.[l.sessionId];
    const busy = l.status === "running" || l.status === "needs_approval";
    if (at !== undefined && !busy && !((lastFrom.get(l.sessionId) ?? 0) > at)) hidden.push(l);
    else visible.push(l);
  }
  return { visible, hidden };
}

/**
 * The record with `ids` hidden from `chat`, or shown again, trimmed to its caps. `at` is what each
 * hide is measured against: the last message that session sent here (see the top of the file).
 */
export function updateUnlinks(
  map: UnlinkMap, chat: string, ids: readonly string[], unlink: boolean, at: number | ((id: string) => number) = 0,
): UnlinkMap {
  const forChat = { ...(map[chat] ?? {}) };
  for (const id of ids) {
    if (unlink) forChat[id] = typeof at === "function" ? at(id) : at;
    else delete forChat[id];
  }
  const next: UnlinkMap = { ...map };
  const kept = Object.entries(forChat).sort((a, b) => b[1] - a[1]).slice(0, MAX_UNLINKS_PER_CHAT);
  if (kept.length) next[chat] = Object.fromEntries(kept);
  else delete next[chat];
  const chats = Object.entries(next);
  if (chats.length <= MAX_UNLINK_CHATS) return next;
  const newest = (entries: Record<string, number>) => Math.max(...Object.values(entries));
  return Object.fromEntries(chats.sort((a, b) => newest(b[1]) - newest(a[1])).slice(0, MAX_UNLINK_CHATS));
}

/** Whether a value read back from storage or the server is an `UnlinkMap`. */
export function isUnlinkMap(v: unknown): v is UnlinkMap {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const chats = Object.values(v as Record<string, unknown>);
  if (chats.length > MAX_UNLINK_CHATS) return false;
  return chats.every((c) => typeof c === "object" && c !== null && !Array.isArray(c)
    && Object.keys(c).length <= MAX_UNLINKS_PER_CHAT
    && Object.values(c as Record<string, unknown>).every((t) => typeof t === "number" && Number.isFinite(t)));
}
