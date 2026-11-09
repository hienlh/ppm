import { useSyncExternalStore } from "react";

/**
 * Re-renders the caller every half minute, for labels such as "5m ago".
 *
 * The chat's labels used to stay current only because the whole transcript was redrawn on
 * every render of the chat; now that it is not, they ask for the time themselves. One timer for
 * the page, running only while a label is mounted.
 */
export const RELATIVE_TIME_TICK_MS = 30_000;

let tick = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => {
    tick++;
    for (const notify of listeners) notify();
  }, RELATIVE_TIME_TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const snapshot = () => tick;

export function useRelativeTimeTick(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
