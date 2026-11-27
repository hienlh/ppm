/**
 * The "Windows session on screen" checklist row, written for the person it is usually read by:
 * someone on a phone, far from the PC, whose RDP app has just closed and left the session
 * disconnected.
 *
 * What the row can offer depends on the SYSTEM helper (`win32-helper/`):
 * - usable (any version with the safety net) → a "Bring session back" button, three steps, the
 *   cost (`UNLOCK_WARNING`) and what protects the PC (`safety`);
 * - missing, too old, another user's, or damaged → no button: the steps say where to set it up
 *   once (at the PC or over RDP, approving one administrator prompt), and what works until then.
 */
import type { RemoteDesktopRequirement } from "./remote-desktop-requirements.ts";
import type { WindowsSessionInfo } from "./remote-desktop-win32-session.ts";
import { RESCUE_MINUTES } from "./win32-helper/helper-paths.ts";

/** What the row needs to know about the helper; every field but `usable` is optional because the
 *  snapshot skips asking when no row could use the answer. */
export interface SessionRowHelper {
  /** Installed for this user, recent enough, every task present. */
  usable: boolean;
  installed?: boolean;
  /** A newer helper exists; this one still works. */
  outdated?: boolean;
  /** Installed by a PPM from before the safety net: PPM will not use it. */
  tooOld?: boolean;
  otherUser?: boolean;
  virtualDisplay?: boolean;
}

/** Said wherever the user can bring the session back: it is what that action costs. */
export const UNLOCK_WARNING = "Bringing the session back signs it in at this PC's own screen and leaves it "
  + "unlocked: anyone at the PC, or anyone who plugs a monitor in, sees and can use your desktop.";

/** Where the helper is set up, as the user would find it. */
const SETUP_PLACE = "Settings → Remote Desktop → Run without a monitor (Windows)";

export const WIN_SESSION_ID = "win-session";

function why(session: WindowsSessionInfo): string {
  return `Your Windows session (#${session.sessionId}) is disconnected, usually because a Remote Desktop `
    + "(RDP) app on another device was closed. Windows keeps your apps running but draws nothing, so "
    + "there is no picture to send here.";
}

/** Why the button is safe to press from afar. Each claim is one the helper enforces. */
function safetyNote(helper: SessionRowHelper): string {
  const net = helper.virtualDisplay
    ? `Safe to press from here: for ${RESCUE_MINUTES} minutes afterwards a safety net watches the PC, and if `
      + "your session ends up with no screen, Windows turns the virtual display on for it. PPM never turns "
      + "the virtual display off while it is the PC's only screen, and never signs you out."
    : `Safe to press from here: it never signs you out, and for ${RESCUE_MINUTES} minutes afterwards a `
      + "safety net watches the PC.";
  return helper.outdated
    ? `${net} This PC's helper is an older version with the same safety rules; updating it at the PC `
      + `(${SETUP_PLACE} → Reinstall) is optional.`
    : net;
}

/** Why there is no button, when the helper exists but PPM will not use it. */
function unusableReason(helper: SessionRowHelper): string | null {
  if (helper.otherUser) return "The helper on this PC was set up for another Windows user.";
  if (helper.tooOld) return "The helper on this PC is from an older PPM without the safety net, so PPM will not use it.";
  if (helper.installed) return "The helper on this PC is damaged (some of its tasks are missing).";
  return null;
}

export function windowsSessionRow(session: WindowsSessionInfo, helper: SessionRowHelper): RemoteDesktopRequirement {
  const base = { id: WIN_SESSION_ID, ok: session.state !== "disconnected", gates: "video" as const, title: "Windows session on screen" };
  if (helper.usable) {
    return {
      ...base,
      detail: why(session),
      steps: [
        "Tap Bring session back below.",
        "Wait a few seconds while the PC puts your session on its own screen. This row turns green by itself.",
        "Tap Continue. If the PC has no monitor, the checklist then offers a virtual display.",
      ],
      warning: UNLOCK_WARNING,
      safety: safetyNote(helper),
      actions: [{ kind: "host", label: "Bring session back", action: "reattach" }],
    };
  }
  const reason = unusableReason(helper);
  const verb = helper.installed ? "Reinstall" : "Set up";
  return {
    ...base,
    detail: `${why(session)} ${reason ? `${reason} ` : ""}Until PPM's helper is set up, bring the session back by `
      + "signing in at the PC or connecting with TeamViewer. RDP helps only while it stays open: closing it "
      + "disconnects the session again. To let PPM do it from any device, set the helper up once:",
    steps: [
      `At the PC, or over Remote Desktop (RDP): in PPM open ${SETUP_PLACE} and press ${verb}.`,
      "Approve the Windows administrator (UAC) prompt on that screen.",
      "From then on, this row has a Bring session back button you can tap from any device.",
    ],
    actions: [],
  };
}
