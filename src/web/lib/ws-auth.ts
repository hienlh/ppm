import { getAuthToken } from "@/lib/api-client";

/**
 * Append the session token to a `/ws/...` path so the server can authenticate
 * the upgrade. Browsers cannot set headers on WebSocket handshakes, so every
 * socket (global, extensions, terminal, chat, group) carries it as a query
 * parameter — one helper keeps the spelling identical to what the server reads.
 */
export function withWsAuth(path: string): string {
  const token = getAuthToken();
  if (!token || /[?&]token=/.test(path)) return path;
  return `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}
