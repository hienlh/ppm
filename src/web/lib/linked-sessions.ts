/**
 * Which sessions are linked to the one on screen, and what each is doing — worked out in the
 * browser from what it already holds, so the bar costs no request:
 *
 * - the session list's `spawnedBy`: this session's creator and the sessions it created;
 * - the chat's own messages: a message another session sent here, and this session's
 *   `create_session` / `send_to_session` calls;
 * - `/ws/global`'s live links and announced titles (`session-collab-store`).
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
}

export type LinkedSessionStatus = "running" | "idle" | "needs_approval" | "new_message";

export interface LinkSources {
  sessionId: string;
  list: readonly SessionInfo[];
  messages: readonly ChatMessage[];
  /** Live links of this session, from `/ws/global`. */
  liveLinks?: Readonly<Record<string, readonly SessionLinkRelation[]>>;
  announced?: Readonly<Record<string, { title: string; providerId: string }>>;
}

const RELATION_ORDER: Record<SessionLinkRelation, number> = { parent: 0, child: 1, messaged: 2 };

export function collectLinkedSessions({ sessionId, list, messages, liveLinks, announced }: LinkSources): LinkedSession[] {
  const found = new Map<string, { relations: Set<SessionLinkRelation>; title?: string; providerId?: string }>();
  const add = (id: string | null | undefined, relation: SessionLinkRelation, title?: string, providerId?: string) => {
    if (!id || id === sessionId) return;
    const entry = found.get(id) ?? { relations: new Set() };
    entry.relations.add(relation);
    entry.title ??= title;
    entry.providerId ??= providerId;
    found.set(id, entry);
  };

  const self = list.find((s) => s.id === sessionId);
  add(self?.spawnedBy, "parent", self?.parentTitle ?? undefined);
  for (const s of list) if (s.spawnedBy === sessionId) add(s.id, "child", s.title, s.providerId);

  const results = new Map<string, string>();
  for (const m of messages) {
    for (const e of m.events ?? []) {
      if (e.type === "tool_result" && e.toolUseId && !e.isError) results.set(e.toolUseId, e.output);
    }
  }
  for (const m of messages) {
    if (m.role === "user") {
      const from = decodeMessageBlocks(m.content).fromSession;
      if (from) add(from.sessionId, "messaged", from.title, from.providerId);
      continue;
    }
    for (const e of m.events ?? []) {
      if (e.type !== "tool_use") continue;
      const call = sessionCollabToolCall(e.tool, e.input);
      if (!call || call.tool === "session_status") continue;
      const output = e.toolUseId ? results.get(e.toolUseId) : undefined;
      const result = output === undefined ? null : sessionCollabToolResult(output);
      if (call.tool === "create_session") add(result?.sessionId, "child", result?.title ?? call.title, result?.providerId);
      // Only a send the server took: a refused one names whatever id the AI wrote.
      else if (result) add(result.sessionId ?? call.sessionId, "messaged", result.title, result.providerId);
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
    out.push({
      sessionId: id,
      title: known?.title || announced?.[id]?.title || entry.title || "Untitled session",
      providerId: known?.providerId || announced?.[id]?.providerId || entry.providerId || "",
      relations: kept,
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
