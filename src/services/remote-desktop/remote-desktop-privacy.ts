/**
 * Privacy mode: stop the person sitting at the host from using it, and turn their monitor off,
 * while the remote session keeps working. RustDesk's `toolbarPrivacyMode` plus its separate
 * "block user input", which on Linux are the same two mechanisms and so are one switch here.
 *
 * **Blocking local input is an X grab, not `EVIOCGRAB`.** The evdev route reads like the right
 * layer — grab the device and the kernel stops delivering its events to X at all — and it is
 * the one that does not work on a real desktop: an evdev grab is *exclusive*, and keyboard
 * remappers hold one on every keyboard for exactly this reason. Measured on this host, with
 * `toshy` running: `EVIOCGRAB` returned **EBUSY on 3 of 4 devices** (both keyboards and the
 * wireless receiver) and succeeded only on the mouse — which is the worst possible outcome,
 * because "privacy mode on" would have been reported while the local keyboard still typed.
 * kmonad, keyd and xremap all take the same grab.
 *
 * `XGrabKeyboard` + `XGrabPointer` with `owner_events = False` sit above all of that: whatever
 * a remapper re-emits still enters X, and X routes it to the grabbing client, which drops it.
 * The catch that makes this look impossible at first is that a grab would swallow the remote
 * session's *own* injected events too — and the fix is one call, `XTestGrabControl(dpy, True)`,
 * whose entire purpose is to make a client's XTEST events impervious to grabs. Verified rather
 * than assumed: an `XTestFakeMotionEvent` issued while both grabs were held moved the real
 * pointer to the requested coordinate.
 *
 * That also gives the safety property this feature needs: the grabs belong to the X
 * *connection*, so they are released by `XUngrab*`, by the connection closing, and by the PPM
 * process exiting. The worst case for a bug here is `pkill ppm`, never a reboot.
 *
 * **Blanking is DPMS, not a black window.** x11grab captures the root window, so a fullscreen
 * black override-redirect window would be captured too — the remote would see the black screen
 * and nothing else. `DPMSForceLevel(DPMSModeOff)` turns the *output* off and leaves the
 * framebuffer alone, so the capture is unaffected. It needs re-asserting on a timer: injected
 * XTEST events reset the server's idle timer exactly as real ones do, so the monitor would
 * otherwise come back on the first remote keystroke.
 */
import { detectLinuxSession } from "./remote-desktop-linux-session.ts";
import { getX11, type X11Connection } from "./remote-desktop-x11.ts";

/** `XGrabKeyboard`/`XGrabPointer` return codes we care about. */
const GRAB_SUCCESS = 0;
const GRAB_MODE_ASYNC = 1;
const CURRENT_TIME = 0n;
const NONE = 0n;
/** Pointer events the grab claims. Every button and motion bit — the point is that nothing
 *  reaches another client, so the mask is deliberately everything rather than a subset. */
const POINTER_EVENT_MASK = 0xffff;

/** DPMS power levels from `dpms.h`. */
const DPMS_MODE_ON = 0;
const DPMS_MODE_OFF = 3;
/** The idle timer is reset by our own injected input, so the level has to be re-forced. Two
 *  seconds is short enough that a monitor never visibly comes back and long enough to be free. */
const BLANK_REASSERT_MS = 2_000;

export interface PrivacySupport {
  available: boolean;
  /** Why not, and what to do about it. Null when privacy mode works. */
  reason: string | null;
  /** Whether the monitor can also be blanked. False means input blocking works on its own —
   *  useful, so it is offered rather than withheld. */
  canBlank: boolean;
}

export async function privacySupport(platform: NodeJS.Platform = process.platform): Promise<PrivacySupport> {
  if (platform !== "linux") {
    return { available: false, reason: "Only implemented on Linux (X11) so far.", canBlank: false };
  }
  const session = detectLinuxSession();
  if (session?.kind !== "x11") {
    return { available: false, reason: "Needs an X11 session.", canBlank: false };
  }
  const x11 = await getX11(session);
  if (!x11) return { available: false, reason: "Cannot reach the host's X server.", canBlank: false };
  // XTEST is what makes the grab survivable: without it the grab would block the remote
  // session's input along with the local user's.
  if (!x11.hasXTest) {
    return {
      available: false,
      reason: "The host's X server has no XTEST extension, so a grab would block remote input too.",
      canBlank: false,
    };
  }
  return { available: true, reason: null, canBlank: x11.dpms !== null };
}

/** One engaged privacy mode. `release()` is idempotent and runs on every teardown path. */
export interface PrivacyHandle {
  release(): void;
  /** True when local keyboard *and* pointer are both held. A partial grab is never returned —
   *  see `engagePrivacy`. */
  inputBlocked: boolean;
  /** False when the monitor could not be blanked but input *is* blocked. */
  blanked: boolean;
}

/** Take both grabs, or neither. A keyboard grab without a pointer grab (or the reverse) reports
 *  privacy mode as on while half the host is still usable, which is worse than refusing. */
function grabInput(x11: X11Connection): boolean {
  const kb = x11.x11.XGrabKeyboard(x11.dpy, x11.root, 0, GRAB_MODE_ASYNC, GRAB_MODE_ASYNC, CURRENT_TIME);
  if (kb !== GRAB_SUCCESS) return false;
  const pt = x11.x11.XGrabPointer(
    x11.dpy, x11.root, 0, POINTER_EVENT_MASK, GRAB_MODE_ASYNC, GRAB_MODE_ASYNC, NONE, NONE, CURRENT_TIME,
  );
  if (pt !== GRAB_SUCCESS) {
    x11.x11.XUngrabKeyboard(x11.dpy, CURRENT_TIME);
    x11.x11.XFlush(x11.dpy);
    return false;
  }
  // Without this the injected events below would be delivered to *us* (the grabbing client)
  // rather than to the focused window, i.e. the remote session would go dead on engage.
  x11.xtst?.XTestGrabControl(x11.dpy, 1);
  x11.x11.XSync(x11.dpy, 0);
  return true;
}

/**
 * Engage privacy mode, or return null when this host cannot (see `privacySupport`) or when
 * another client already holds a grab — a screen locker or an open menu both do, and
 * `AlreadyGrabbed` is a real, temporary condition rather than a broken host.
 *
 * Never throws: a session must not die because privacy mode failed.
 */
export async function engagePrivacy(): Promise<PrivacyHandle | null> {
  if (process.platform !== "linux") return null;
  const session = detectLinuxSession();
  if (session?.kind !== "x11") return null;
  const x11 = await getX11(session);
  if (!x11?.hasXTest) return null;

  if (!grabInput(x11)) return null;

  let blankTimer: ReturnType<typeof setInterval> | null = null;
  let blanked = false;
  const force = (level: number): boolean => {
    if (!x11.dpms) return false;
    try {
      x11.dpms.DPMSEnable(x11.dpy);
      x11.dpms.DPMSForceLevel(x11.dpy, level);
      x11.x11.XFlush(x11.dpy);
      return true;
    } catch {
      return false;
    }
  };
  blanked = force(DPMS_MODE_OFF);
  if (blanked) blankTimer = setInterval(() => force(DPMS_MODE_OFF), BLANK_REASSERT_MS);

  let released = false;
  return {
    inputBlocked: true,
    blanked,
    release: () => {
      if (released) return;
      released = true;
      if (blankTimer) clearInterval(blankTimer);
      if (blanked) force(DPMS_MODE_ON);
      try {
        x11.xtst?.XTestGrabControl(x11.dpy, 0);
        x11.x11.XUngrabKeyboard(x11.dpy, CURRENT_TIME);
        x11.x11.XUngrabPointer(x11.dpy, CURRENT_TIME);
        x11.x11.XFlush(x11.dpy);
      } catch { /* the server may already be gone; the grabs died with the connection */ }
    },
  };
}
