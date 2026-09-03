/**
 * React wrapper around `CollisionPromptQueue`. Owns one queue instance per window/surface
 * (`use-explorer-actions.ts` and `use-drop-transfer.tsx` each hold their own), exposing the
 * dialog-facing state plus the `resolve`/`startBatch`/`endBatch` trio that `TransferContext`
 * plugs into `transfer()` and `uploadEntries()`.
 */

import { useMemo, useRef, useState } from "react";
import { CollisionPromptQueue, type CollisionChoice, type CollisionRequest } from "./collision-prompt-queue";

export interface CollisionPromptState extends CollisionRequest {
  /** How many more collisions are queued behind this one. */
  remaining: number;
  applyToAll: boolean;
  setApplyToAll(value: boolean): void;
  resolve(choice: CollisionChoice): void;
}

export interface CollisionPrompt {
  /** Render-ready state for the dialog, or `null` when nothing is queued. */
  state: CollisionPromptState | null;
  resolve(request: CollisionRequest): Promise<CollisionChoice>;
  startBatch(): void;
  endBatch(): void;
}

export function useCollisionPrompt(): CollisionPrompt {
  const [tick, setTick] = useState(0);
  const [applyToAll, setApplyToAll] = useState(false);
  const queueRef = useRef<CollisionPromptQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = new CollisionPromptQueue(() => setTick((n) => n + 1));
  }
  const queue = queueRef.current;

  return useMemo(() => {
    const snapshot = queue.snapshot();
    return {
      state: snapshot && {
        ...snapshot.request,
        remaining: snapshot.remaining,
        applyToAll,
        setApplyToAll,
        resolve: (choice) => {
          queue.choose(choice, applyToAll);
          setApplyToAll(false);
        },
      },
      resolve: (request) => queue.request(request),
      startBatch: () => queue.startBatch(),
      endBatch: () => queue.endBatch(),
    };
    // `tick` has no direct use below — it exists purely to force this memo to recompute
    // whenever the queue notifies of a change (new request queued, or one resolved).
  }, [queue, applyToAll, tick]);
}
