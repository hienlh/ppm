import { useSettingsStore } from "@/stores/settings-store";
/**
 * Client view of `GET /api/remote-desktop/capabilities`: the host's requirements checklist
 * (ffmpeg, macOS permissions, …) plus the derived `videoReady` / `inputReady` flags.
 *
 * Mirrors the server types in `src/services/remote-desktop/remote-desktop-requirements.ts` —
 * the UI renders whatever items arrive and never branches on the host OS. Polls while `poll`
 * is on so a permission granted in System Settings (or `brew install ffmpeg` finishing in the
 * dock terminal) flips the panel without a reload — and only until the host is ready, when
 * there is nothing left to flip.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";

export type RequirementAction =
  | { kind: "terminal"; label: string; command: string }
  | { kind: "install"; label: string }
  | { kind: "link"; label: string; url: string }
  | { kind: "host"; label: string; action: HostAction }
  /** Go on as things are: answers a `choice` row without asking the host. */
  | { kind: "continue"; label: string };

/** Mirrors the server's `HostAction`: `reattach` and `display-on` run the Windows helper's
 *  fixed tasks. */
export type HostAction = "request" | "open-settings" | "reattach" | "display-on";

/** What a host action reports back; `message` only for actions with a real outcome to tell.
 *  `pending`: the host started it but has not said how it went — not a failure; the checklist's
 *  own polling shows what really happened. */
export interface HostActionResult {
  ok: boolean;
  message?: string;
  pending?: boolean;
}

export interface RemoteDesktopRequirement {
  id: string;
  ok: boolean;
  /** `choice`: blocks nothing, but the checklist stops so the user picks before streaming. */
  gates: "video" | "input" | "choice";
  title: string;
  detail: string;
  /** A consequence to read before pressing an action. Absent on older hosts. */
  warning?: string;
  actions: RequirementAction[];
}

export interface RemoteDisplay {
  id: string;
  label: string;
  primary: boolean;
  width: number;
  height: number;
}

/** Whether the host can stream its own audio, and why not when it cannot. Same shape and same
 *  reasoning as `ClipboardSupport` below — informational, never a gate. */
export interface AudioSupport {
  available: boolean;
  reason: string | null;
}

/** Whether the host can block its local input and blank its monitor. `canBlank` false means
 *  input blocking works on its own — which is still worth offering. */
export interface PrivacySupport {
  available: boolean;
  reason: string | null;
  canBlank: boolean;
}

/** One of the host's own display modes. `id` is an XRandR XID as a string — a 64-bit value that
 *  has to survive JSON, so it is never a number. */
export interface HostMode {
  id: string;
  width: number;
  height: number;
  refresh: number;
  current: boolean;
  preferred: boolean;
}

/** The host's display modes. Empty with a `reason` on a host whose resolution cannot be changed
 *  (anything but X11 today) — informational, never a gate, like the two above. */
export interface HostResolutions {
  output: string | null;
  modes: HostMode[];
  reason: string | null;
}

/** Clipboard sync is not a gate (see the server-side note): it never blocks the viewer, it only
 *  needs explaining when the host has no tool for it. */
export interface ClipboardSupport {
  available: boolean;
  action: RequirementAction | null;
}

export interface RemoteDesktopCapabilities {
  displays: RemoteDisplay[];
  /** Every H.264 encoder that really encodes on the host, preference order; the first is the
   *  one a session uses unless asked otherwise. Empty when ffmpeg is missing. */
  encoders: string[];
  ffmpegAvailable: boolean;
  videoAvailable: boolean;
  inputAvailable: boolean;
  authRequired: boolean;
  platform: string;
  platformSupported: boolean;
  requirements: RemoteDesktopRequirement[];
  videoReady: boolean;
  inputReady: boolean;
  clipboard: ClipboardSupport;
  audio: AudioSupport;
  privacy: PrivacySupport;
  resolutions: HostResolutions;
}

/**
 * Fills in whatever the host did not send.
 *
 * The client and the host are not one deployable: a browser holds a bundle until it reloads, a
 * phone holds one until its service worker updates, and `dist/ppm` is a separately-built binary
 * — so a *new* viewer routinely talks to an *older* `/capabilities`. Every field below arrived
 * in a different version, and reading one that predates the host crashes the whole viewer
 * rather than degrading: `caps.resolutions.modes` on a host that has never heard of
 * `resolutions` is a `TypeError` past the last error boundary, i.e. the blank "could not finish
 * rendering" page. The call sites cannot be trusted to each remember an optional chain, and a
 * missing one is invisible until that exact version pairing happens — so the shape is repaired
 * once, here, and the interface stays non-optional because it is now actually true.
 */
export function normalizeCapabilities(raw: RemoteDesktopCapabilities): RemoteDesktopCapabilities {
  return {
    ...raw,
    displays: raw.displays ?? [],
    encoders: raw.encoders ?? [],
    requirements: raw.requirements ?? [],
    clipboard: raw.clipboard ?? { available: false, action: null },
    audio: raw.audio ?? { available: false, reason: null },
    privacy: raw.privacy ?? { available: false, reason: null, canBlank: false },
    resolutions: raw.resolutions ?? { output: null, modes: [], reason: null },
  };
}

export const READINESS_POLL_MS = 2000;
export const PENDING_RECHECK_MS = 30_000;

export function useRemoteDesktopReadiness(poll: boolean): {
  caps: RemoteDesktopCapabilities | null;
  /** 404 (feature flag off) or network failure — treat as "not available". */
  failed: boolean;
  refresh: () => void;
  runHostAction: (id: string, action: HostAction) => Promise<HostActionResult | null>;
} {
  const minimalMode = useSettingsStore((s) => s.minimalMode);
  const [caps, setCaps] = useState<RemoteDesktopCapabilities | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (minimalMode) return;
    let cancelled = false;
    api.get<RemoteDesktopCapabilities>("/api/remote-desktop/capabilities")
      .then((c) => { if (!cancelled) { setCaps(normalizeCapabilities(c)); setFailed(false); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [tick, minimalMode]);

  // A ready host stops the poll. The gate is then showing the viewer for the rest of the
  // session, and every poll re-ran the host's probes for it — on a Wayland host without a GPU
  // encoder, four `gst-inspect-1.0` every two seconds beside a software encode.
  const ready = !!caps?.videoReady && caps.inputReady;
  useEffect(() => {
    if (minimalMode || !poll || ready) return;
    const timer = setInterval(refresh, READINESS_POLL_MS);
    return () => clearInterval(timer);
  }, [poll, ready, refresh, minimalMode]);

  const runHostAction = useCallback(async (id: string, action: HostAction): Promise<HostActionResult | null> => {
    let result: HostActionResult | null = null;
    try {
      result = await api.post<HostActionResult>(`/api/remote-desktop/requirements/${encodeURIComponent(id)}/${action}`);
    } catch (e) {
      // The panel also shows the state on the next poll; the message says why this one failed.
      result = { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    refresh();
    // Not answered yet: the host may still finish it (measured: 27 s). One more read once it
    // likely has, on top of the gate's own polling, which stops as soon as the host looks ready.
    if (result?.pending) setTimeout(refresh, PENDING_RECHECK_MS);
    return result;
  }, [refresh]);

  return { caps, failed, refresh, runHostAction };
}
