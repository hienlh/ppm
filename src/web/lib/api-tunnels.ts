import { api } from "./api-client";

export type TunnelSource = "ppm" | "app" | "external";

export interface TunnelEntry {
  pid: number;
  port: number | null;
  url: string | null;
  source: TunnelSource;
  protected: boolean;
  status: "running";
  startedAt?: number;
  runRef?: string | null;
}

/** Typed client for the tunnel registry API (/api/tunnels). */
export const tunnelsApi = {
  list: (force = false) => api.get<TunnelEntry[]>(`/api/tunnels${force ? "?force=1" : ""}`),
  start: (port: number) => api.post<{ port: number; url: string }>("/api/tunnels", { port }),
  stop: (pid: number) => api.del(`/api/tunnels/${pid}`),
};

/**
 * PPM's own public tunnel (`/api/tunnel`) — distinct from the registry above,
 * which lists every cloudflared on the machine.
 */
export interface PublicTunnelStatus {
  /** A tunnel is actually serving right now. */
  active: boolean;
  url: string | null;
  localUrl: string | null;
  /** The master switch. Absent on a server older than it, where it was always on. */
  enabled?: boolean;
}

export const publicTunnelApi = {
  status: () => api.get<PublicTunnelStatus>("/api/tunnel"),
  setEnabled: (enabled: boolean) =>
    api.post<{ enabled: boolean; reload: string }>("/api/tunnel/enabled", { enabled }),
};
