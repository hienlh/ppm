import { api } from "./api-client";

export type LoginState = "idle" | "waiting" | "slow" | "success" | "timeout" | "cancelled" | "error";
export interface LoginSnapshot { state: LoginState; url: string | null; message: string | null }

export type CertState = "none" | "invalid" | "ok";

export interface NamedTunnelStatus {
  mode: "quick" | "named";
  hostname: string | null;
  tunnelName: string | null;
  tokenMasked: string | null;
  certState: CertState;
  dismissed: boolean;
  login: LoginSnapshot;
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
