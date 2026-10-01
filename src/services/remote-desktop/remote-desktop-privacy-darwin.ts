/**
 * The macOS half of privacy mode — and on macOS it is **refused**, because the one mechanism
 * Bun can reach was measured against a real keyboard and does not work. The X11 counterpart,
 * which does, is in `remote-desktop-privacy.ts`.
 *
 * This file is short and the reason it exists is the measurement, so the measurement is the
 * documentation.
 *
 * **What was built, and why it looked right.** Every `CGEventSource` carries a *local events
 * suppression interval*: the time after that source posts an event during which the window
 * server is documented to drop real hardware events. It needs no run loop, so it is the only
 * candidate Bun can reach (see the tap note below). Holding the host's input is then a long
 * interval plus a heartbeat to keep the window open — a **zero-line scroll wheel event**, the
 * one event shape guaranteed to move nothing, since a mouse move would need the cursor position
 * (`CGEventGetLocation` returns a struct by value, which bun:ffi cannot read — the same limit
 * `remote-desktop-input-darwin.ts` records) and a key event would disturb modifier state.
 *
 * **Every observable said it was working.** Measured on this host: the interval reads back
 * `0.25 → 3` exactly, `kCGEventFilterMaskPermitAllEvents` is 7 while the filter already sits at
 * `0x0` (permit nothing) on *both* `kCGEventSuppressionStateSuppressionInterval` and
 * `kCGEventSuppressionStateRemoteMouseDrag`, the heartbeat event is created, posts without error
 * and raises the window server's own scroll counter by exactly 1. Four reads, all green.
 *
 * **It suppresses nothing.** With privacy mode engaged and a person moving the mouse,
 * `CGEventSourceCounterForEventType(kCGEventSourceStateHIDSystemState, …)` recorded **770 mouse
 * moves and a click in the 5-second window it was supposedly held**, against a 36-move baseline
 * over the half-second before. The host stayed completely usable while `engagePrivacy()`
 * reported `inputBlocked: true`. (`bun tests/e2e/remote-desktop-macos-privacy.ts` is that run.)
 *
 * So it is reported as unavailable rather than shipped. A privacy mode that announces the host
 * is locked while the person at it keeps typing is **worse than not having one** — it is the
 * same refusal the X11 side already makes for a half-taken grab and the one this file made for
 * a missing Accessibility grant, applied to itself.
 *
 * **What would work, and why it is not here.** An event tap (`CGEventTapCreate` at
 * `kCGHIDEventTapLocation`, callback returning NULL) does block local input — but a tap only
 * delivers through a running `CFRunLoop`, and `CFRunLoopRun()` from Bun never returns, so
 * calling it in the server process would stop the HTTP server, every chat and every terminal.
 * The way out is a **child process**: `bun` running nothing but the tap and its run loop, killed
 * on release, which also fails open the way the suppression interval would have. That is a real
 * design and a real piece of work; it is not pretended at here.
 *
 * Blanking goes with it. It was `CGDisplayFade` behind a reservation, and on this Apple Silicon
 * host `CGAcquireDisplayFadeReservation` answers **1006 (`kCGErrorNotImplemented`)** at every
 * duration from 15 s down to 0.5 s, so there was nothing to keep even if the input half had
 * held.
 */
import type { PrivacyHandle, PrivacySupport } from "./remote-desktop-privacy.ts";

/**
 * Whether blanking would still let the capture see the real desktop. Moot while privacy mode is
 * refused, and kept because the question survives the mechanism: it is a property of
 * `CGDisplayFade` against avfoundation, not of how the input is held.
 */
export const blankingKeepsCapture = true;

/** The measured reason, stated where the user can act on it rather than hidden in a log. */
const UNSUPPORTED_REASON =
  "Not available on macOS yet. The only mechanism Bun can reach — CoreGraphics' local-events "
  + "suppression interval — accepts every setting and reads them all back correctly, but was "
  + "measured letting 771 local events through a window it reported as held. Blocking the host's "
  + "input needs an event tap, which needs a run loop, which needs a process of its own.";

/** macOS cannot hold the host's input today. Stated, not discovered from a failure. */
export async function darwinPrivacySupport(): Promise<PrivacySupport> {
  return { available: false, reason: UNSUPPORTED_REASON, canBlank: false };
}

/** Never engages. `privacySupport()` is what the UI gates on, but a direct caller must not be
 *  handed a handle claiming the host is locked when nothing is. */
export async function engageDarwinPrivacy(): Promise<PrivacyHandle | null> {
  return null;
}
