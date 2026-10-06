import { tunnelService } from "./tunnel.service.ts";
import { ppmPublicPort, tailscaleAppService } from "./tailscale/tailscale-app-service.ts";
import type { NotificationPayload } from "./notification.service.ts";
import { notificationPath } from "./notification-format.ts";

/**
 * An absolute link back into PPM, for a channel that has no browser page to take an
 * origin from (Telegram, ntfy). The tunnel URL reaches PPM from anywhere and PPM's
 * Tailscale address from the tailnet; without either, localhost. Never the LAN address:
 * that is plain HTTP on an insecure origin, where the browser turns off notifications,
 * the clipboard and the other permissions PPM asks for, while localhost counts as secure.
 */
export async function notificationLink(payload: Pick<NotificationPayload, "project" | "sessionId" | "providerId">): Promise<string> {
  const baseUrl = tunnelService.getTunnelUrl() ?? await tailscaleUrl() ?? `http://localhost:${ppmPublicPort()}`;
  return `${baseUrl.replace(/\/$/, "")}${notificationPath(payload)}`;
}

/** PPM's Tailscale Service address, while the service is on, approved and pointing at PPM. */
async function tailscaleUrl(): Promise<string | null> {
  const state = await tailscaleAppService.readState().catch(() => null);
  return state?.enabled && state.service.approved && state.service.pointsAtPpm ? state.service.url : null;
}
