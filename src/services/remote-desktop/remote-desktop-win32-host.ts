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
import { getHelperStatus } from "./win32-helper/helper-service.ts";
import { hardwareMonitorCount } from "./win32-helper/hardware-monitor-count.ts";
import { isVirtualDisplayAttached } from "./win32-helper/virtual-display-mode.ts";
import { windowsSessionRow, type SessionRowHelper } from "./remote-desktop-win32-session-row.ts";

export { UNLOCK_WARNING, WIN_SESSION_ID } from "./remote-desktop-win32-session-row.ts";

/** What the checklist needs to know about the SYSTEM helper (`win32-helper/`): `usable` is
 *  installed for this user, recent enough and every task present; `virtualDisplay`, the install
 *  includes the virtual display driver and its on/off tasks; the rest explain why it is not usable. */
export type WindowsHelperView = SessionRowHelper;

export interface WindowsHostApi {
  /** PPM's own Windows session, or null when Windows would not say. */
  session(): WindowsSessionInfo | null;
  /** The monitors Windows has right now (physical, dummy plug or virtual). */
  displays(): RemoteDisplay[];
  helper(): Promise<WindowsHelperView>;
  /** Whether the helper's virtual display is one of this session's screens right now. */
  virtualDisplayAttached(): boolean;
  /** Monitors of the PC's own, by the helper's definition; null when it cannot be read. */
  hardwareMonitors(): Promise<number | null>;
}

export const realWindowsHost: WindowsHostApi = {
  session: readWindowsSession,
  displays: listWindowsDisplays,
  helper: () => getHelperStatus(),
  virtualDisplayAttached: isVirtualDisplayAttached,
  hardwareMonitors: hardwareMonitorCount,
};

export interface WindowsHostSnapshot {
  session: WindowsSessionInfo | null;
  displayCount: number;
  helper: WindowsHelperView;
  /** The only screen is Windows' stand-in for a PC with no monitor (see `isFallbackScreen`);
   *  its size, for the row to name. Absent otherwise. */
  fallback?: { width: number; height: number };
}

/**
 * Windows' fallback screen: a session at the console of a PC with no monitor of its own still has
 * a screen — a 1024x768 stand-in the GPU draws (measured on a headless host: `\\.\DISPLAY1`,
 * 1024x768, NVIDIA) — so the checklist found "a display" and sent the user into a 1024x768 stream
 * without a word. It is that screen when: the session is at the console, it has screens, the
 * virtual display is not one of them, and the PC has no monitor by the helper's own definition.
 *
 * NOT YET CONFIRMED on a real host in exactly this state; the definition is the helper's, the
 * device facts are from that host. The cost of a wrong answer is small either way: a needless
 * question before streaming, or the old silent 1024x768.
 *
 * The same screen must never count as a monitor for turning the virtual display OFF: on that host,
 * turning it off while the session sat at the console left the session on WinDisc, with no
 * screen at all — the 1024x768 stand-in does not come back for a session already there.
 */
export function isFallbackScreen(s: {
  session: WindowsSessionInfo | null;
  displayCount: number;
  helper: WindowsHelperView;
  virtualDisplayAttached: boolean;
  hardwareMonitors: number | null;
}): boolean {
  return !!s.session?.isConsole && s.session.state === "active" && s.displayCount > 0
    && s.helper.usable && !!s.helper.virtualDisplay && !s.virtualDisplayAttached && s.hardwareMonitors === 0;
}

export async function snapshotWindowsHost(host: WindowsHostApi): Promise<WindowsHostSnapshot> {
  const session = host.session();
  // A disconnected session's monitor list means nothing (and is not what a reattached session
  // will see), so it is not read at all in that state.
  const displays = session?.state === "disconnected" ? [] : host.displays();
  const displayCount = displays.length;
  // The helper is only worth asking about when a row could offer one of its actions: bringing
  // the session back, a display when there is none, or a better one than the fallback screen.
  const helper = session && (session.state === "disconnected" || displayCount === 0 || session.isConsole)
    ? await host.helper()
    : { usable: false };
  const snapshot: WindowsHostSnapshot = { session, displayCount, helper };
  // The cheap checks first: the monitor count starts a PowerShell (cached).
  const candidate = { session, displayCount, helper, virtualDisplayAttached: false, hardwareMonitors: 0 };
  if (isFallbackScreen(candidate) && !host.virtualDisplayAttached()
    && isFallbackScreen({ ...candidate, hardwareMonitors: await host.hardwareMonitors() })) {
    snapshot.fallback = { width: displays[0]!.width, height: displays[0]!.height };
  }
  return snapshot;
}

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
  const helper = snapshot.helper.usable;
  const rows: RemoteDesktopRequirement[] = [windowsSessionRow(session, snapshot.helper)];
  if (disconnected) return rows;
  if (snapshot.fallback) {
    const size = `${snapshot.fallback.width}x${snapshot.fallback.height}`;
    rows.push({
      id: WIN_DISPLAY_ID,
      ok: false,
      // Blocks nothing — the stream works at this size — but the checklist stops to ask, so the
      // choice is made before streaming rather than by changing resolution mid-view.
      gates: "choice",
      title: `Windows' fallback screen (${size})`,
      detail: `No monitor is plugged into this PC, so Windows is showing a stand-in screen at ${size}. `
        + "Turn on the virtual display for 1920x1080, or continue at this size.",
      actions: [
        { kind: "host", label: "Turn on virtual display (1920x1080)", action: "display-on" },
        { kind: "continue", label: `Continue at ${size}` },
      ],
    });
    return rows;
  }
  const virtualDisplay = helper && !!snapshot.helper.virtualDisplay;
  rows.push({
    id: WIN_DISPLAY_ID,
    ok: snapshot.displayCount > 0,
    gates: "video",
    title: "A display to capture",
    detail: "Windows reports no display on this PC (no monitor is plugged in), so there is nothing "
      + "to capture. "
      + (virtualDisplay
        ? "PPM can turn on a virtual display for this session; it turns it off again when the session ends."
        : "Plug in a monitor or an HDMI/DisplayPort dummy plug, or set up the headless helper in "
          + "Settings → Remote Desktop, which adds a virtual display PPM turns on only while you are connected."),
    actions: virtualDisplay ? [{ kind: "host", label: "Turn on virtual display", action: "display-on" }] : [],
  });
  return rows;
}
