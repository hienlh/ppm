/**
 * Turns ffmpeg's last stderr lines into the sentence a person reads when capture dies.
 *
 * On Windows the session's own state is the surest witness, so it is asked first: a session that
 * is disconnected (its Remote Desktop window was closed) has nothing on screen, and ffmpeg reports
 * that in more than one way — gdigrab's `Failed to capture image (error 5)`, or, measured on
 * 27/11 right after a phone's RDP app was closed, `Output file does not contain any stream` — so
 * matching ffmpeg's words alone missed it and showed the raw line to someone on a phone.
 *
 * Then ffmpeg's words, for the cases the session state does not explain:
 * - gdigrab access denied / no stream — the screen is locked (secure desktop), or disconnected;
 * - ddagrab `Failed to enumerate DXGI output 0` — Windows has no display at all.
 * Anything else is passed through unchanged. The raw tail always stays at the end, so nothing
 * ffmpeg said is hidden.
 */
import type { WindowsSessionInfo } from "./remote-desktop-win32-session.ts";

/** Said when the session is known to be disconnected: what happened, and the way back from a phone. */
export const SESSION_DISCONNECTED_MESSAGE = "Your Windows session is disconnected — usually because a Remote "
  + "Desktop (RDP) app was closed — so there is nothing on its screen to capture. To bring it back: close "
  + "this viewer and open Remote Desktop again, then tap \"Bring session back\" in the checklist (or connect "
  + "once with RDP or TeamViewer and come back).";

export function explainCaptureFailure(platform: NodeJS.Platform, reason: string, session?: WindowsSessionInfo | null): string {
  if (platform === "win32") {
    if (session?.state === "disconnected") return `${SESSION_DISCONNECTED_MESSAGE} (${reason})`;
    if (/\berror 5\)/i.test(reason) || /access is denied/i.test(reason) || /does not contain any stream/i.test(reason)) {
      return "Windows refused the screen capture. This happens when the Windows session is "
        + "disconnected (a Remote Desktop window was closed) or the screen is locked. "
        + `Bring the session back to the PC's screen and try again. (${reason})`;
    }
    if (/enumerate DXGI output/i.test(reason)) {
      return "Windows has no display to capture: no monitor is plugged in. Plug in a monitor or a "
        + `dummy plug, or turn on a virtual display. (${reason})`;
    }
  }
  return `Capture failed: ${reason}`;
}
