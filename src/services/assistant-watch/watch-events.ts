import { createLogger } from "../logger.ts";
import type { LiveApprovalCard } from "../chat-control/chat-control.ts";
import type { WatchEventKind } from "../../types/chat.ts";

/**
 * What a watch has to tell the user's other channels (the Telegram relay listens here), without
 * the watch knowing who they are.
 *
 * - `watch_decision`: a watched chat put a card on its screen. No model runs for it: whoever
 *   listens shows the card itself, with buttons the user presses.
 * - `watch_reported`: the Assistant session finished a watch turn with an answer; `text` is that
 *   answer as the turn ended it. Sent once per watch it reported on.
 *
 * Synchronous, like the chat lifecycle bus it is fed from: a listener only enqueues. A listener
 * that throws is logged and the others still run.
 */
export interface WatchEvents {
  watch_decision: {
    watchId: string;
    /** The Assistant session that set the watch, by its current id. */
    assistantSessionId: string;
    /** The watched chat, by its current id. */
    targetSessionId: string;
    targetProject: string;
    targetProvider: string;
    targetTitle: string;
    card: LiveApprovalCard;
  };
  watch_reported: {
    watchId: string;
    assistantSessionId: string;
    targetSessionId: string;
    targetProject: string;
    targetTitle: string;
    kind: WatchEventKind;
    /** The Assistant's report: the opening of the watch turn's final answer. */
    text: string;
  };
}

export type WatchEventName = keyof WatchEvents;

const log = createLogger("assistant-watch");

function createWatchEvents() {
  const listeners = new Map<WatchEventName, Set<(payload: never) => void>>();

  /** Subscribes; the returned function unsubscribes. */
  function on<K extends WatchEventName>(name: K, listener: (payload: WatchEvents[K]) => void): () => void {
    let set = listeners.get(name);
    if (!set) listeners.set(name, set = new Set());
    set.add(listener as (payload: never) => void);
    return () => { set!.delete(listener as (payload: never) => void); };
  }

  function emit<K extends WatchEventName>(name: K, payload: WatchEvents[K]): void {
    for (const listener of [...(listeners.get(name) ?? [])]) {
      try {
        (listener as (p: WatchEvents[K]) => void)(payload);
      } catch (e) {
        log.warn(`listener for "${name}" failed (watch=${payload.watchId}): ${(e as Error)?.message ?? e}`);
      }
    }
  }

  return { on, emit };
}

/** The process-wide bus the watch service emits on. */
export const watchEvents = createWatchEvents();
