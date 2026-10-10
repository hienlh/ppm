import type { SessionPhase } from "../../types/api.ts";
import type { ApprovalSummary } from "../../shared/assistant-approval.ts";
import type { DeliverResult } from "../assistant-mcp/assistant-chat-send.ts";

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
 * No HTTP route reaches this. Callers must carry a person's decision (a button the user pressed,
 * a message the user typed); nothing here decides on the user's behalf.
 */

/** Who, inside the server, is acting on a chat. */
export type ServerOrigin = "telegram" | "watch" | "assistant";

/** Where a message into a chat came from: a browser's socket, or the server itself. */
export type ChatMessageOrigin = "ws" | ServerOrigin;

/**
 * The error a `watch` message gets when the chat is not quiet: a waiting approval card would be
 * cancelled by it and a running turn steered by it, and a watch never speaks for the user.
 */
export const CHAT_BUSY = "busy";

export interface SendUserMessageOpts {
  origin: ServerOrigin;
  /** The chat's project; used only when the chat has no live entry yet. */
  projectName: string;
  /** The chat's provider; the stored owner wins when there is one. */
  providerId: string;
  images?: Array<{ data: string; mediaType: string }>;
  /** The mode a turn this message starts runs in; the chat's sticky mode when absent. */
  permissionMode?: string;
  /** The channel the user typed on, when it is not a PPM screen. */
  channel?: "telegram";
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
}

export interface ChatControl {
  /**
   * Delivers `text` as the user's message. `telegram` is the user typing elsewhere: it answers a
   * waiting card the way a typed message does, and leaves no PPM screen as "the chatting device".
   * `watch` is never the user: it is refused with {@link CHAT_BUSY} while a card waits or a turn
   * runs. A message joining a running turn carries its `channel` too.
   */
  sendUserMessage(sessionId: string, text: string, opts: SendUserMessageOpts): Promise<DeliverResult>;
  /** Answers a card; "stale" when nothing waits on that id any more (answered elsewhere, ended). */
  answerApproval(
    sessionId: string,
    requestId: string,
    answer: { approved: boolean; answers?: unknown },
    origin: ServerOrigin,
  ): "answered" | "stale";
  /** Stops the running turn; false when the chat has no live entry. */
  cancelTurn(sessionId: string, origin: ServerOrigin): boolean;
  /** What a live chat is doing now; null when it has no entry in this process. */
  liveState(sessionId: string): LiveChatState | null;
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
