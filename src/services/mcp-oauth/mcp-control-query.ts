import type { McpServerState } from "./mcp-oauth-redirect.ts";

/**
 * The control requests PPM sends to a prompt-less Claude subprocess.
 *
 * `mcpAuthenticate` and `mcpSubmitOAuthCallbackUrl` exist on the SDK's `Query` object
 * (they are what Claude's own apps use for "Sign in") but are left out of `sdk.d.ts`,
 * which is why they are typed here rather than imported. A test asserts they still exist
 * so an SDK upgrade that renames them fails loudly instead of the button doing nothing.
 */
export interface McpControlQuery {
  mcpServerStatus(): Promise<McpServerState[]>;
  mcpAuthenticate(serverName: string, redirectUri?: string): Promise<McpAuthenticateResult>;
  mcpSubmitOAuthCallbackUrl(serverName: string, callbackUrl: string): Promise<unknown>;
  reconnectMcpServer(serverName: string): Promise<void>;
}

/** What the CLI answers to `mcp_authenticate`. */
export interface McpAuthenticateResult {
  authUrl?: string;
  /** False when the server is already signed in — nothing for the user to do. */
  requiresUserAction: boolean;
  /**
   * False for claude.ai connectors: the grant happens on claude.ai and nothing is ever
   * redirected back, so completion can only be detected by reconnecting.
   */
  callbackExpected: boolean;
  /** "localhost": the CLI's own listener on `callbackPort`. "custom": the redirect URI PPM passed. */
  redirectScheme?: "localhost" | "custom";
  callbackPort?: number;
  state?: string;
}

export interface McpControlHandle {
  query: McpControlQuery;
  close(): void;
}

export type OpenMcpControlQuery = (cwd: string) => Promise<McpControlHandle>;

/**
 * A control request that never answers must not hold its subprocess (or everyone waiting
 * on it) forever; this turns silence into an error the caller can settle on.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Opens control queries through the Claude provider, configured exactly like its chats. */
export const openClaudeMcpControlQuery: OpenMcpControlQuery = async (cwd) => {
  // Lazy: the registry pulls in every provider, which a unit test of the flow logic must not.
  const { providerRegistry } = await import("../../providers/registry.ts");
  const provider = providerRegistry.get("claude") as { openMcpControlQuery?: (cwd: string) => McpControlHandle } | undefined;
  if (!provider?.openMcpControlQuery) throw new Error("The Claude provider is not available");
  return provider.openMcpControlQuery(cwd);
};
