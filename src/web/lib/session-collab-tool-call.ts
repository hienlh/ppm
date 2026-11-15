/**
 * Reads a chat event as a call of the `ppm-sessions` tools (`create_session`, `send_to_session`,
 * `session_status`), and reads its result back, for the card that shows it
 * (`session-collab-tool-card.tsx`). Pure, so it is tested without the stores.
 *
 * Everything here comes from an AI or from the tool's own output, so every field is checked and
 * anything malformed is dropped rather than trusted: the card then shows the raw text instead.
 */
import {
  CLAUDE_SESSION_COLLAB_MCP_SERVER, CODEX_SESSION_COLLAB_MCP_SERVER, CREATE_SESSION_TOOL, DESIGN_SCREENSHOT_TOOL, SEND_TO_SESSION_TOOL,
  SESSION_STATUS_TOOL, type SessionCollabTool, type SessionStatus, type SessionWaitOutcome, type SessionDelivery,
  type WaitingCard, type WaitInterruption,
} from "../../shared/session-collab";
import { tabToolResultText } from "./tab-tool-call";
import type { LinkedSessionStatus } from "./linked-sessions";

/**
 * Claude names a tool `mcp__ppm-sessions__create_session`; Codex `ppm_sessions:create_session`;
 * Antigravity `mcp_ppm-sessions_create_session`.
 */
const TOOL_NAME = new RegExp(
  `^(?:mcp__${CLAUDE_SESSION_COLLAB_MCP_SERVER}__|${CODEX_SESSION_COLLAB_MCP_SERVER}:|mcp_${CLAUDE_SESSION_COLLAB_MCP_SERVER}_)(${CREATE_SESSION_TOOL}|${SEND_TO_SESSION_TOOL}|${SESSION_STATUS_TOOL})$`,
);

export type SessionCollabToolCall =
  | { tool: typeof CREATE_SESSION_TOOL; title: string; task: string; provider?: string; model?: string; wait: boolean }
  | { tool: typeof SEND_TO_SESSION_TOOL; sessionId: string; message: string; wait: boolean }
  | { tool: typeof SESSION_STATUS_TOOL; sessionIds: string[] };

/** What the tool answered, when its output is the JSON the server writes. */
export interface SessionCollabToolResult {
  /** The session a create made, or the target of a send. */
  sessionId?: string;
  title?: string;
  providerId?: string;
  delivered?: SessionDelivery;
  status?: SessionStatus;
  reply?: SessionWaitOutcome;
  /** `session_status`'s list. */
  sessions?: SessionStatus[];
  /** The session's project, when it is not the caller's (the PPM Assistant's calls). */
  project?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** The `ppm-sessions` tool a name is, under either provider's name, or null. */
export function sessionCollabToolOf(toolName: string): Exclude<SessionCollabTool, typeof DESIGN_SCREENSHOT_TOOL> | null {
  // `design_screenshot` is not matched: its pictures show in the ordinary tool card.
  return (TOOL_NAME.exec(toolName)?.[1] as Exclude<SessionCollabTool, typeof DESIGN_SCREENSHOT_TOOL> | undefined) ?? null;
}

/** The call an event is, or null. Codex wraps the arguments as `{ server, tool, arguments }`. */
export function sessionCollabToolCall(toolName: string, input: unknown): SessionCollabToolCall | null {
  const tool = sessionCollabToolOf(toolName);
  if (!tool || !isObj(input)) return null;
  const args = "arguments" in input && isObj(input.arguments) ? input.arguments : input;
  const wait = args.wait === true;
  if (tool === CREATE_SESSION_TOOL) {
    const provider = text(args.provider);
    const model = text(args.model);
    return { tool, title: text(args.title) ?? "New session", task: typeof args.task === "string" ? args.task : "", wait,
      ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
  }
  if (tool === SEND_TO_SESSION_TOOL) {
    const sessionId = text(args.session_id);
    return sessionId ? { tool, sessionId, message: typeof args.message === "string" ? args.message : "", wait } : null;
  }
  const ids = Array.isArray(args.session_ids) ? args.session_ids.filter((id): id is string => typeof id === "string" && !!id.trim()) : [];
  return { tool, sessionIds: ids };
}

function readStatus(v: unknown): SessionStatus | undefined {
  if (!isObj(v) || typeof v.sessionId !== "string" || typeof v.phase !== "string") return undefined;
  return {
    sessionId: v.sessionId,
    title: typeof v.title === "string" ? v.title : "Untitled session",
    providerId: typeof v.providerId === "string" ? v.providerId : "",
    model: typeof v.model === "string" ? v.model : null,
    phase: v.phase as SessionStatus["phase"],
    waitingFor: v.waitingFor === "approval" || v.waitingFor === "question" ? v.waitingFor : null,
    spawnedBy: typeof v.spawnedBy === "string" ? v.spawnedBy : null,
    depth: typeof v.depth === "number" ? v.depth : 0,
    lastAssistantText: typeof v.lastAssistantText === "string" ? v.lastAssistantText : null,
    unreadReplies: typeof v.unreadReplies === "number" ? v.unreadReplies : 0,
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null,
  };
}

const WAIT_REASONS = new Set(["turn_ended_without_reply", "timeout", "cancelled"]);

function readWaitingCard(v: unknown): WaitingCard | null {
  if (!isObj(v) || (v.kind !== "approval" && v.kind !== "question") || typeof v.title !== "string") return null;
  return { kind: v.kind, title: v.title };
}

const INTERRUPTERS = new Set(["user", "session", "assistant", "ppm"]);

/** Who ended a wait, as the server wrote it; null when malformed. */
function readInterruption(v: unknown): WaitInterruption | null {
  if (!isObj(v) || typeof v.kind !== "string" || !INTERRUPTERS.has(v.kind)) return null;
  return {
    kind: v.kind as WaitInterruption["kind"],
    ...(text(v.sessionId) ? { sessionId: v.sessionId as string } : {}),
    ...(text(v.title) ? { title: v.title as string } : {}),
    ...(v.queued === true ? { queued: true } : {}),
    ...(v.stopped === true ? { stopped: true } : {}),
  };
}

function readReply(v: unknown): SessionWaitOutcome | undefined {
  if (!isObj(v)) return undefined;
  if (v.replied === false && v.reason === "interrupted") {
    const by = readInterruption(v.by);
    return by ? { replied: false, reason: "interrupted", by, note: typeof v.note === "string" ? v.note : "" } : undefined;
  }
  if (v.replied === true && typeof v.text === "string") {
    return { replied: true, text: v.text, sentAt: typeof v.sentAt === "string" ? v.sentAt : "",
      ...(typeof v.turnId === "string" ? { turnId: v.turnId } : {}) };
  }
  if (v.replied === false && v.reason === "waiting_for_user") {
    const card = readWaitingCard(v.card);
    return card ? { replied: false, reason: "waiting_for_user", card } : undefined;
  }
  if (v.replied === false && typeof v.reason === "string" && WAIT_REASONS.has(v.reason)) {
    return { replied: false, reason: v.reason as "turn_ended_without_reply" | "timeout" | "cancelled" };
  }
  return undefined;
}

const DELIVERIES = new Set(["inserted", "queued", "started"]);

/** The tool's answer as the server wrote it, or null when the output is not that JSON. */
export function sessionCollabToolResult(output: string): SessionCollabToolResult | null {
  const raw = tabToolResultText(output).trim();
  if (!raw.startsWith("{")) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isObj(parsed)) return null;
  const status = readStatus(parsed.status);
  const reply = readReply(parsed.reply);
  const sessions = Array.isArray(parsed.sessions)
    ? parsed.sessions.map(readStatus).filter((s): s is SessionStatus => !!s)
    : undefined;
  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : status?.sessionId;
  const providerId = typeof parsed.providerId === "string" ? parsed.providerId : status?.providerId || undefined;
  const result: SessionCollabToolResult = {
    ...(sessionId ? { sessionId } : {}),
    ...(typeof parsed.title === "string" ? { title: parsed.title } : status ? { title: status.title } : {}),
    ...(providerId ? { providerId } : {}),
    ...(typeof parsed.delivered === "string" && DELIVERIES.has(parsed.delivered) ? { delivered: parsed.delivered as SessionDelivery } : {}),
    ...(status ? { status } : {}),
    ...(reply ? { reply } : {}),
    ...(sessions ? { sessions } : {}),
    ...(text(parsed.project) ? { project: parsed.project as string } : {}),
  };
  return Object.keys(result).length > 0 ? result : null;
}

/** Why a wait ended without a reply, in words. */
export function waitEndedText(reply: Extract<SessionWaitOutcome, { replied: false }>): string {
  if (reply.reason === "waiting_for_user") {
    return `It is waiting for the user to answer ${reply.card.kind === "question" ? "a question" : "an approval"}: “${reply.card.title}”. It goes on with the message once they have.`;
  }
  if (reply.reason === "interrupted") return `${interruptedText(reply.by)} It keeps working: a reply comes in as a message, or open it to read its answer.`;
  const reason = reply.reason;
  if (reason === "turn_ended_without_reply") return "It finished its turn without replying.";
  if (reason === "timeout") return "No reply before the wait timed out.";
  return "The wait was cancelled.";
}

/** Why the waiting chat stopped waiting: the message that reached it, or the user's Stop waiting. */
function interruptedText(by: WaitInterruption): string {
  if (by.stopped) return "You stopped waiting, so this chat went on.";
  if (by.kind === "user") return "Stopped waiting: you wrote to this chat.";
  if (by.kind === "session") return `Stopped waiting: “${by.title ?? "another chat"}” wrote to this chat.`;
  if (by.kind === "assistant") return "Stopped waiting: the PPM Assistant wrote to this chat.";
  return by.queued
    ? "Stopped waiting so a message from PPM (a schedule or news) can go in once this turn ends."
    : "Stopped waiting: PPM sent this chat a message.";
}

/**
 * A message or a new session handed off without waiting: it went in, and the other session's
 * reply will come back to this chat as a message of its own. Nothing is pending on the card.
 */
export function sentAwaitingReply(call: SessionCollabToolCall, result: SessionCollabToolResult | null): boolean {
  if (call.tool === SESSION_STATUS_TOOL || call.wait || !result || result.reply) return false;
  // A send says how the message went in; a create answers with the session it made and handed the task to.
  return call.tool === CREATE_SESSION_TOOL ? !!result.sessionId : !!result.delivered;
}

/**
 * Where a card stands. `stopped` is a call the turn finished without an answer to: Stop aborts the
 * turn, and an aborted CLI never streams the MCP answer (the server's `cancelled` outcome included),
 * so a finished turn with no result is a call that was cut short — never a success.
 */
export type SessionCollabCardState = "running" | "waiting" | "answered" | "error" | "stopped";

export function sessionCollabCardState(
  call: SessionCollabToolCall,
  { done, isError, hasOutput }: { done: boolean; isError: boolean; hasOutput: boolean },
): SessionCollabCardState {
  if (isError) return "error";
  if (hasOutput) return "answered";
  if (done) return "stopped";
  return call.tool !== SESSION_STATUS_TOOL && call.wait ? "waiting" : "running";
}

/** What a stopped card says: a wait that was cut short, or a call that never answered. */
export function stoppedCallText(call: SessionCollabToolCall): string {
  return call.tool !== SESSION_STATUS_TOOL && call.wait
    ? "Wait cancelled: the turn was stopped before a reply came."
    : "The turn ended before this tool answered.";
}

/**
 * A status as the tool reported it, brought up to what the browser knows the session is doing now.
 * The tool's status is a snapshot from the moment it answered, and its card stays on screen long
 * after: a create card kept saying "Running" for a child that had gone idle while the linked bar
 * beside it said Idle. `live` is the bar's own reading (`linkedSessionStatus`); null keeps the snapshot.
 */
export function withLiveStatus(status: SessionStatus, live: LinkedSessionStatus | null): SessionStatus {
  if (!live) return status;
  const busy = status.phase === "idle" ? "streaming" : status.phase;
  if (live === "needs_approval") return { ...status, phase: busy, waitingFor: status.waitingFor ?? "approval" };
  if (live === "running") return { ...status, phase: busy, waitingFor: null };
  return { ...status, phase: "idle", waitingFor: null };
}

/** A session's phase and what it waits on, in words. */
export function sessionStatusText(status: Pick<SessionStatus, "phase" | "waitingFor">): string {
  if (status.waitingFor === "approval") return "Needs approval";
  if (status.waitingFor === "question") return "Has a question";
  return status.phase === "idle" ? "Idle" : "Running";
}
