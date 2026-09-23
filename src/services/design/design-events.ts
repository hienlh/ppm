/**
 * Design change notifications, in the same shape as the file watcher's `onFileChange`.
 *
 * `.design/` is deliberately invisible to the file watcher (one design's snapshot history
 * alone can hold thousands of directories), so history and comment changes are announced
 * here instead — once per operation, not once per copied file. `ws/global.ts` relays each
 * one to browsers as `design:<type>`.
 *
 * Services only know the project *path*; the relay maps it to a project name.
 */

export type DesignEventType = "history_changed" | "comments_changed";

export interface DesignEventPayload {
  projectPath: string;
  slug: string;
}

type DesignEventCallback = (type: DesignEventType, payload: DesignEventPayload) => void;

const callbacks = new Set<DesignEventCallback>();

/** Subscribe; returns the unsubscribe function. */
export function onDesignEvent(cb: DesignEventCallback): () => void {
  callbacks.add(cb);
  return () => {
    callbacks.delete(cb);
  };
}

export function emitDesignEvent(type: DesignEventType, payload: DesignEventPayload): void {
  for (const cb of callbacks) {
    // A failing subscriber must not turn a completed snapshot or restore into an error.
    try {
      cb(type, payload);
    } catch (e) {
      console.warn(`[design] ${type} subscriber failed: ${(e as Error).message}`);
    }
  }
}
