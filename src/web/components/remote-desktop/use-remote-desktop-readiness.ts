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

export interface RemoteDesktopCapabilities {
  displays: RemoteDisplay[];
  ffmpegAvailable: boolean;
  videoAvailable: boolean;
  inputAvailable: boolean;
  authRequired: boolean;
  platform: string;
  platformSupported: boolean;
  requirements: RemoteDesktopRequirement[];
  videoReady: boolean;
  inputReady: boolean;
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
      .then((c) => { if (!cancelled) { setCaps(c); setFailed(false); } })
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
