/**
 * What this host still needs before remote desktop works, as a flat checklist the UI renders
 * generically. Each platform contributes its own items; the client never branches on OS — it
 * only knows `gates` (which half of the feature an item blocks) and the `actions` it can offer.
 *
 * Adding a requirement = push one more item here (and, for `host` actions, handle its id in
 * `runHostAction`). The UI needs no change.
 */
import { getFfmpegCapabilities } from "../media-transcode/ffmpeg-capabilities.ts";
import { captureInputForPlatform } from "./remote-desktop-capture-input.ts";
import { getInputBackend } from "./remote-desktop-input.ts";
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
}

const FFMPEG_INSTALL: Partial<Record<NodeJS.Platform, RequirementAction>> = {
  darwin: { kind: "terminal", label: "Install with Homebrew", command: "brew install ffmpeg" },
  win32: { kind: "terminal", label: "Install with winget", command: "winget install --id Gyan.FFmpeg -e" },
  linux: { kind: "terminal", label: "Install with apt", command: "sudo apt install ffmpeg" },
};

function ffmpegRequirement(platform: NodeJS.Platform, present: boolean): RemoteDesktopRequirement {
  const install = FFMPEG_INSTALL[platform];
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

export async function remoteDesktopReadiness(platform: NodeJS.Platform = process.platform): Promise<RemoteDesktopReadiness> {
  const platformSupported = captureInputForPlatform(platform) !== null;
  const requirements: RemoteDesktopRequirement[] = [];
  if (platformSupported) {
    const caps = await getFfmpegCapabilities();
    requirements.push(ffmpegRequirement(platform, !!caps.ffmpeg));
    if (platform === "darwin") {
      const status = await macPermissionStatus();
      requirements.push(macPermissionRequirement("screen-recording", status["screen-recording"]));
      requirements.push(macPermissionRequirement("accessibility", status.accessibility));
    }
  }
  const inputSupported = getInputBackend(platform) !== null;
  return {
    platform,
    platformSupported,
    requirements,
    videoReady: platformSupported && requirements.filter((r) => r.gates === "video").every((r) => r.ok),
    inputReady: inputSupported && requirements.filter((r) => r.gates === "input").every((r) => r.ok),
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
