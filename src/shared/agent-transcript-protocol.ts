/**
 * Wire protocol for the Agent card session window, carried entirely over
 * `/ws/global`. One hub per `(providerId, sessionId)` on the server streams a
 * card's (or teammate's) transcript from disk, from whatever byte offset the
 * client already has, and keeps pushing new steps live as they are written.
 *
 * Contract the server holds to (see `agent-transcript-hub.ts`):
 * - The client never names a file or a byte range directly — only a `source`
 *   (a card id or a teammate handle) the server resolves itself, and a
 *   `cursor` of offsets keyed by file keys the server handed out earlier.
 *   Offsets for keys the server never derived are ignored; a stale offset
 *   past the current file size is clamped down rather than rejected.
 * - Every error the client can see is one of the four codes below — never an
 *   exception message, a path, or a code from an internal module.
 */
import type { ChatEvent } from "../types/chat.ts";

export type AgentTranscriptProviderId = "claude" | "codex";

export type AgentTranscriptSourceKind =
  | { kind: "card"; cardId: string }
  | { kind: "member"; teamName: string; memberName: string };

/** Byte offset already consumed, per file key the server previously derived. */
export interface AgentTranscriptCursor {
  [fileKey: string]: number;
}

/**
 * One step on the wire. `k` is a stable de-dupe key, normally
 * `"<fileKey>:<byteOffset>:<i>"` where `byteOffset` is a file position before
 * the read that produced it, so a page re-sent after a dropped connection
 * carries the same keys as before. `replace: true` (Codex only) means the
 * client should update the step already shown for this `ev`'s `toolUseId` in
 * place, not append a new one — the usual case is a tool_result answering an
 * earlier tool_use. A `replace` envelope's `k` is the ORIGINAL key issued for
 * that `toolUseId`, reused rather than freshly minted, precisely so a
 * same-`k` upsert on the client has something to match.
 */
export interface AgentTranscriptEnvelope {
  ev: ChatEvent;
  ts: number;
  k: string;
  replace?: true;
}

export type AgentTranscriptErrorCode = "not_found" | "forbidden" | "limit" | "bad_request";

/** One entry of the running-agents bar. Exactly one of `cardId`/`memberName` is set. */
export interface AgentTranscriptRunningEntry {
  cardId?: string;
  memberName?: string;
  /** Epoch ms the underlying transcript file was last written. */
  lastWriteAt: number;
  /** Short label for the agent's most recent step, when one could be read cheaply. */
  lastStep?: string;
}

// ---- Client → server ----

export interface AgentTranscriptSubscribeMsg {
  type: "agent-transcript:subscribe";
  subId: string;
  projectName: string;
  providerId: AgentTranscriptProviderId;
  sessionId: string;
  source: AgentTranscriptSourceKind;
  cursor?: AgentTranscriptCursor;
}

export interface AgentTranscriptUnsubscribeMsg {
  type: "agent-transcript:unsubscribe";
  subId: string;
}

export interface AgentActivitySubscribeMsg {
  type: "agent-activity:subscribe";
  subId: string;
  projectName: string;
  providerId: AgentTranscriptProviderId;
  sessionId: string;
}

export interface AgentActivityUnsubscribeMsg {
  type: "agent-activity:unsubscribe";
  subId: string;
}

export interface PingMsg {
  type: "ping";
}

export type AgentTranscriptClientMsg =
  | AgentTranscriptSubscribeMsg
  | AgentTranscriptUnsubscribeMsg
  | AgentActivitySubscribeMsg
  | AgentActivityUnsubscribeMsg
  | PingMsg;

// ---- Server → client ----

export interface AgentTranscriptEventsMsg {
  type: "agent-transcript:events";
  subId: string;
  events: AgentTranscriptEnvelope[];
  /** Current per-file consumed offsets for this subscription — the next `cursor` to resume from. */
  cursor: AgentTranscriptCursor;
  /** More pages are coming right behind this one (a backlog being drained on subscribe). */
  more?: true;
  /**
   * The client must discard everything it has for this subscription and
   * replace it with `events` — a truncated/rotated Claude transcript file, or
   * a Codex compaction/rollback record, rewrote history rather than appending
   * to it. Set only on the first page of the replacement; later pages of the
   * same catch-up carry `more` instead.
   */
  reset?: true;
  /** The source resolved to at least one readable file (as opposed to the error path). */
  available: boolean;
  /** Whether the underlying agent still looks active (see hub's idle heuristic). */
  running: boolean;
}

export interface AgentTranscriptErrorMsg {
  type: "agent-transcript:error";
  subId: string;
  code: AgentTranscriptErrorCode;
}

export interface AgentActivityMsg {
  type: "agent-activity";
  subId: string;
  running: AgentTranscriptRunningEntry[];
}

export interface PongMsg {
  type: "pong";
}

export type AgentTranscriptServerMsg =
  | AgentTranscriptEventsMsg
  | AgentTranscriptErrorMsg
  | AgentActivityMsg
  | PongMsg;

// ---- Tuning constants, shared so client and server agree ----

export const MAX_TRANSCRIPT_SUBS_PER_CLIENT = 8;
export const MAX_TRANSCRIPT_SUBS_PER_SERVER = 64;
export const CATCH_UP_MAX_BYTES = 512 * 1024;
export const CATCH_UP_MAX_EVENTS = 500;
export const TOOL_OUTPUT_MAX_CHARS = 20_000;
export const LIVE_TICK_MS = 250;
export const IDLE_TICK_MS = 2_000;
export const IDLE_AFTER_MS = 30_000;
export const ACTIVITY_TICK_MS = 3_000;
export const ACTIVITY_WINDOW_MS = 90_000;
export const INDEX_REFRESH_MS = 2_000;
