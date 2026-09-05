import { api } from "./api-client";

export type LoginState = "idle" | "waiting" | "slow" | "success" | "timeout" | "cancelled" | "error";
export interface LoginSnapshot { state: LoginState; url: string | null; message: string | null }

// "mismatch" = a valid, parseable cert whose pinned account/zone no longer
// matches this setup's pin — same recovery path as "invalid" (re-login), but
// a different reason to show the user.
export type CertState = "none" | "invalid" | "ok" | "mismatch";

export interface NamedTunnelStatus {
  mode: "quick" | "named";
  hostname: string | null;
  tunnelName: string | null;
  tokenMasked: string | null;
  certState: CertState;
  dismissed: boolean;
  login: LoginSnapshot;
  /** What the supervisor is actually running (from status.json); null when no supervisor. */
  liveMode?: "quick" | "named" | null;
  /** Supervisor-side downgrade warning (e.g. named tunnel failed → running quick). */
  tunnelWarning?: string | null;
  /**
   * PPM auth toggle — a named tunnel must never be reachable from an
   * auth-disabled install, so the client hides the popup when this is false.
   * Optional so older servers (no field) keep the previous "don't nag"
   * behaviour: the reducer treats a missing value as `true`.
   */
  authEnabled?: boolean;
}

export interface ZoneInfo {
  zone: string;
  proposedHostname: string;
}

export interface SetupResult {
  hostname: string;
  tunnelName: string;
  pending?: boolean;
  message?: string;
}

/** Typed client for the named-tunnel setup API (/api/tunnel/named). */
export const namedTunnelApi = {
  status: () => api.get<NamedTunnelStatus>("/api/tunnel/named/status"),
  dismiss: () => api.post<{ dismissed: true }>("/api/tunnel/named/dismiss"),
  zone: () => api.get<ZoneInfo>("/api/tunnel/named/zone"),
  login: (relogin = false) =>
    api.post<LoginSnapshot>(`/api/tunnel/named/login${relogin ? "?relogin=1" : ""}`),
  cancelLogin: () => api.post<{ state: "cancelled" }>("/api/tunnel/named/login/cancel"),
  setup: (hostname: string) => api.post<SetupResult>("/api/tunnel/named/setup", { hostname }),
  disable: () => api.post<{ mode: "quick" }>("/api/tunnel/named/disable"),
};
