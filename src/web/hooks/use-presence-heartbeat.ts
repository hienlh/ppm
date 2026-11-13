import { useEffect } from "react";
import { notePresenceInput, retryPendingPresenceInput } from "@/lib/presence-input";
import { onGlobalReady } from "@/lib/global-ws-channel";

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/**
 * Mounted once in the app shell. Turns a person's real input anywhere in the document into
 * throttled `presence:input` sends, so core's presence tracker can tell "someone is at this
 * PPM" from "a tab merely has a document open". Only counts while this tab is the visible one:
 * a backgrounded tab does not get input a person is actually looking at.
 *
 * Also owns the `global_ready` subscription that retries an input dropped before `/ws/global`
 * finished connecting (the first real input after a page load is the common case) — scoped to
 * this effect's own mount/unmount rather than registered once at module load, so it exists only
 * while this hook is actually mounted. See `presence-input.ts`'s module doc for why that matters.
 */
export function usePresenceHeartbeat(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onInput = () => {
      if (document.visibilityState === "visible") notePresenceInput();
    };
    const options: AddEventListenerOptions = { passive: true, capture: true };
    for (const type of ACTIVITY_EVENTS) document.addEventListener(type, onInput, options);
    const unsubscribeReady = onGlobalReady(retryPendingPresenceInput);
    return () => {
      for (const type of ACTIVITY_EVENTS) document.removeEventListener(type, onInput, options);
      unsubscribeReady();
    };
  }, [enabled]);
}
