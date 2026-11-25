/**
 * Windows-only checklist rows: is PPM's session attached to anything that draws, and does
 * Windows have a display to capture at all.
 *
 * Every Windows call goes through `WindowsHostApi`, so the rows are built by a pure function
 * that tests drive with a fake host — no FFI, no real session needed.
 */
import type { RemoteDisplay } from "./remote-desktop-displays.ts";
import { listWindowsDisplays } from "./remote-desktop-displays-win32.ts";
import { readWindowsSession, type WindowsSessionInfo } from "./remote-desktop-win32-session.ts";
import type { RemoteDesktopRequirement } from "./remote-desktop-requirements.ts";

export interface WindowsHostApi {
  /** PPM's own Windows session, or null when Windows would not say. */
  session(): WindowsSessionInfo | null;
  /** The monitors Windows has right now (physical, dummy plug or virtual). */
  displays(): RemoteDisplay[];
}

export const realWindowsHost: WindowsHostApi = {
  session: readWindowsSession,
  displays: listWindowsDisplays,
};

export interface WindowsHostSnapshot {
  session: WindowsSessionInfo | null;
  displayCount: number;
}

export function snapshotWindowsHost(host: WindowsHostApi): WindowsHostSnapshot {
  const session = host.session();
  // A disconnected session's monitor list means nothing (and is not what a reattached session
  // will see), so it is not read at all in that state.
  const displayCount = session?.state === "disconnected" ? 0 : host.displays().length;
  return { session, displayCount };
}

export const WIN_SESSION_ID = "win-session";
export const WIN_DISPLAY_ID = "win-display";

/**
 * The two rows, in the order a user has to fix them.
 *
 * - No session information → no rows: a row that cannot tell is worse than none, and capture
 *   still reports its own error.
 * - Disconnected session → only the session row. The display count of a disconnected session
 *   is meaningless, and two red rows would send the user to fix the second one first.
 */
export function windowsHostRequirements(snapshot: WindowsHostSnapshot): RemoteDesktopRequirement[] {
  const { session } = snapshot;
  if (!session) return [];
  const disconnected = session.state === "disconnected";
  const rows: RemoteDesktopRequirement[] = [{
    id: WIN_SESSION_ID,
    ok: !disconnected,
    gates: "video",
    title: "Windows session on screen",
    detail: `Your Windows session (#${session.sessionId}) is disconnected. This usually happens when a `
      + "Remote Desktop (RDP) window is closed: Windows keeps your apps running but draws nothing, "
      + "so there is no picture to capture. Bring the session back to this PC's own screen: sign in "
      + "at the PC, or reconnect once with RDP or TeamViewer.",
    actions: [],
  }];
  if (disconnected) return rows;
  rows.push({
    id: WIN_DISPLAY_ID,
    ok: snapshot.displayCount > 0,
    gates: "video",
    title: "A display to capture",
    detail: "Windows reports no display on this PC (no monitor is plugged in), so there is nothing "
      + "to capture. Plug in a monitor or an HDMI/DisplayPort dummy plug.",
    actions: [],
  });
  return rows;
}
