import { api } from "./api-client";
import type { TailscaleLoginSnapshot, TailscaleSettingsState } from "../../shared/tailscale-setup";

/** Typed client for the Tailscale settings API (/api/tailscale). */
export const tailscaleApi = {
  state: () => api.get<TailscaleSettingsState>("/api/tailscale/state"),
  login: () => api.post<TailscaleLoginSnapshot>("/api/tailscale/login"),
  cancelLogin: () => api.post<TailscaleLoginSnapshot>("/api/tailscale/login/cancel"),
  /** `{ enabled: true, name?, replace? }` turns the address on, `{ enabled: false }` off, `{ name }` renames it. */
  setService: (body: { enabled?: boolean; name?: string; replace?: boolean }) =>
    api.post<TailscaleSettingsState>("/api/tailscale/service", body),
};
