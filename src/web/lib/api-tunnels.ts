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
