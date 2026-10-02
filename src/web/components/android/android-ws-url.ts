/** Pure URL builder — mirrors `remote-desktop-ws-url.ts`, including its dev-port bypass, so it
 *  is unit-testable without a real WebSocket or `window.location`. */
import { withWsAuth } from "@/lib/ws-auth";

export interface LocationParts {
  protocol: string;
  hostname: string;
  host: string;
}

export function resolveAndroidWsUrl(loc: LocationParts, isDev: boolean, devPort = "8081"): string {
  // The device is NOT in this URL: it is named by the nonce, which the first WS message carries.
  // A query string lands in proxy and tunnel access logs; which VM a socket drives should not.
  const authed = withWsAuth("/ws/android");
  const wsProtocol = loc.protocol === "https:" ? "wss:" : "ws:";
  if (isDev && loc.protocol !== "https:") {
    // Same bypass as ws-client.ts: Vite's dev proxy has unreliable WS upgrade handling.
    return `ws://${loc.hostname}:${devPort}${authed}`;
  }
  return `${wsProtocol}//${loc.host}${authed}`;
}
