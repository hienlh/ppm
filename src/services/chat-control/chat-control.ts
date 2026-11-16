import type { ReplyReference } from "../../shared/chat-reply.ts";
import type { SessionPhase } from "../../types/api.ts";
import type { ApprovalSummary } from "../../shared/assistant-approval.ts";
import type { AnswersById, NormalizedQuestion } from "../../shared/approval-questions.ts";
import type { WatchEventNotice } from "../../types/chat.ts";
import type { WakeNewsNotice } from "../../shared/assistant-wake-news.ts";
import type { ScheduleRunReference } from "../../shared/chat-schedule-run.ts";
import type { SessionDelivery } from "../../shared/session-collab.ts";

/**
 * What the rest of the server may do to a chat that only a browser could do before: send it a
 * message, answer its approval card, stop its turn, and look at what it is doing — with no socket
 * attached. `ws/chat.ts` owns the sessions and registers the implementation; everything else
 * imports from here, never from the socket layer, which would be an import cycle.
 *
 * Every action goes through the same code the WebSocket handler runs, so the rules a browser is
 * held to hold here too: the first answer to a card wins, and a card is never answered by a
 * message that was not the user's.
 *
 * One HTTP route reaches this, and only to stop a turn: deleting a chat with `?stopRunning=1`
 * stops that same chat's turn first (origin `delete`). Callers must carry a person's decision (a
 * button the user pressed, a message the user typed, a command the user ran); nothing here
 * decides on the user's behalf.
 */

/**
 * Who, inside the server, is acting on a chat. `assistant` only answers cards and stops turns: the
 * PPM Assistant's messages into chats go through the session tools, as origin `session`.
 * `assistant_card` is the user pressing a button on one of the Assistant's cards, which mirrors a
 * manager chat's own approval or question. `delete` only stops a turn, as the first step of
 * deleting that same chat (`DELETE /chat/sessions/:id?stopRunning=1`); it never sends or answers.
 * `schedule` is a session schedule sending its prompt into the chat it targets: PPM, not the user,
 * so it answers no card and joins no running turn, but the turn it opens is an ordinary one — its
 * approvals are shown and wait for the user, in the chat's own permission mode.
 * `ppm_ui` is PPM sending what the user chose on its own screens (PPM Tasks: a decision's option,
 * "tell the manager now") into the chat it is for, with no browser needed. It answers no card and
 * never steers a running turn: behind one it waits for that turn to end, and the turn it opens is
 * an ordinary one.
 */
export type ServerOrigin = "telegram" | "watch" | "schedule" | "ppm_ui" | "assistant" | "assistant_card" | "delete";

/** The server origins that may answer a card or stop a turn: `ppm_ui` only ever sends a message. */
export type ActingServerOrigin = Exclude<ServerOrigin, "ppm_ui">;

/** The server origins that may send a chat a message (see {@link ChatControl.sendUserMessage}). */
export type MessageServerOrigin = Exclude<ServerOrigin, "assistant" | "assistant_card" | "delete">;

/**
 * Where a message into a chat came from: a browser's socket, the server itself, another
 * session's AI through the session tools (`session`, the PPM Assistant included), or an
 * extension driving a chat it created (`extension`, `src/server/ws/chat-headless-turn.ts`).
 */
export type ChatMessageOrigin = "ws" | ServerOrigin | "session" | "extension";

/**
 * How a message the server sends into a chat went. `delivered` is set for a `schedule` or `ppm_ui`
 * message only: whether it started its turn or waits behind a running one.
 */
export type DeliverResult = { ok: true; sessionId: string; delivered?: SessionDelivery } | { ok: false; error: string };

/**
 * The error a `watch` or `schedule` message gets when the chat is not quiet: a waiting approval
 * card would be cancelled by it and a running turn steered by it, and neither speaks for the user.
 */
export const CHAT_BUSY = "busy";

/**
 * Why a call in an unattended turn was refused without a card. Such a turn carries another chat's
 * words, and an approval card there — one tap on a phone, at a moment the user did not choose —
 * is the shortest path from injected text to an action, so nothing in it is asked at all.
 */
export const UNATTENDED_TURN_REFUSAL = "Refused without asking the user: PPM started this turn on its own to report "
  + "news, so nothing that changes data or needs approval runs in it. Tell the user what you would do and let them ask for it.";

/**
 * Whether the session's running turn is unattended: PPM started it on its own (a watch report)
 * and nobody has written in it since. A message the user types makes the turn theirs.
 */
export const isUnattendedTurn = (sessionId: string): boolean => control?.liveState(sessionId)?.turnOrigin === "watch";

export interface SendUserMessageOpts {
  origin: MessageServerOrigin;
  /** The chat's project; used only when the chat has no live entry yet. */
  projectName: string;
  /** The chat's provider; the stored owner wins when there is one. */
  providerId: string;
  images?: Array<{ data: string; mediaType: string }>;
  /**
   * The mode a turn this message starts runs in; the chat's sticky mode when absent. Refused with
   * `schedule`: a scheduled run uses the chat's own mode, and passing one would overwrite it.
   */
  permissionMode?: string;
  /** The id the turn this message opens is announced under (`turn_started`), when the sender tracks it. */
  clientMessageId?: string;
  /** With `schedule` only, and required by it: which schedule fired, rendered in front of the prompt. */
  scheduleRun?: ScheduleRunReference;
  /** The channel the user typed on, when it is not a PPM screen. */
  channel?: "telegram";
  /**
   * With `telegram` only: the message the user replied to there, quoted as a reply block after
   * their words (data, never their words). Its session and provider must be this chat's.
   */
  replyTo?: ReplyReference;
  /**
   * With `watch` only, and required by it: what the watched chats did. Rendered into the turn's
   * shared context, never into the stored message.
   */
  watchEvents?: WatchEventNotice[];
  /** With `watch` only: news from manager chats (reports, late replies), rendered the same way. */
  wakeNews?: WakeNewsNotice[];
}

/** The approval card a chat shows, as far as a non-browser caller needs it. */
export interface LiveApprovalCard {
  requestId: string;
  tool: string;
  input: unknown;
  /** Present on a PPM Assistant endpoint card: what will happen, built by the server. */
  summary?: ApprovalSummary;
  /** An AskUserQuestion card: answered with choices rather than allow/deny. */
  isQuestion: boolean;
  /** A question card's questions, the same shape for every provider; answer them by id. */
  questions?: NormalizedQuestion[];
  /** When the request gives up by itself if nobody answers (ms since the epoch); absent when it waits for good. */
  expiresAt?: number;
}

/**
 * An answer to a card. A question card is answered with `answersById` (question id → chosen
 * labels or typed text); the server turns it into what the asking provider expects. `answers`
 * is the provider's own shape as an older browser tab sends it, still read for a question card.
 */
export interface ApprovalAnswer {
  approved: boolean;
  answersById?: AnswersById;
  answers?: unknown;
}

export interface LiveChatState {
  phase: SessionPhase;
  /** A turn is in flight (anything but idle). */
  running: boolean;
  projectName: string;
  providerId: string;
  card?: LiveApprovalCard;
  /** Cards waiting behind the shown one. */
  queuedCards: number;
  /**
   * Who sent the chat's latest message, which is whose turn the running one is. A message the
   * user types mid-turn makes it theirs. A `watch` turn is nobody's: nothing in it may ask the
   * user to approve anything.
   */
  turnOrigin?: ChatMessageOrigin;
  /**
   * The id of the latest turn the chat opened (`turn_started`), kept past its end. A card that
   * waited acts only on the turn it showed: a new turn has a new id.
   */
  turnId?: string;
  /** When the running turn left idle (ms since the epoch); absent while idle. */
  runningSince?: number;
}

export interface ChatControl {
  /**
   * Delivers `text` as the user's message. `telegram` is the user typing elsewhere: it answers a
   * waiting card the way a typed message does, and leaves no PPM screen as "the chatting device".
   * `watch` and `schedule` are never the user: they are refused with {@link CHAT_BUSY} while a card
   * waits or a turn runs. A message joining a running turn carries its `channel` too.
   */
  sendUserMessage(sessionId: string, text: string, opts: SendUserMessageOpts): Promise<DeliverResult>;
  /**
   * Answers a card; "stale" when nothing waits on that id any more (answered elsewhere, ended).
   * Answers to questions the card does not ask are dropped; check them first with
   * `answersByIdError` when they come from anywhere but a person's own form.
   */
  answerApproval(sessionId: string, requestId: string, answer: ApprovalAnswer, origin: ActingServerOrigin): "answered" | "stale";
  /** Stops the running turn; false when the chat has no live entry. */
  cancelTurn(sessionId: string, origin: ActingServerOrigin): boolean;
  /** What a live chat is doing now; null when it has no entry in this process. */
  liveState(sessionId: string): LiveChatState | null;
  /**
   * Whether a message sent under `clientMessageId` still waits behind a turn to open its own.
   * False once it opened one or is gone without opening any (Stop killed the subprocess with its
   * queue); null when the chat's provider cannot say.
   */
  messageQueued?(sessionId: string, clientMessageId: string): boolean | null;
  /** Every chat with a live entry in this process. */
  listLive(): Array<LiveChatState & { sessionId: string }>;
}

let control: ChatControl | null = null;

/** `ws/chat.ts` registers its implementation; null unregisters it (tests). */
export function setChatControl(c: ChatControl | null): void {
  control = c;
}

/** The registered implementation, or null when no chat socket layer runs in this process. */
export const chatControl = (): ChatControl | null => control;
