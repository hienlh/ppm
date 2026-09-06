/** Pure URL builder — mirrors `ws-client.ts`'s dev-port bypass so it's unit-testable without
 *  mounting a real WebSocket or window.location. */
import { withWsAuth } from "@/lib/ws-auth";

export interface LocationParts {
  protocol: string;
  hostname: string;
  host: string;
}

export function resolveRemoteDesktopWsUrl(loc: LocationParts, isDev: boolean, devPort = "8081"): string {
  const authed = withWsAuth("/ws/remote-desktop");
  const wsProtocol = loc.protocol === "https:" ? "wss:" : "ws:";
  if (isDev && loc.protocol !== "https:") {
    // Same bypass as ws-client.ts: Vite's dev proxy has unreliable WS upgrade handling.
    // Port defaults to 8081 (the normal `bun dev:server` port) but is overridable via
    // `VITE_DEV_API_PORT` for an alt-port dev stack (see `PPM_DEV_API` in vite.config.ts) —
    // without this, a second dev stack on e.g. 8082 would always connect to the wrong server.
    return `ws://${loc.hostname}:${devPort}${authed}`;
  }
  return `${wsProtocol}//${loc.host}${authed}`;
}
