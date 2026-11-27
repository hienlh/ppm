/**
 * Turns ffmpeg's last stderr lines into the sentence a person reads when capture dies.
 *
 * Two Windows failures are recognisable and each has one real cause, measured on a headless
 * Windows 11 host:
 * - gdigrab `Failed to capture image (error 5)` — access denied: the session PPM runs in is
 *   disconnected (an RDP window was closed) or the screen is locked (secure desktop).
 * - ddagrab `Failed to enumerate DXGI output 0` — Windows has no display at all.
 * Anything else is passed through unchanged. The raw tail always stays at the end, so nothing
 * ffmpeg said is hidden.
 */
export function explainCaptureFailure(platform: NodeJS.Platform, reason: string): string {
  if (platform === "win32") {
    if (/\berror 5\)/i.test(reason) || /access is denied/i.test(reason)) {
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
