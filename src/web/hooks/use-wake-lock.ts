/**
 * Keeps the device screen lit while a chat turn is in flight.
 *
 * The whole point is a tablet or phone propped up next to you: a long turn produces no touch
 * input, so the OS dims and locks the screen mid-answer and you lose the thread. The browser's
 * Screen Wake Lock API asks the OS not to do that, and this hook holds the lock exactly for as
 * long as something is running.
 *
 * Scoped to the *device*, not the project. Favicon and title are per-project because a window
 * shows one project, but there is one screen — scoping the lock to the active project would
 * dim the display while another project's turn is still running.
 *
 * "Running" is `phase !== "idle"`, which is what `streaming-store` records. That deliberately
 * includes the wait on an approval or an AskUserQuestion card: the server leaves the phase at
 * `thinking` while the SDK blocks on the answer, and a screen that dies right as the agent asks
 * you something is the worst moment to lose it.
 */

import { useEffect } from "react";
import { useStreamingStore } from "@/stores/streaming-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWakeLockStore } from "@/stores/wake-lock-store";

/** The slice of `WakeLockSentinel` this code touches. Declared structurally so the file does
 *  not depend on the DOM lib shipping the type. */
export interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
}

/** Why the feature is or is not available here — the Settings switch explains itself with this. */
export type WakeLockSupport = "ok" | "insecure" | "unsupported";

/**
 * The API is gated on a secure context, so PPM reached over plain HTTP — the usual
 * `http://192.168.x.x:3211` LAN address — has no `navigator.wakeLock` at all. That is by far the
 * likeliest reason this does nothing on someone's tablet, and it deserves a distinct answer
 * from "your browser is too old".
 */
export function wakeLockSupport(): WakeLockSupport {
  if (typeof navigator !== "undefined" && "wakeLock" in navigator) return "ok";
  if (typeof window !== "undefined" && window.isSecureContext === false) return "insecure";
  return "unsupported";
}

export interface WakeLockSessionDeps {
  /** Acquire a lock. Rejects when the platform refuses (battery saver, low battery, hidden tab). */
  request: () => Promise<WakeLockSentinelLike>;
  isVisible: () => boolean;
  /** Subscribe to visibility changes; returns an unsubscribe. */
  onVisibilityChange: (listener: () => void) => () => void;
  /** Reports whether a lock is actually held, for the indicator. */
  onActive: (active: boolean) => void;
}

/**
 * Holds a wake lock until the returned teardown runs.
 *
 * The re-acquire on `visibilitychange` is not optional. Browsers release the lock every time the
 * document is hidden — switching tabs, switching apps, a manual screen lock — and never restore
 * it. Without this listener the feature works once and then silently stops for the rest of the
 * session, which is the classic way to get this wrong.
 *
 * A refusal is a normal outcome, not an error: the platform is allowed to say no when the
 * battery is low or a power-saving mode is on. Retrying in a loop would only burn what little
 * battery prompted the refusal, so a failed attempt just waits for the next visibility change.
 */
export function startWakeLockSession(deps: WakeLockSessionDeps): () => void {
  let sentinel: WakeLockSentinelLike | null = null;
  let stopped = false;
  // `sentinel` is only assigned after the request resolves, so it cannot by itself stop a second
  // attempt started while the first is still in flight — which is exactly what rapid tab
  // flapping produces, and it would leak the lock the second attempt overwrites.
  let acquiring = false;

  const acquire = async (): Promise<void> => {
    if (stopped || sentinel || acquiring || !deps.isVisible()) return;
    acquiring = true;
    try {
      const next = await deps.request();
      // Teardown may have run while the request was in flight; do not leak the lock.
      if (stopped) {
        void next.release().catch(() => {});
        return;
      }
      sentinel = next;
      next.addEventListener("release", () => {
        // The platform took it back. Drop our handle so a later visibility change can re-acquire.
        if (sentinel === next) sentinel = null;
        if (!stopped) deps.onActive(false);
      });
      deps.onActive(true);
    } catch {
      deps.onActive(false);
    } finally {
      acquiring = false;
    }
  };

  const unsubscribe = deps.onVisibilityChange(() => {
    if (deps.isVisible()) {
      void acquire();
      return;
    }
    // Hidden: the browser always releases the lock here. Drop our handle now instead of waiting
    // for the `release` event, because the two are separate tasks with no guaranteed order — if
    // `visibilitychange` fires first on the way back, a stale handle would make `acquire` think
    // a lock is still held and skip the re-acquire for the rest of the session.
    sentinel = null;
    deps.onActive(false);
  });

  void acquire();

  return () => {
    stopped = true;
    unsubscribe();
    deps.onActive(false);
    const held = sentinel;
    sentinel = null;
    if (held) void held.release().catch(() => {});
  };
}

/** Mount once, app-wide. */
export function useWakeLock(): void {
  const anyRunning = useStreamingStore((s) => s.sessions.size > 0);
  const enabled = useSettingsStore((s) => s.keepScreenAwake);

  useEffect(() => {
    if (!enabled || !anyRunning) return;
    if (wakeLockSupport() !== "ok") return;

    const wakeLock = (navigator as Navigator & {
      wakeLock: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
    }).wakeLock;

    return startWakeLockSession({
      request: () => wakeLock.request("screen"),
      isVisible: () => document.visibilityState === "visible",
      onVisibilityChange: (listener) => {
        document.addEventListener("visibilitychange", listener);
        return () => document.removeEventListener("visibilitychange", listener);
      },
      onActive: (active) => useWakeLockStore.getState().setActive(active),
    });
  }, [enabled, anyRunning]);
}
