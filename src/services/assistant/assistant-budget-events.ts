import { createLogger } from "../logger.ts";
import type { BudgetHit } from "../session-collab/assistant-send-guards.ts";

/**
 * The PPM Assistant paused messaging manager chats on its own (a budget ran out), or was let go
 * again by the user's next message. In-process only: the card the user sees ("Assistant paused
 * messaging managers until you reply") is built from these by the Assistant's card service.
 */
export type AssistantBudgetEvent =
  | { type: "paused"; sessionId: string; reason: BudgetHit; at: number }
  | { type: "resumed"; sessionId: string; at: number };

type Listener = (event: AssistantBudgetEvent) => void;

const log = createLogger("assistant-budget");
const listeners = new Set<Listener>();

export const assistantBudgetEvents = {
  /** Subscribes; the returned function unsubscribes. */
  on(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  emit(event: AssistantBudgetEvent): void {
    log.info(event.type === "paused"
      ? `session=${event.sessionId} paused messaging manager chats on its own (${event.reason} budget)`
      : `session=${event.sessionId} may message manager chats on its own again`);
    for (const listener of [...listeners]) {
      try { listener(event); } catch (e) { log.warn(`budget listener failed: ${(e as Error).message}`); }
    }
  },
};
