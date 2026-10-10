import { createLogger } from "../logger.ts";
import type { TurnStop } from "../../shared/turn-stop.ts";
import type { ChatMessageOrigin, LiveApprovalCard, ServerOrigin } from "./chat-control.ts";

/**
 * Everything that happens in a chat session, for listeners inside the server — a Telegram
 * bridge, a watch waiting for a chat to finish — that have no browser socket to hear it on.
 *
 * Emitted by `ws/chat.ts`, whether or not any browser is connected: a turn started from Telegram
 * has no client at all, and its events would otherwise be dropped where the socket layer drops
 * them.
 *
 * `emit` is synchronous and runs on the chat's hot path (every streamed chunk is a `stream`
 * event), so a listener must only record or enqueue and return; batching and network work happen
 * elsewhere. A listener that throws never reaches the chat: the error is logged and the turn goes
 * on.
 */
export interface ChatLifecycleEvents {
  /** Every event the chat sends its browsers, in order, as they receive it. */
  stream: { sessionId: string; event: unknown };
  /** A message entered the chat, after its slash/skill rewrites — what actually runs. */
  user_message: {
    sessionId: string;
    text: string;
    origin: ChatMessageOrigin;
    imageCount: number;
    projectName: string;
    providerId: string;
  };
  /** A card is now on the chat's screen (a queued one only once it reaches the front). */
  approval_shown: { sessionId: string; card: LiveApprovalCard; projectName: string; providerId: string };
  /**
   * A card left, answered or not. `by` names who answered; absent when it went for another
   * reason (`reason`: the turn ended, a message superseded it, the turn was stopped). May name a
   * card that was queued and never shown — a listener that never saw it ignores it.
   */
  approval_resolved: {
    sessionId: string;
    requestId: string;
    approved: boolean;
    answers?: unknown;
    reason: string;
    by?: ChatMessageOrigin;
  };
  /**
   * The turn is over and the chat is idle. `stopped`: an error or a limit ended it (`stop` says
   * which), or it ended without saying how (the turn was stopped). `failed`: the provider threw.
   */
  turn_ended: {
    sessionId: string;
    outcome: "done" | "stopped" | "failed";
    /** The opening of the turn's final answer, as a notification would quote it. */
    finalText?: string;
    stop?: TurnStop;
    error?: string;
    /** The turn was stopped on request (Stop, `/stop`), by whoever asked — not cut off by an error. */
    cancelledBy?: ChatMessageOrigin;
    projectName: string;
    providerId: string;
  };
  /** The provider renamed the session; every later event uses `newSessionId`. */
  migrated: { oldSessionId: string; newSessionId: string };
}

export type ChatLifecycleEventName = keyof ChatLifecycleEvents;
export type ChatLifecycleListener<K extends ChatLifecycleEventName> = (payload: ChatLifecycleEvents[K]) => void;

/** Re-exported so listeners need one import for the origins they compare against. */
export type { ChatMessageOrigin, ServerOrigin };

const log = createLogger("chat-lifecycle");

export function createChatLifecycle() {
  const listeners = new Map<ChatLifecycleEventName, Set<(payload: never) => void>>();
  /** Event names whose listener failure has been said at WARN; later ones go to DEBUG. */
  const warned = new Set<ChatLifecycleEventName>();

  /** Subscribes; the returned function unsubscribes. */
  function on<K extends ChatLifecycleEventName>(name: K, listener: ChatLifecycleListener<K>): () => void {
    let set = listeners.get(name);
    if (!set) listeners.set(name, set = new Set());
    set.add(listener as (payload: never) => void);
    return () => { set!.delete(listener as (payload: never) => void); };
  }

  function emit<K extends ChatLifecycleEventName>(name: K, payload: ChatLifecycleEvents[K]): void {
    const set = listeners.get(name);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        (listener as ChatLifecycleListener<K>)(payload);
      } catch (e) {
        const ids = payload as { sessionId?: string; oldSessionId?: string };
        const line = `listener for "${name}" failed (session=${ids.sessionId ?? ids.oldSessionId ?? "?"}): ${(e as Error)?.message ?? e}`;
        // Said loudly once per event name: a broken listener fails on every chunk of every turn.
        if (warned.has(name)) log.debug(line);
        else { warned.add(name); log.warn(line); }
      }
    }
  }

  /** Whether anything listens for `name`; lets an emitter skip building a payload nobody reads. */
  function has(name: ChatLifecycleEventName): boolean {
    return (listeners.get(name)?.size ?? 0) > 0;
  }

  return { on, emit, has };
}

export type ChatLifecycle = ReturnType<typeof createChatLifecycle>;

/** The process-wide bus `ws/chat.ts` emits on. */
export const chatLifecycle: ChatLifecycle = createChatLifecycle();
