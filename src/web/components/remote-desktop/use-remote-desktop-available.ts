/**
 * Whether the Remote Desktop entry should surface in the UI. Hidden only when the host opted
 * out (`REMOTE_DESKTOP_ENABLED=0` — the endpoint 404s) or the OS has no capture path at all.
 * Everything the user can fix in place — ffmpeg missing, a macOS permission not granted — keeps
 * the entry visible; `RemoteDesktopReadinessGate` walks them through it after the warning.
 */
import { useRemoteDesktopReadiness } from "./use-remote-desktop-readiness";

export function useRemoteDesktopAvailable(): { available: boolean; authRequired: boolean } {
  const { caps } = useRemoteDesktopReadiness(false);
  return { available: !!caps?.platformSupported, authRequired: !!caps?.authRequired };
}
