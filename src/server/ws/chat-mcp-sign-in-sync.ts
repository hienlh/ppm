/**
 * Keeps each chat's "needs sign-in" list in step with MCP sign-ins.
 *
 * The list comes from the SDK's `init` message, so it is only as fresh as the subprocess.
 * A sign-in finished from any screen stores tokens every Claude process can read, but a
 * running chat subprocess keeps the server in `needs-auth` until told to reconnect it — so
 * on each sign-in the server is reconnected in every chat still listing it.
 *
 * If that chat's subprocess still reports `needs-auth` afterwards, the only way to make it
 * read the tokens is a fresh subprocess. That is done only when nothing would be lost: an
 * idle turn is not enough, because background agents and shells keep running inside the
 * subprocess after the turn that started them has ended. Otherwise the server goes back on
 * the list, so the bar keeps saying what is still true.
 */
import { mcpOAuthFlows } from "../../services/mcp-oauth/mcp-oauth-flows.ts";

export interface McpSignInSession {
  providerId: string;
  phase: string;
  mcpNeedsAuth?: string[];
}

export interface McpSignInSyncDeps {
  sessions: () => Iterable<[string, McpSignInSession]>;
  broadcast: (sessionId: string, event: unknown) => void;
  reconnect: (providerId: string, sessionId: string, serverName: string) => Promise<string | null>;
  /** Whether the subprocess can be replaced without killing work still running in it. */
  canDrop: (sessionId: string) => boolean;
  dropIdle: (sessionId: string, serverName: string) => void;
}

/** The event carrying a session's list to its clients. */
export function mcpStatusEvent(needsAuth: string[] | undefined) {
  return { type: "mcp_status", needsAuth: needsAuth ?? [] };
}

/** React to one successful sign-in. Exported for tests; production wires it via `register`. */
export async function handleMcpAuthorized(serverName: string, deps: McpSignInSyncDeps): Promise<void> {
  const affected = [...deps.sessions()].filter(([, s]) => s.mcpNeedsAuth?.includes(serverName));
  await Promise.all(affected.map(async ([sessionId, s]) => {
    s.mcpNeedsAuth = s.mcpNeedsAuth!.filter((n) => n !== serverName);
    deps.broadcast(sessionId, mcpStatusEvent(s.mcpNeedsAuth));
    const status = await deps.reconnect(s.providerId, sessionId, serverName).catch(() => null);
    // Anything but a definite `needs-auth` (connected, pending, a transient failure, or no
    // live subprocess at all) is left alone: the next `init` reports the truth.
    if (status !== "needs-auth") return;
    if (s.phase === "idle" && deps.canDrop(sessionId)) {
      deps.dropIdle(sessionId, serverName);
      return;
    }
    if (!s.mcpNeedsAuth!.includes(serverName)) s.mcpNeedsAuth = [...s.mcpNeedsAuth!, serverName];
    deps.broadcast(sessionId, mcpStatusEvent(s.mcpNeedsAuth));
  }));
}

export function registerMcpSignInSync(deps: McpSignInSyncDeps): () => void {
  return mcpOAuthFlows.onAuthorized((serverName) => { void handleMcpAuthorized(serverName, deps); });
}
