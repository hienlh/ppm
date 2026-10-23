import { useEffect } from "react";
import { notePresenceInput } from "@/lib/presence-input";

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/**
 * Mounted once in the app shell. Turns a person's real input anywhere in the document into
 * throttled `presence:input` sends, so core's presence tracker can tell "someone is at this
 * PPM" from "a tab merely has a document open". Only counts while this tab is the visible one:
 * a backgrounded tab does not get input a person is actually looking at.
 */
export function usePresenceHeartbeat(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onInput = () => {
      if (document.visibilityState === "visible") notePresenceInput();
    };
    const options: AddEventListenerOptions = { passive: true, capture: true };
    for (const type of ACTIVITY_EVENTS) document.addEventListener(type, onInput, options);
    return () => {
      for (const type of ACTIVITY_EVENTS) document.removeEventListener(type, onInput, options);
    };
  }, [enabled]);
}
