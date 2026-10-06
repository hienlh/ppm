import { api } from "./api-client";

export type TunnelSource = "ppm" | "app" | "external";
/** A public trycloudflare URL, or a URL only the user's own tailnet can open. */
export type TunnelVia = "cloudflare" | "tailscale";

export interface TunnelEntry {
  pid: number;
  port: number | null;
  url: string | null;
  source: TunnelSource;
  protected: boolean;
  status: "running";
  startedAt?: number;
  runRef?: string | null;
  /** Absent for a cloudflared process. */
  via?: TunnelVia;
}

export type TailscaleAvailability =
  | { available: true; dnsName: string }
  | { available: false; reason: string };

/** Typed client for the tunnel registry API (/api/tunnels). */
export const tunnelsApi = {
  list: (force = false) => api.get<TunnelEntry[]>(`/api/tunnels${force ? "?force=1" : ""}`),
  start: (port: number, via: TunnelVia = "cloudflare") =>
    api.post<{ port: number; url: string; via: TunnelVia }>("/api/tunnels", { port, via }),
  stop: (pid: number) => api.del(`/api/tunnels/${pid}`),
  transports: () => api.get<{ tailscale: TailscaleAvailability }>("/api/tunnels/transports"),
  /** Let the PPM page at `origin` frame forwarded pages that refuse to be framed. */
  allowFraming: (origin: string) => api.post<{ origin: string }>("/api/tunnels/frame-ancestors", { origin }),
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
