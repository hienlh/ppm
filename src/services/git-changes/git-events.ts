/**
 * Git change notifications, in the shape of `design-events.ts`: the git routes
 * emit, and `ws/global.ts` relays each one to browsers unchanged.
 */
import type { GitEvent } from "../../shared/git-changes.ts";

type GitEventCallback = (event: GitEvent) => void;

const callbacks = new Set<GitEventCallback>();

/** Subscribe; returns the unsubscribe function. */
export function onGitEvent(cb: GitEventCallback): () => void {
  callbacks.add(cb);
  return () => {
    callbacks.delete(cb);
  };
}

export function emitGitEvent(event: GitEvent): void {
  for (const cb of callbacks) {
    // A failing subscriber must not turn a completed git command into an error.
    try {
      cb(event);
    } catch (e) {
      console.warn(`[git] ${event.type} subscriber failed: ${(e as Error).message}`);
    }
  }
}
