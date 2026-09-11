/**
 * Client view of `GET /api/remote-desktop/capabilities`: the host's requirements checklist
 * (ffmpeg, macOS permissions, …) plus the derived `videoReady` / `inputReady` flags.
 *
 * Mirrors the server types in `src/services/remote-desktop/remote-desktop-requirements.ts` —
 * the UI renders whatever items arrive and never branches on the host OS. Polls while `poll`
 * is on so a permission granted in System Settings (or `brew install ffmpeg` finishing in the
 * dock terminal) flips the panel without a reload.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";

export type RequirementAction =
  | { kind: "terminal"; label: string; command: string }
  | { kind: "link"; label: string; url: string }
  | { kind: "host"; label: string; action: "request" | "open-settings" };

export interface RemoteDesktopRequirement {
  id: string;
  ok: boolean;
  gates: "video" | "input";
  title: string;
  detail: string;
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

export function useRemoteDesktopReadiness(poll: boolean): {
  caps: RemoteDesktopCapabilities | null;
  /** 404 (feature flag off) or network failure — treat as "not available". */
  failed: boolean;
  refresh: () => void;
  runHostAction: (id: string, action: "request" | "open-settings") => Promise<void>;
} {
  const [caps, setCaps] = useState<RemoteDesktopCapabilities | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    api.get<RemoteDesktopCapabilities>("/api/remote-desktop/capabilities")
      .then((c) => { if (!cancelled) { setCaps(normalizeCapabilities(c)); setFailed(false); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [tick]);

  useEffect(() => {
    if (!poll) return;
    const timer = setInterval(refresh, READINESS_POLL_MS);
    return () => clearInterval(timer);
  }, [poll, refresh]);

  const runHostAction = useCallback(async (id: string, action: "request" | "open-settings") => {
    try { await api.post(`/api/remote-desktop/requirements/${encodeURIComponent(id)}/${action}`); } catch { /* panel shows state on next poll */ }
    refresh();
  }, [refresh]);

  return { caps, failed, refresh, runHostAction };
}
