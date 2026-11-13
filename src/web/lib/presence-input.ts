/**
 * "A person just interacted with PPM" → `presence:input` on `/ws/global`, throttled to at most
 * one send per 60s. Shared by the document-level heartbeat (`use-presence-heartbeat.ts`) and
 * any extension webview's explicit `__ppm.userActivity` message
 * (`webview-user-activity.ts` / `extension-webview.tsx`), so a burst from either source — or
 * both in the same minute — costs one send, not one per event.
 *
 * The very first input after a page load often happens before `/ws/global` has finished
 * connecting, so `sendIfOpen` drops it. That attempt is kept as "pending" rather than treated
 * as sent: it does not arm the 60s throttle, and `retryPendingPresenceInput` resends it the
 * moment the socket reports `global_ready`, bypassing the throttle window since nothing was
 * actually sent yet. Arming the throttle on a dropped send (the old behaviour) spent the
 * one-send-per-60s budget on an attempt nobody received, so the next *real* input — the first
 * one the socket could have actually delivered — was silently swallowed for up to a minute, long
 * enough that a presence-aware watcher treated someone who had just loaded the page as away.
 *
 * `retryPendingPresenceInput` is deliberately NOT subscribed to `onGlobalReady` in this module:
 * this file is imported (and its module body run) far more widely than any one component's
 * lifetime, so a subscription made here would never be torn down and would answer every later
 * `global_ready` for the rest of the process — in a test run that shares one process across
 * files, a listener registered this way outlives the file that happened to trigger the import
 * and can fire inside an unrelated test's own `notifyGlobalReady()` call. `usePresenceHeartbeat`
 * owns the subscription instead, inside the same effect that already has a matching mount/unmount
 * pair, so it exists only while the app shell that needs it is actually mounted.
 */
import { sendIfOpen } from "./global-ws-channel.ts";

export const PRESENCE_SEND_THROTTLE_MS = 60_000;

export interface PresenceInputNotifier {
  /** Call on real input. Sends at once, or throttles, exactly as a bare notifier function would. */
  notify: () => void;
  /** Call when the socket becomes ready. A no-op unless the last `notify()` was dropped. */
  retryIfPending: () => void;
}

/** Test seam: inject the sender and the clock instead of the real socket and `Date.now`. */
export function createPresenceInputNotifier(
  send: (message: string) => boolean = sendIfOpen,
  now: () => number = Date.now,
): PresenceInputNotifier {
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

  return {
    notify: () => {
      const t = now();
      if (!pending && t - lastSentAt < PRESENCE_SEND_THROTTLE_MS) return;
      attemptSend(t);
    },
    retryIfPending: () => {
      if (pending) attemptSend(now());
    },
  };
}

const sharedNotifier = createPresenceInputNotifier();

/** The one throttled notifier the app shell's heartbeat and every webview panel share. */
export const notePresenceInput = sharedNotifier.notify;

/** Resend a dropped presence input now that the socket is ready. A no-op when nothing is
 *  pending. Call this from `onGlobalReady`, scoped to a component's own mount lifecycle —
 *  see the module doc comment for why it is not wired up here. */
export const retryPendingPresenceInput = sharedNotifier.retryIfPending;
