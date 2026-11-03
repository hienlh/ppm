import { api } from "./api-client";
import type { CertState } from "./api-named-tunnel";

export type ShareHostMode = "quick" | "named" | "shared";

/** `GET /api/share-host/status`: what the user asked for, and what the supervisor runs. */
export interface ShareHostStatus {
  enabled: boolean;
  mode: ShareHostMode;
  hostname: string | null;
  tunnelName: string | null;
  /** A supervisor runs that can apply a change without a restart. */
  canApply: boolean;
  supervised: boolean;
  running: boolean;
  /** Reviewers can open `url` now. */
  connected: boolean;
  /** Where review links open: the live address, or a fixed one that is reconnecting. */
  url: string | null;
  warning: string | null;
  ppmTunnel: { named: boolean; hostname: string | null; enabled: boolean };
  certState: CertState;
  authEnabled: boolean;
}

/** Whether the running supervisor took a change, and what to tell the user when it did not. */
export type ShareHostApplied = { applied: true } | { applied: false; message: string };

export interface ShareHostSetupResult {
  hostname: string;
  tunnelName: string;
  applied: ShareHostApplied;
}

/** Typed client for the review address API (`/api/share-host`). */
export const shareHostApi = {
  status: () => api.get<ShareHostStatus>("/api/share-host/status"),
  zone: () => api.get<{ zone: string; proposedHostname: string }>("/api/share-host/zone"),
  setEnabled: (enabled: boolean) => api.post<ShareHostApplied>("/api/share-host/enabled", { enabled }),
  useTemporary: () => api.post<ShareHostApplied>("/api/share-host/quick"),
  setup: (mode: "named" | "shared", hostname: string) =>
    api.post<ShareHostSetupResult>("/api/share-host/setup", { mode, hostname }),
};
