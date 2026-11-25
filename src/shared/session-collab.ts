/**
 * Sessions that open and message each other: the names, shapes and events the server's
 * `ppm-sessions` tools and the browser agree on. Every created session is an ordinary PPM session
 * the user can open, watch, chat into and stop.
 *
 * Claude addresses MCP tools as `mcp__<server>__<tool>`; Codex takes the server name from its
 * config key, where a hyphen is not a safe character. Neither is plain `ppm`, which a user may
 * already have as an MCP server of their own.
 */
import { CARD_TOOLS } from "./card-withdraw.ts";
import type { SessionPhase } from "../types/api.ts";
import type { ApprovalSummary } from "./assistant-approval.ts";
import { SESSION_SCHEDULE_TOOLS } from "./session-schedule-tools.ts";
import { VAULT_TOOLS } from "./vault.ts";
import { PPM_TASK_TOOLS } from "./ppm-task-tools.ts";

export const CREATE_SESSION_TOOL = "create_session";
export const SEND_TO_SESSION_TOOL = "send_to_session";
export const SESSION_STATUS_TOOL = "session_status";
/** PNG screenshots of a design's variants, rendered on the server, to look at and to put on a report card. */
export const DESIGN_SCREENSHOT_TOOL = "design_screenshot";
export const SESSION_COLLAB_TOOLS = [CREATE_SESSION_TOOL, SEND_TO_SESSION_TOOL, SESSION_STATUS_TOOL, DESIGN_SCREENSHOT_TOOL] as const;
export type SessionCollabTool = (typeof SESSION_COLLAB_TOOLS)[number];

export const isSessionCollabTool = (name: unknown): name is SessionCollabTool =>
  (SESSION_COLLAB_TOOLS as readonly unknown[]).includes(name);

/**
 * A manager chat's report to the user through PPM Assistant. Served by the same endpoint, but no
 * Settings switch: it is listed for manager chats only, and always for them.
 */
export const REPORT_TO_ASSISTANT_TOOL = "report_to_assistant";
/** Every tool the session tools' server can serve. */
export const SESSION_SERVER_TOOLS = [
  ...SESSION_COLLAB_TOOLS, ...SESSION_SCHEDULE_TOOLS, REPORT_TO_ASSISTANT_TOOL, ...CARD_TOOLS, ...VAULT_TOOLS, ...PPM_TASK_TOOLS,
] as const;

export const CLAUDE_SESSION_COLLAB_MCP_SERVER = "ppm-sessions";
export const CODEX_SESSION_COLLAB_MCP_SERVER = "ppm_sessions";

// ── Approvals ─────────────────────────────────────────────────────────────

/**
 * The `tool` of the `approval_request` a create or pair-limit card waits on. Not any provider's
 * name for a tool, so the chat can tell this approval from a provider's own and draw its own card.
 */
export const SESSION_COLLAB_APPROVAL = "ppm:session_collab";

export type SessionCollabApprovalKind = "create" | "pair_limit" | "escalation" | "message" | "schedule";

/** Where the mode a message or a new chat runs in came from, as a card states it. */
export type SessionCollabModeSource = "running" | "stored" | "live" | "provider-default";

/**
 * Permission modes from least to most permissive, as PPM names them (`VALID_PERMISSION_MODES` in
 * `src/types/config.ts`; Codex sessions use the same names).
 */
export const PERMISSION_MODE_RANK: Readonly<Record<string, number>> = Object.freeze({
  plan: 0,
  default: 1,
  acceptEdits: 2,
  bypassPermissions: 3,
});

/**
 * How permissive a mode is. Callers pass each session's *effective* mode (its own, else its
 * provider's configured default). A mode PPM does not know ranks as the most permissive, so an
 * unknown target is asked about rather than trusted.
 */
export function permissionRank(mode: string | null | undefined): number {
  const rank = mode ? PERMISSION_MODE_RANK[mode] : undefined;
  return rank ?? PERMISSION_MODE_RANK.bypassPermissions!;
}

/**
 * Whether a message from a session in `senderMode` to one in `targetMode` lets the sender's AI
 * act with more rights than it has: such a send needs the user's approval (`kind: "escalation"`).
 */
export const isPermissionEscalation = (senderMode: string | null | undefined, targetMode: string | null | undefined): boolean =>
  permissionRank(targetMode) > permissionRank(senderMode);

/** An AI asks to create a session; shown in the asking session. */
export interface SessionCollabCreateApproval {
  kind: "create";
  /** The proposed title, already sanitized by the server. */
  title: string;
  providerId: string;
  model: string | null;
  /** The whole task the new session would be given, line breaks kept: the user approves all of it. */
  task: string;
  /** Depth the new session would have (the asking session's depth + 1; 0 when the PPM Assistant asks). */
  depth: number;
  /** Set when the PPM Assistant asks: such a card is answered once, never for the whole session. */
  askedBy?: "assistant";
  /** The project the chat opens in, when it is not the asking session's own (the Assistant's create). */
  projectName?: string;
  /** The mode the new chat runs in, when the card states it. */
  permissionMode?: string;
  modeSource?: SessionCollabModeSource;
  /**
   * The PPM Assistant asks to create the project's manager chat: once it exists, the Assistant
   * messages it without asking, also while the user is away. The task may then be empty.
   */
  manager?: true;
  /** The new chat is a Design chat for this existing design. */
  design?: { slug: string; title: string };
}

/** Two sessions reached their limit of automatic messages; shown in the sending session. */
export interface SessionCollabPairLimitApproval {
  kind: "pair_limit";
  targetSessionId: string;
  targetTitle: string;
  /** Messages sent automatically between the two since the user last wrote in either. */
  sent: number;
  limit: number;
  /** How many more messages allowing grants. */
  grant: number;
}

/**
 * An AI asks to message a session that runs under a more permissive mode than its own; shown in
 * the sending session. Allowing for this session stops asking for this sender and target until
 * PPM restarts, or until the target switches to a more permissive mode than it had then.
 */
export interface SessionCollabEscalationApproval {
  kind: "escalation";
  targetSessionId: string;
  targetTitle: string;
  senderMode: string;
  targetMode: string;
  /** The whole message the sender wants to deliver, line breaks kept: the user approves all of it. */
  message: string;
}

/**
 * The PPM Assistant asks to message one of the user's chats; shown in the Assistant's session. The
 * chat then works on the message in its own permission mode, which the card names, so a chat that
 * runs every tool unasked is called out before the user allows it.
 */
export interface SessionCollabMessageApproval {
  kind: "message";
  targetSessionId: string;
  targetTitle: string;
  /** The chat's project. */
  projectName: string;
  providerId: string;
  /** The mode the message will run in, and where that came from. */
  permissionMode: string;
  modeSource: SessionCollabModeSource;
  /** The whole message, line breaks kept: the user approves all of it. */
  message: string;
}

/**
 * A chat's AI asks to create a script schedule, or to pause or turn on one of its project's
 * schedules; shown in the asking chat. The card is the same summary the PPM Assistant's schedule
 * cards carry, built by the server from what it checked. Answered once or not at all.
 */
export interface SessionCollabScheduleApproval {
  kind: "schedule";
  action: "create_script" | "enable" | "disable";
  summary: ApprovalSummary;
}

/**
 * A chat's AI asks to drive PPM's own web browser (a Chrome on the host, shown in a PPM window);
 * shown in the asking chat at its first browser call. Allowing for this chat lasts until PPM
 * restarts; the user can take the browser back in its window at any time.
 */
export interface SessionCollabBrowserApproval {
  kind: "browser";
  /** The address the first call opens, when it opens one. */
  url: string | null;
}

export type SessionCollabApprovalInput =
  | SessionCollabCreateApproval
  | SessionCollabPairLimitApproval
  | SessionCollabEscalationApproval
  | SessionCollabMessageApproval
  | SessionCollabScheduleApproval
  | SessionCollabBrowserApproval;

/** The approval event held in the asking session's one approval slot. */
export interface SessionCollabApprovalRequest {
  type: "approval_request";
  requestId: string;
  tool: typeof SESSION_COLLAB_APPROVAL;
  input: SessionCollabApprovalInput;
}

/**
 * The user's answer. `allow_session` on a create card lets this session create without asking
 * again, and on an escalation card lets this sender message this target without asking again
 * (until a restart, or the target becoming more permissive); a pair-limit card offers
 * `allow_once` (grants `grant` more messages) and `deny` only.
 */
export const SESSION_COLLAB_ANSWERS = ["allow_once", "allow_session", "deny"] as const;
export type SessionCollabAnswer = (typeof SESSION_COLLAB_ANSWERS)[number];

export const isSessionCollabAnswer = (value: unknown): value is SessionCollabAnswer =>
  (SESSION_COLLAB_ANSWERS as readonly unknown[]).includes(value);

/** Narrows an approval event's input to a session-collaboration one, or null. */
export function sessionCollabApprovalInput(tool: string, input: unknown): SessionCollabApprovalInput | null {
  if (tool !== SESSION_COLLAB_APPROVAL || !input || typeof input !== "object") return null;
  const kind = (input as { kind?: unknown }).kind;
  if (kind === "schedule") {
    const summary = (input as { summary?: unknown }).summary;
    return summary && typeof summary === "object" && typeof (summary as { headline?: unknown }).headline === "string"
      ? input as SessionCollabApprovalInput : null;
  }
  return kind === "create" || kind === "pair_limit" || kind === "escalation" || kind === "message" || kind === "browser"
    ? input as SessionCollabApprovalInput : null;
}

const ONCE_OR_DENY: readonly SessionCollabAnswer[] = ["allow_once", "deny"];

/**
 * The answers a card offers. A pair-limit card and every card the PPM Assistant asks (a message,
 * a create) are answered one at a time: allowing the Assistant "for this session" would let it
 * write into chats unasked from then on.
 */
export function sessionCollabAnswersFor(card: SessionCollabApprovalKind | SessionCollabApprovalInput): readonly SessionCollabAnswer[] {
  if (typeof card === "string") return card === "pair_limit" || card === "message" || card === "schedule" ? ONCE_OR_DENY : SESSION_COLLAB_ANSWERS;
  if (card.kind === "pair_limit" || card.kind === "message" || card.kind === "schedule") return ONCE_OR_DENY;
  return card.kind === "create" && card.askedBy === "assistant" ? ONCE_OR_DENY : SESSION_COLLAB_ANSWERS;
}

// ── Delivery rules ────────────────────────────────────────────────────────

/**
 * Why a send is refused before anything is asked or delivered. A design session never receives
 * messages from other sessions; a session never messages itself; the target must be in the
 * sender's project.
 */
export type SessionCollabRefusal =
  | "design_session" | "assistant_session" | "self" | "other_project" | "not_found" | "depth" | "running_limit";

/**
 * A reply that arrives after the sender stopped waiting — its wait timed out, or its turn was
 * stopped — is always delivered to the sender as a new message, starting a turn there (resuming
 * a stopped session) if none is running. It is never dropped.
 */
export const LATE_REPLY_DELIVERY = "new_message" as const;

// ── Status and results ────────────────────────────────────────────────────

/**
 * What a delivery actually did: `inserted` — handed to the running turn, which reads it at its next
 * step (Claude's input stream, a Codex steer); `queued` — the target is busy (waiting on the user,
 * compacting, or a Codex turn that cannot be steered) and it runs as soon as that is over;
 * `started` — it opened a new turn.
 */
export type SessionDelivery = "inserted" | "queued" | "started";

/** One session as `session_status` reports it, and as the linked-sessions bar draws it. */
export interface SessionStatus {
  sessionId: string;
  title: string;
  providerId: string;
  model: string | null;
  phase: SessionPhase;
  /** What the session is waiting on the user for, if anything. */
  waitingFor: "approval" | "question" | null;
  /** The session whose AI created this one, or null when a person did. */
  spawnedBy: string | null;
  /** 0 for a session a person started; a created session is its creator's depth + 1. */
  depth: number;
  /** The opening of the last answer, at most 300 characters, code fences broken. */
  lastAssistantText: string | null;
  /**
   * Messages this session sent to the caller that no turn of the caller has taken yet (a reply
   * returned as a wait's result never counts), since the caller last asked.
   */
  unreadReplies: number;
  /** ISO time of the session's last activity, when known. */
  updatedAt: string | null;
}

/** What a session is stuck on when it waits for the user: the card on its screen. */
export interface WaitingCard {
  kind: "approval" | "question";
  /** The card's question or what it asks to run, at most {@link WAITING_CARD_TITLE_MAX} characters. */
  title: string;
}

export const WAITING_CARD_TITLE_MAX = 160;

/**
 * How a `wait: true` call ended. A session showing the user a card cannot read the message or
 * answer until the user does, so the wait ends at once with that card (`card`) rather than
 * sitting out its timeout; the message is not lost, the session goes on with it once answered.
 */
export type SessionWaitOutcome =
  | { replied: true; text: string; turnId?: string; sentAt: string }
  | { replied: false; reason: "turn_ended_without_reply" | "timeout" | "cancelled" }
  | { replied: false; reason: "waiting_for_user"; card: WaitingCard }
  | { replied: false; reason: "interrupted"; by: WaitInterruption; note: string };

/**
 * Who ended a wait by writing to the waiting session. A waiting chat stands still inside one tool
 * call, and nothing sent to it is read until that call returns, so any message that reaches it ends
 * its waits: the user's own (typed, a card answered from Telegram, or Stop waiting), another chat's,
 * the PPM Assistant's, or PPM's (a schedule, manager news, a task notice, an extension). `queued`
 * is a message that goes in only once the waiting chat's turn is over (a schedule or a watch report
 * never joins a running turn, an Assistant message sent `later`): the chat should finish its turn.
 */
export interface WaitInterruption {
  kind: "user" | "session" | "assistant" | "ppm";
  /** The writing chat, for `session` and `assistant`. */
  sessionId?: string;
  /** Its title, one line, at most {@link WAITING_CARD_TITLE_MAX} characters. */
  title?: string;
  queued?: boolean;
  /** The user pressed Stop waiting on the tool's card: no message came, they want you to go on. */
  stopped?: boolean;
}

/**
 * What the waiting AI is told when a message ended its wait, as plain words in the tool's answer:
 * read the new message first, and where the other session's answer will be. That session was not
 * stopped, but it may never send a message back (it may only finish its turn, and a chat cannot
 * message the PPM Assistant at all), so the note promises a message only where one will come.
 * `answersInReply`: a Design chat, which answers only in its own reply. `managerNews`: the PPM
 * Assistant waiting on a manager chat, whose answer PPM brings back as manager news.
 */
export function waitInterruptedNote(by: WaitInterruption, opts: { answersInReply?: boolean; managerNews?: boolean } = {}): string {
  const tail = opts.answersInReply
    ? " The Design chat was not stopped, but it answers only in its own reply, never as a message to you: "
      + "read its answer later with session_status or read_session_turns rather than sending again."
    : opts.managerNews
      ? " The manager chat was not stopped: its answer comes back to you later as manager news, so do not "
        + "send again or wait for it again."
      : " The other session was not stopped and keeps working. If it replies with send_to_session, that "
        + "arrives as a new message; if it only finishes its turn, its answer shows in session_status. "
        + "Look there rather than sending the request again or waiting again.";
  if (by.stopped) return `The user stopped this wait so you can go on with other work.${tail}`;
  const who = by.kind === "user" ? "The user"
    : by.kind === "assistant" ? "The PPM Assistant"
    // Another AI's title: quoted as data, never spliced in as words of the note.
    : by.kind === "session" ? (by.title ? `The chat ${JSON.stringify(by.title)}` : "Another chat")
    : "PPM";
  const then = by.queued
    ? "It goes in once this turn ends: finish the step you are on and end your turn."
    : "Read it now and act on it.";
  return `${who} sent you a message, so this wait ended. ${then}${tail}`;
}

export interface CreateSessionResult {
  sessionId: string;
  title: string;
  providerId: string;
  model: string | null;
  status: SessionStatus;
  reply?: SessionWaitOutcome;
}

export interface SendToSessionResult {
  delivered: SessionDelivery;
  status: SessionStatus;
  reply?: SessionWaitOutcome;
}

export interface SessionStatusResult {
  sessions: SessionStatus[];
}

// ── Links ─────────────────────────────────────────────────────────────────

export type SessionLinkRelation = "parent" | "child" | "messaged";

/** Another session linked to one: its creator, a session it created, or one it exchanged messages with. */
export interface SessionLink {
  sessionId: string;
  relations: SessionLinkRelation[];
  /**
   * When the two sessions last interacted with each other (epoch ms): one created the other, one
   * messaged the other, or a wait on the other ended. Absent when PPM never recorded one.
   */
  lastInteractionAt?: number;
}

// ── Global events (`/ws/global`) ──────────────────────────────────────────

export const SESSION_CREATED_EVENT = "session:created";
export const SESSION_LINK_CHANGED_EVENT = "session:link_changed";
export const SESSION_COLLAB_APPROVAL_EVENT = "session:collab_approval";

/** A session tool created a session: session lists refresh without a reload. */
export interface SessionCreatedEvent {
  type: typeof SESSION_CREATED_EVENT;
  sessionId: string;
  providerId: string;
  projectName: string;
  title: string;
  spawnedBy: string | null;
  /**
   * The creator's title and provider, as the server knows them: a session list that never loaded
   * the creator (an older session, past its first page) can still say who created this one.
   */
  parentTitle?: string | null;
  parentProviderId?: string | null;
  depth: number;
  /** ISO time. */
  createdAt: string;
}

/** The links of these sessions changed (a spawn, a first message between two sessions). */
export interface SessionLinkChangedEvent {
  type: typeof SESSION_LINK_CHANGED_EVENT;
  projectName: string;
  sessionIds: string[];
}

/** A create or pair-limit card appeared in, or left, a session. */
export interface SessionCollabApprovalEvent {
  type: typeof SESSION_COLLAB_APPROVAL_EVENT;
  projectName: string;
  sessionId: string;
  requestId: string;
  state: "pending" | "resolved";
  input?: SessionCollabApprovalInput;
  answer?: SessionCollabAnswer;
}

export type SessionCollabGlobalEvent = SessionCreatedEvent | SessionLinkChangedEvent | SessionCollabApprovalEvent;

/** The longest title a session tool gives a new session, a manager chat's default title included. */
export const MAX_COLLAB_TITLE_CHARS = 60;
