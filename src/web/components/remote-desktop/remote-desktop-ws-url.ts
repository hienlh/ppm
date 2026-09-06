/** Pure URL builder — mirrors `ws-client.ts`'s dev-port bypass so it's unit-testable without
 *  mounting a real WebSocket or window.location. */
import { withWsAuth } from "@/lib/ws-auth";

export interface LocationParts {
  protocol: string;
  hostname: string;
  host: string;
}

export function resolveRemoteDesktopWsUrl(loc: LocationParts, isDev: boolean): string {
  const authed = withWsAuth("/ws/remote-desktop");
  const wsProtocol = loc.protocol === "https:" ? "wss:" : "ws:";
  if (isDev && loc.protocol !== "https:") {
    // Same bypass as ws-client.ts: Vite's dev proxy has unreliable WS upgrade handling.
    return `ws://${loc.hostname}:8081${authed}`;
  }
  return `${wsProtocol}//${loc.host}${authed}`;
}
