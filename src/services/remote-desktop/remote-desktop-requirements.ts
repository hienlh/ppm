/**
 * What this host still needs before remote desktop works, as a flat checklist the UI renders
 * generically. Each platform contributes its own items; the client never branches on OS — it
 * only knows `gates` (which half of the feature an item blocks) and the `actions` it can offer.
 *
 * Adding a requirement = push one more item here (and, for `host` actions, handle its id in
 * `runHostAction`). The UI needs no change.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { getFfmpegCapabilities } from "../media-transcode/ffmpeg-capabilities.ts";
import { captureInputForPlatform } from "./remote-desktop-capture-input.ts";
import { getInputBackend } from "./remote-desktop-input.ts";
import { clipboardAvailable, clipboardTool } from "./remote-desktop-clipboard.ts";
import { audioSupport, type AudioSupport } from "./remote-desktop-audio.ts";
import { privacySupport, type PrivacySupport } from "./remote-desktop-privacy.ts";
import { listHostResolutions, type HostResolutions } from "./remote-desktop-resolution.ts";
import { detectLinuxSession, type LinuxSession } from "./remote-desktop-linux-session.ts";
import { getX11 } from "./remote-desktop-x11.ts";
import {
  MAC_PERMISSION_SETTINGS_URL,
  macPermissionStatus,
  requestMacPermission,
  type MacPermissionId,
} from "./remote-desktop-macos-permissions.ts";

export type HostAction = "request" | "open-settings";

export type RequirementAction =
  /** Type `command` into a PPM terminal — that shell runs on the host, so this works from a phone. */
  | { kind: "terminal"; label: string; command: string }
  /** A web page the *client* opens in its own browser (docs, downloads). */
  | { kind: "link"; label: string; url: string }
  /** Something only the host can do — show an OS permission prompt, open its Settings pane.
   *  `POST /api/remote-desktop/requirements/:id/:action`. Never a client-side URL: a
   *  `x-apple.systempreferences:` link means nothing on the phone driving the session. */
  | { kind: "host"; label: string; action: HostAction };

export interface RemoteDesktopRequirement {
  id: string;
  ok: boolean;
  /** Which part of the feature this blocks: no video = nothing to show; no input = view-only. */
  gates: "video" | "input";
  title: string;
  /** One sentence: what it is for and what to do. Shown only while `ok` is false. */
  detail: string;
  actions: RequirementAction[];
}

/** Clipboard sync is an *extra*, not a gate: it blocks neither video nor input, so it cannot
 *  be a `requirements` row — that checklist is only rendered while video or input is unmet, so a
 *  row there would be invisible on exactly the working hosts that are missing the tool. */
export interface ClipboardSupport {
  available: boolean;
  /** How to get the tool, when one is missing and this OS needs a package for it. */
  action: RequirementAction | null;
}

export interface RemoteDesktopReadiness {
  platform: NodeJS.Platform;
  /** There is a capture path for this OS at all. Gates the UI entry; everything else is a
   *  requirement the user can satisfy in place. */
  platformSupported: boolean;
  requirements: RemoteDesktopRequirement[];
  /** Every `video` requirement is met. */
  videoReady: boolean;
  /** Every `input` requirement is met (and the platform has an injector). */
  inputReady: boolean;
  clipboard: ClipboardSupport;
  /** Whether the host can stream its own audio. Not a `requirements` row either, and for the
   *  same reason as clipboard: that checklist only renders while video or input is unmet, so a
   *  row here would be invisible on exactly the working hosts that cannot do audio. */
  audio: AudioSupport;
  /** Whether local input can be blocked and the host monitor blanked. Informational, like the
   *  two above — never a gate. */
  privacy: PrivacySupport;
  /** The host's own display modes, for the resolution picker. Same non-gating treatment. */
  resolutions: HostResolutions;
}

const FFMPEG_INSTALL: Partial<Record<NodeJS.Platform, RequirementAction>> = {
  darwin: { kind: "terminal", label: "Install with Homebrew", command: "brew install ffmpeg" },
  win32: { kind: "terminal", label: "Install with winget", command: "winget install --id Gyan.FFmpeg -e" },
};

/** Distro package managers, in the order a host is checked. `apt` last as the fallback label
 *  because it is the one most users recognise — but a command that names the wrong package
 *  manager is worse than none, since the checklist offers to *type it into a real terminal*. */
const LINUX_PACKAGE_MANAGERS: Array<{ bin: string; label: string; command: string }> = [
  { bin: "/usr/bin/pacman", label: "Install with pacman", command: "sudo pacman -S --needed ffmpeg" },
  { bin: "/usr/bin/dnf", label: "Install with dnf", command: "sudo dnf install ffmpeg" },
  { bin: "/usr/bin/zypper", label: "Install with zypper", command: "sudo zypper install ffmpeg" },
  { bin: "/usr/bin/apt", label: "Install with apt", command: "sudo apt install ffmpeg" },
];

/** A `terminal` action installing `pkg` with whichever package manager this host has. */
function linuxInstallAction(pkg: string): RequirementAction | undefined {
  const found = LINUX_PACKAGE_MANAGERS.find((p) => existsSync(p.bin));
  if (!found) return undefined;
  return { kind: "terminal", label: found.label, command: found.command.replace("ffmpeg", pkg) };
}

function ffmpegRequirement(platform: NodeJS.Platform, present: boolean): RemoteDesktopRequirement {
  const install = platform === "linux" ? linuxInstallAction("ffmpeg") : FFMPEG_INSTALL[platform];
  return {
    id: "ffmpeg",
    ok: present,
    gates: "video",
    title: "ffmpeg",
    detail: "Captures and encodes the screen. Install it, then come back — PPM re-checks automatically.",
    actions: [
      ...(install ? [install] : []),
      { kind: "link", label: "Download page", url: "https://ffmpeg.org/download.html" },
    ],
  };
}

function macPermissionRequirement(id: MacPermissionId, granted: boolean): RemoteDesktopRequirement {
  const screen = id === "screen-recording";
  return {
    id,
    ok: granted,
    gates: screen ? "video" : "input",
    title: screen ? "Screen Recording permission" : "Accessibility permission",
    detail: screen
      ? "Without it macOS hands PPM a black screen. Allow the PPM process (bun) under Screen & System Audio Recording."
      : "Needed to move the mouse and type. Add the PPM process (bun) under Accessibility; until then the view is read-only.",
    actions: [
      ...(screen ? [{ kind: "host", label: "Ask macOS now", action: "request" } as RequirementAction] : []),
      { kind: "host", label: "Open System Settings on the host", action: "open-settings" },
    ],
  };
}

/** The session-type row. A Wayland host is *not* reported as an unsupported platform: nothing
 *  about Linux is missing, one specific capture path is — and the user can satisfy it in place
 *  by choosing X11 at the login screen, which is exactly what a requirement is for. Hiding the
 *  entry instead would leave them with no explanation at all. */
function linuxSessionRequirement(session: LinuxSession): RemoteDesktopRequirement {
  const x11 = session.kind === "x11";
  return {
    id: "linux-session",
    ok: x11,
    gates: "video",
    title: "X11 session",
    detail: "Screen capture currently needs an X11 session. This host is on Wayland, which only "
      + "shares the screen through the desktop portal — not supported yet. Log out and pick "
      + "\"Plasma (X11)\" / \"GNOME on Xorg\" at the login screen; mouse and keyboard already work here.",
    actions: [],
  };
}

/** uinput is how a Wayland session receives input, and the device is root-owned by default. */
function uinputRequirement(): RemoteDesktopRequirement {
  let writable = false;
  try { accessSync("/dev/uinput", constants.W_OK); writable = true; } catch { writable = false; }
  return {
    id: "uinput",
    ok: writable,
    gates: "input",
    title: "Write access to /dev/uinput",
    detail: "Wayland has no input-injection protocol, so PPM types through a virtual input "
      + "device. Add yourself to the `input` group, then log out and back in; until then the "
      + "view is read-only.",
    actions: [{ kind: "terminal", label: "Add me to the input group", command: "sudo usermod -aG input $USER" }],
  };
}

/** XTEST is a separate package from Xlib on several distros, and without it there is video but
 *  no input at all. */
function xtestRequirement(present: boolean): RemoteDesktopRequirement {
  return {
    id: "xtest",
    ok: present,
    gates: "input",
    title: "XTEST extension (libXtst)",
    detail: "Needed to move the mouse and type on an X11 host. Without it the view is read-only.",
    actions: [linuxInstallAction(xtstPackage())].filter((a): a is RequirementAction => a !== undefined),
  };
}

/** libXtst's package name is not the same everywhere: Debian/Ubuntu ship `libxtst6`, Arch
 *  `libxtst`, Fedora/openSUSE `libXtst`. */
function xtstPackage(): string {
  if (existsSync("/usr/bin/pacman")) return "libxtst";
  if (existsSync("/usr/bin/apt")) return "libxtst6";
  return "libXtst";
}

function clipboardSupport(platform: NodeJS.Platform, session: LinuxSession | null): ClipboardSupport {
  const tool = clipboardTool(platform, session);
  if (clipboardAvailable(tool)) return { available: true, action: null };
  const pkg = tool?.install;
  return { available: false, action: (pkg && linuxInstallAction(pkg)) || null };
}

async function linuxRequirements(session: LinuxSession): Promise<RemoteDesktopRequirement[]> {
  const rows: RemoteDesktopRequirement[] = [linuxSessionRequirement(session)];
  if (session.kind === "x11") {
    const conn = await getX11(session);
    rows.push(xtestRequirement(!!conn?.hasXTest));
  } else {
    rows.push(uinputRequirement());
  }
  return rows;
}

export async function remoteDesktopReadiness(
  platform: NodeJS.Platform = process.platform,
  linuxSession = platform === "linux" ? detectLinuxSession() : null,
): Promise<RemoteDesktopReadiness> {
  // On Linux "is this platform supported" means "is there a graphical session to capture" —
  // the grabber then depends on its type, which is a requirement rather than a hard no.
  const platformSupported = platform === "linux"
    ? linuxSession !== null
    : captureInputForPlatform(platform) !== null;
  const requirements: RemoteDesktopRequirement[] = [];
  if (platformSupported) {
    const caps = await getFfmpegCapabilities();
    requirements.push(ffmpegRequirement(platform, !!caps.ffmpeg));
    if (platform === "darwin") {
      const status = await macPermissionStatus();
      requirements.push(macPermissionRequirement("screen-recording", status["screen-recording"]));
      requirements.push(macPermissionRequirement("accessibility", status.accessibility));
    }
    if (platform === "linux" && linuxSession) requirements.push(...await linuxRequirements(linuxSession));
  }
  const inputSupported = getInputBackend(platform, linuxSession) !== null;
  return {
    platform,
    platformSupported,
    requirements,
    videoReady: platformSupported && requirements.filter((r) => r.gates === "video").every((r) => r.ok),
    inputReady: inputSupported && requirements.filter((r) => r.gates === "input").every((r) => r.ok),
    clipboard: clipboardSupport(platform, linuxSession),
    audio: await audioSupport(platform),
    privacy: await privacySupport(platform),
    resolutions: await listHostResolutions(platform),
  };
}

/** Run a `host` action. Returns the requirement's `ok` afterwards, or null when the pair has
 *  no host path (caller answers 404). `open-settings` returns the current state — the grant
 *  lands later, the UI keeps polling. */
export async function runHostAction(id: string, action: HostAction): Promise<boolean | null> {
  if (id !== "screen-recording" && id !== "accessibility") return null;
  if (action === "request") return requestMacPermission(id);
  if (process.platform === "darwin") {
    Bun.spawn(["open", MAC_PERMISSION_SETTINGS_URL[id]], { stdout: "ignore", stderr: "ignore" });
  }
  return (await macPermissionStatus())[id];
}
