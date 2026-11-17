/**
 * Which sessions are linked to the one on screen, and what each is doing — worked out in the
 * browser from what it already holds, so the bar costs no request:
 *
 * - the session list's `spawnedBy`: this session's creator and the sessions it created;
 * - the chat's own messages: a message another session sent here, and this session's
 *   `create_session` / `send_to_session` calls;
 * - `/ws/global`'s live links and announced titles (`session-collab-store`).
 *
 * Each also gets when the two sessions last interacted with each other — one created the other,
 * one messaged the other, a reply or a finished turn came back — which is what the Sessions list is
 * ordered by. The server's pair record (seeded with the links) knows interactions older than the
 * loaded messages; the messages know the ones since the chat was opened. The latest of the two wins.
 * What the other session does on its own, or with a third session, is never counted.
 *
 * Pure, so it is tested without the stores.
 */
import { decodeMessageBlocks } from "../../shared/chat-message-blocks";
import type { SessionLinkRelation } from "../../shared/session-collab";
import type { ChatMessage, SessionInfo } from "../../types/chat";
import { sessionCollabToolCall, sessionCollabToolResult } from "./session-collab-tool-call";

export interface LinkedSession {
  sessionId: string;
  title: string;
  providerId: string;
  relations: SessionLinkRelation[];
  /** When the two last interacted with each other (epoch ms); absent when nothing says. */
  lastInteractionAt?: number;
}

export type LinkedSessionStatus = "running" | "idle" | "needs_approval" | "new_message";

export interface LinkSources {
  sessionId: string;
  list: readonly SessionInfo[];
  messages: readonly ChatMessage[];
  /** Live links of this session, from `/ws/global`. */
  liveLinks?: Readonly<Record<string, readonly SessionLinkRelation[]>>;
  announced?: Readonly<Record<string, { title: string; providerId: string }>>;
  /** Other session → when it last interacted with this one, as the server and live events said. */
  interactedAt?: Readonly<Record<string, number>>;
}

/** An ISO time as epoch ms, or undefined when there is none to read. */
function epoch(iso: string | null | undefined): number | undefined {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

const RELATION_ORDER: Record<SessionLinkRelation, number> = { parent: 0, child: 1, messaged: 2 };

export function collectLinkedSessions({ sessionId, list, messages, liveLinks, announced, interactedAt }: LinkSources): LinkedSession[] {
  const found = new Map<string, { relations: Set<SessionLinkRelation>; title?: string; providerId?: string; at?: number }>();
  const add = (id: string | null | undefined, relation: SessionLinkRelation, title?: string, providerId?: string, at?: number) => {
    if (!id || id === sessionId) return;
    const entry = found.get(id) ?? { relations: new Set() };
    entry.relations.add(relation);
    entry.title ??= title;
    entry.providerId ??= providerId;
    if (at !== undefined && at > (entry.at ?? 0)) entry.at = at;
    found.set(id, entry);
  };

  // A session's creation is its creator's first interaction with it.
  const self = list.find((s) => s.id === sessionId);
  add(self?.spawnedBy, "parent", self?.parentTitle ?? undefined, undefined, epoch(self?.createdAt));
  for (const s of list) if (s.spawnedBy === sessionId) add(s.id, "child", s.title, s.providerId, epoch(s.createdAt));

  const results = new Map<string, string>();
  for (const m of messages) {
    for (const e of m.events ?? []) {
      if (e.type === "tool_result" && e.toolUseId && !e.isError) results.set(e.toolUseId, e.output);
    }
  }
  for (const m of messages) {
    if (m.role === "user") {
      const from = decodeMessageBlocks(m.content).fromSession;
      // The PPM Assistant belongs to no project, so this bar could not open it; its bubble does.
      if (from && from.kind !== "assistant") add(from.sessionId, "messaged", from.title, from.providerId, epoch(from.sentAt) ?? epoch(m.timestamp));
      continue;
    }
    for (const e of m.events ?? []) {
      if (e.type !== "tool_use") continue;
      const call = sessionCollabToolCall(e.tool, e.input);
      if (!call || call.tool === "session_status") continue;
      const output = e.toolUseId ? results.get(e.toolUseId) : undefined;
      const result = output === undefined ? null : sessionCollabToolResult(output);
      // A reply that came back is later than the call that waited for it.
      const at = (result?.reply?.replied ? epoch(result.reply.sentAt) : undefined) ?? epoch(m.timestamp);
      if (call.tool === "create_session") add(result?.sessionId, "child", result?.title ?? call.title, result?.providerId, at);
      // Only a send the server took: a refused one names whatever id the AI wrote.
      else if (result) add(result.sessionId ?? call.sessionId, "messaged", result.title, result.providerId, at);
    }
  }

  for (const [id, relations] of Object.entries(liveLinks ?? {})) for (const r of relations) add(id, r);

  const byId = new Map(list.map((s) => [s.id, s]));
  const out: LinkedSession[] = [];
  for (const [id, entry] of found) {
    const relations = [...entry.relations];
    // A first message between a parent and its child is announced as "messaged" too; the
    // stronger relation is what the user needs to see.
    const kept = relations.some((r) => r !== "messaged") ? relations.filter((r) => r !== "messaged") : relations;
    kept.sort((a, b) => RELATION_ORDER[a] - RELATION_ORDER[b]);
    const known = byId.get(id);
    const at = Math.max(entry.at ?? 0, interactedAt?.[id] ?? 0);
    out.push({
      sessionId: id,
      title: known?.title || announced?.[id]?.title || entry.title || "Untitled session",
      providerId: known?.providerId || announced?.[id]?.providerId || entry.providerId || "",
      relations: kept,
      ...(at > 0 ? { lastInteractionAt: at } : {}),
    });
  }
  return out.sort((a, b) => RELATION_ORDER[a.relations[0]!] - RELATION_ORDER[b.relations[0]!]);
}

export interface StatusSources {
  streaming: ReadonlyMap<string, unknown>;
  notifications: ReadonlyMap<string, { count: number; type: string }>;
  pendingApprovals: Readonly<Record<string, string>>;
}

/** Unread kinds that mean the session waits on the user (a collab card is one after a reload). */
const NEEDS_USER = new Set(["approval_request", "question", "collab_approval"]);

/** Waiting on the user outranks running, which outranks an unread answer. */
export function linkedSessionStatus(sessionId: string, { streaming, notifications, pendingApprovals }: StatusSources): LinkedSessionStatus {
  const unread = notifications.get(sessionId);
  if (pendingApprovals[sessionId] || (unread && unread.count > 0 && NEEDS_USER.has(unread.type))) {
    return "needs_approval";
  }
  if (streaming.has(sessionId)) return "running";
  if (unread && unread.count > 0) return "new_message";
  return "idle";
}

/**
 * Newest interaction with this session first; sessions with no known time go last. Stable, so
 * equals keep their order. Status plays no part: the person looks for the session they were just
 * dealing with, and a status has its own dot and word on the row.
 */
export function byRecentInteraction<T extends { lastInteractionAt?: number }>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) => (b.lastInteractionAt ?? 0) - (a.lastInteractionAt ?? 0));
}

/** Rows above which the Sessions list offers a filter by name. */
export const LINKED_FILTER_MIN_ROWS = 8;

/** Lower case with accents gone, so "tu dong" finds "tự động". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, "d").toLowerCase();
}

/** Whether a title holds every word of the query, in any order, ignoring case and accents. */
export function matchesLinkedFilter(title: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = fold(title);
  return words.every((w) => haystack.includes(w));
}

export const LINKED_STATUS_TEXT: Record<LinkedSessionStatus, string> = {
  running: "Running",
  idle: "Idle",
  needs_approval: "Needs you",
  new_message: "New message",
};

export const RELATION_TEXT: Record<SessionLinkRelation, string> = {
  parent: "Created this session",
  child: "Created by this session",
  messaged: "Messaged",
};
