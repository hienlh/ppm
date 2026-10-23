/**
 * "A person just interacted with PPM" → `presence:input` on `/ws/global`, throttled to at most
 * one send per 60s. Shared by the document-level heartbeat (`use-presence-heartbeat.ts`) and
 * any extension webview's explicit `__ppm.userActivity` message
 * (`webview-user-activity.ts` / `extension-webview.tsx`), so a burst from either source — or
 * both in the same minute — costs one send, not one per event.
 *
 * The very first input after a page load often happens before `/ws/global` has finished
 * connecting, so `sendIfOpen` drops it. That attempt is kept as "pending" rather than treated
 * as sent: it does not arm the 60s throttle, and it is retried the moment the socket reports
 * `global_ready` (`onGlobalReady`), bypassing the throttle window since nothing was actually
 * sent yet. Arming the throttle on a dropped send (the old behaviour) spent the one-send-per-60s
 * budget on an attempt nobody received, so the next *real* input — the first one the socket
 * could have actually delivered — was silently swallowed for up to a minute, long enough that a
 * presence-aware watcher treated someone who had just loaded the page as away.
 */
import { onGlobalReady, sendIfOpen } from "./global-ws-channel.ts";

export const PRESENCE_SEND_THROTTLE_MS = 60_000;

/** Test seam: inject the sender, the clock and the ready-subscription instead of the real
 *  socket, `Date.now` and `onGlobalReady`. */
export function createPresenceInputNotifier(
  send: (message: string) => boolean = sendIfOpen,
  now: () => number = Date.now,
  subscribeReady: (listener: () => void) => () => void = onGlobalReady,
): () => void {
  let lastSentAt = -Infinity;
  /** True once an input happened but `send` could not deliver it yet. */
  let pending = false;

  const attemptSend = (t: number): void => {
    if (send(JSON.stringify({ type: "presence:input" }))) {
      lastSentAt = t;
      pending = false;
    } else {
      pending = true;
    }
  };

  // Retry a dropped send as soon as the socket is actually ready, with no new input required.
  subscribeReady(() => {
    if (pending) attemptSend(now());
  });

  return () => {
    const t = now();
    if (!pending && t - lastSentAt < PRESENCE_SEND_THROTTLE_MS) return;
    attemptSend(t);
  };
}

/** The one throttled notifier the app shell's heartbeat and every webview panel share. */
export const notePresenceInput = createPresenceInputNotifier();
