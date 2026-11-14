import { createLogger } from "../logger.ts";
import type { AssistantClock, Cancel } from "../assistant-wake/assistant-clock.ts";

/**
 * Quiet hours for the cards a watched chat puts on its screen: while they are on, such a card is
 * not sent to the phone but held here, and when they end it goes out if the chat still waits on
 * it. A card answered meanwhile (in PPM, by a new message, by the turn ending) is skipped, so
 * nothing stale arrives in the morning. Only urgent reports reach the phone in quiet hours, and a
 * watched chat's approval is never one.
 *
 * Held in memory: a restart drops what is held, and the card itself stays in PPM for as long as
 * the chat still shows it.
 */

const log = createLogger("assistant-telegram");
const MIN_TIMER_MS = 1000;
/** Bounds a night of a busy watched chat; the oldest held card goes first. */
const MAX_HELD = 100;

export interface QuietHoldDeps {
  clock: AssistantClock;
  /** When the quiet window now running ends; null outside quiet hours. */
  quietEnd(): number | null;
  /** Whether the chat still shows this request. */
  stillWaiting(sessionId: string, requestId: string): boolean;
}

export interface HeldDecision {
  targetSessionId: string;
  card: { requestId: string };
}

export interface QuietHold<T extends HeldDecision> {
  /** Holds the item when quiet hours are on now; false means send it at once. */
  offer(item: T): boolean;
  /** Sends what was held once quiet hours are over, skipping what no longer waits. */
  flush(): void;
  /** Drops everything held (the bridge stopped). */
  clear(): void;
  size(): number;
}

/** `what` names the held items in the log line at the end of quiet hours. */
export function createQuietHold<T extends HeldDecision>(deps: QuietHoldDeps, release: (item: T) => void, what = "watched-chat card"): QuietHold<T> {
  const held = new Map<string, T>();
  let timer: Cancel | null = null;

  const safeQuietEnd = (): number | null => {
    try { return deps.quietEnd(); } catch (e) { log.warn(`quiet hours unreadable, sending: ${(e as Error).message}`); return null; }
  };

  function schedule(at: number): void {
    timer?.();
    timer = deps.clock.setTimer(() => { timer = null; flush(); }, Math.max(MIN_TIMER_MS, at - deps.clock.now()));
  }

  function flush(): void {
    const end = safeQuietEnd();
    if (end !== null) { if (held.size) schedule(end); return; }
    const items = [...held.values()];
    held.clear();
    let sent = 0;
    for (const item of items) {
      let waiting = false;
      try { waiting = deps.stillWaiting(item.targetSessionId, item.card.requestId); } catch { /* unknown: not sent late */ }
      if (!waiting) continue;
      sent++;
      try { release(item); } catch (e) { log.warn(`held card ${item.card.requestId} not sent: ${(e as Error).message}`); }
    }
    if (items.length) log.info(`quiet hours over: ${sent} of ${items.length} held ${what}(s) still waiting, sent`);
  }

  return {
    offer(item: T): boolean {
      const end = safeQuietEnd();
      if (end === null) return false;
      held.set(item.card.requestId, item);
      if (held.size > MAX_HELD) held.delete(held.keys().next().value!);
      if (!timer) schedule(end);
      return true;
    },
    flush,
    clear(): void {
      held.clear();
      timer?.();
      timer = null;
    },
    size: (): number => held.size,
  };
}
