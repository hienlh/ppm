/**
 * Serializes the "no Trash on this host" confirm (`ctx.confirmPermanentOverwrite`) behind the
 * same one-at-a-time queue as the collision prompt (`SerialPromptQueue`, see
 * `collision-prompt-queue.ts`). This confirm used to be its own bare `useState` slot with the
 * exact same race: a Replace that hits `NO_TRASH` on two concurrent jobs could have the second
 * call silently overwrite the first's dialog, leaving the first job's promise unresolved
 * forever. No "apply to all" here — it is a much rarer prompt than a name collision, so a
 * plain FIFO queue is all it needs.
 */

import { useMemo, useRef, useState } from "react";
import { SerialPromptQueue } from "./collision-prompt-queue";

export interface PermanentOverwritePromptState {
  name: string;
  /** How many more confirms are queued behind this one. */
  remaining: number;
  resolve(proceed: boolean): void;
}

export interface PermanentOverwritePrompt {
  state: PermanentOverwritePromptState | null;
  confirm(name: string): Promise<boolean>;
}

export function usePermanentOverwritePrompt(): PermanentOverwritePrompt {
  const [tick, setTick] = useState(0);
  const queueRef = useRef<SerialPromptQueue<string, boolean> | null>(null);
  if (!queueRef.current) {
    queueRef.current = new SerialPromptQueue(() => setTick((n) => n + 1));
  }
  const queue = queueRef.current;

  return useMemo(() => {
    const snapshot = queue.snapshot();
    return {
      state: snapshot && {
        name: snapshot.request,
        remaining: snapshot.remaining,
        resolve: (proceed) => queue.choose(proceed),
      },
      confirm: (name) => queue.request(name),
    };
    // `tick` has no direct use below — it forces this memo to recompute whenever the queue
    // notifies of a change (new confirm queued, or one resolved).
  }, [queue, tick]);
}
