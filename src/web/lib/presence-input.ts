/**
 * "A person just interacted with PPM" → `presence:input` on `/ws/global`, throttled to at most
 * one send per 60s. Shared by the document-level heartbeat (`use-presence-heartbeat.ts`) and
 * any extension webview's explicit `__ppm.userActivity` message
 * (`webview-user-activity.ts` / `extension-webview.tsx`), so a burst from either source — or
 * both in the same minute — costs one send, not one per event.
 */
import { sendIfOpen } from "./global-ws-channel.ts";

export const PRESENCE_SEND_THROTTLE_MS = 60_000;

/** Test seam: inject the sender and the clock instead of the real socket and `Date.now`. */
export function createPresenceInputNotifier(
  send: (message: string) => boolean = sendIfOpen,
  now: () => number = Date.now,
): () => void {
  let lastSentAt = -Infinity;
  return () => {
    const t = now();
    if (t - lastSentAt < PRESENCE_SEND_THROTTLE_MS) return;
    lastSentAt = t;
    send(JSON.stringify({ type: "presence:input" }));
  };
}

/** The one throttled notifier the app shell's heartbeat and every webview panel share. */
export const notePresenceInput = createPresenceInputNotifier();
