import { api } from "./api-client";

export type McpAuthFlowStatus = "waiting" | "completing" | "done" | "failed" | "expired" | "cancelled";

export interface McpAuthFlow {
  id: string;
  serverName: string;
  status: McpAuthFlowStatus;
  /** Open this to sign in. Absent once the flow has settled. */
  authUrl?: string;
  /** False for a claude.ai connector: nothing redirects back, the user confirms instead. */
  callbackExpected: boolean;
  /** "localhost": the browser returns to the host machine's loopback, which only works on that machine. */
  redirectScheme?: "localhost" | "custom";
  error?: string;
}

export interface McpServerState {
  name: string;
  status: string;
  error?: string;
  scope?: string;
  source?: string;
}

export function getMcpAuthStatus(project?: string, fresh = false): Promise<McpServerState[]> {
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (fresh) params.set("fresh", "1");
  const qs = params.toString();
  return api.get<McpServerState[]>(`/api/mcp-auth/status${qs ? `?${qs}` : ""}`);
}

export function startMcpAuth(server: string, project?: string): Promise<McpAuthFlow> {
  // The origin lets the server have the sign-in return to PPM itself, which is what makes
  // it work from a phone; the server only uses it when it matches the request's host.
  return api.post<McpAuthFlow>("/api/mcp-auth/start", { server, project, origin: window.location.origin });
}

export function getMcpAuthFlow(id: string): Promise<McpAuthFlow> {
  return api.get<McpAuthFlow>(`/api/mcp-auth/flows/${encodeURIComponent(id)}`);
}

export function submitMcpAuthCallback(id: string, url: string): Promise<McpAuthFlow> {
  return api.post<McpAuthFlow>(`/api/mcp-auth/flows/${encodeURIComponent(id)}/callback`, { url });
}

export function confirmMcpAuth(id: string): Promise<McpAuthFlow> {
  return api.post<McpAuthFlow>(`/api/mcp-auth/flows/${encodeURIComponent(id)}/confirm`, {});
}

export function cancelMcpAuth(id: string): Promise<void> {
  return api.del(`/api/mcp-auth/flows/${encodeURIComponent(id)}`);
}
