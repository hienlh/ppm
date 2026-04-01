/** stdio transport */
export interface McpStdioConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** HTTP transport */
export interface McpHttpConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/** SSE transport */
export interface McpSseConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig | McpSseConfig;
export type McpTransportType = "stdio" | "http" | "sse";

export function validateMcpName(name: string): string | null {
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) return "Name must start with a letter/digit, then alphanumeric, hyphens, or underscores";
  if (name.length > 50) return "Name max 50 chars";
  return null;
}

export function validateMcpConfig(config: unknown): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== "object") return ["Config must be an object"];
  const c = config as Record<string, unknown>;
  const type = (c.type as string) ?? "stdio";

  if (type === "stdio") {
    if (!c.command || typeof c.command !== "string") errors.push("command is required for stdio");
  } else if (type === "http" || type === "sse") {
    if (!c.url || typeof c.url !== "string") errors.push("url is required for " + type);
    if (c.url && typeof c.url === "string" && !/^https?:\/\/.+/.test(c.url)) errors.push("url must be HTTP(S)");
  } else {
    errors.push("type must be stdio, http, or sse");
  }
  return errors;
}
