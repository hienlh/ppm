/**
 * Pure decisions for MCP sign-in: where the authorization server sends the browser back
 * to, and which servers need a sign-in at all. Kept free of imports so they can be unit
 * tested without a CLI or a database.
 */

/** Public route that receives the authorization server's redirect and hands it to the CLI. */
export const MCP_OAUTH_CALLBACK_PATH = "/api/mcp-auth/callback";

/** The subset of the SDK's `McpServerStatus` PPM passes around. */
export interface McpServerState {
  name: string;
  status: string;
  error?: string;
  scope?: string;
  source?: string;
}

/**
 * The redirect URI to ask the CLI for, or undefined to let it use its own
 * `http://localhost:<port>/callback` listener.
 *
 * A redirect back to PPM is what makes a sign-in finish when the browser is not on the
 * host machine (a phone over a tunnel): the CLI's localhost listener is only reachable
 * from the host itself. It is offered only for an https origin, because authorization
 * servers refuse plain-http redirects to anything but loopback, and only when the origin
 * the browser reports is the host this request actually arrived on — otherwise a crafted
 * origin could have the authorization code delivered to somebody else's server.
 */
export function customRedirectUri(
  origin: string | undefined,
  requestHosts: Array<string | undefined>,
): string | undefined {
  if (!origin) return undefined;
  let url: URL;
  try { url = new URL(origin); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  const hosts = requestHosts
    .flatMap((h) => (h ?? "").split(","))
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (!hosts.includes(url.host.toLowerCase())) return undefined;
  return `${url.origin}${MCP_OAUTH_CALLBACK_PATH}`;
}

/** Names of the servers waiting for a sign-in, in the order the CLI reported them. */
export function needsAuthServerNames(servers: unknown): string[] {
  if (!Array.isArray(servers)) return [];
  const names: string[] = [];
  for (const s of servers) {
    if (s && typeof s === "object" && (s as { status?: unknown }).status === "needs-auth") {
      const name = (s as { name?: unknown }).name;
      if (typeof name === "string" && name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * Rebuild the redirect the CLI is waiting for from the query string that reached PPM.
 * The request URL itself cannot be forwarded: behind a tunnel it names the local port,
 * not the redirect URI the sign-in was started with.
 */
export function callbackUrlFor(redirectUri: string, search: string): string {
  const url = new URL(redirectUri);
  url.search = search.startsWith("?") ? search.slice(1) : search;
  return url.href;
}
