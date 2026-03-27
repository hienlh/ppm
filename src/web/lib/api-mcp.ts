import { api } from "./api-client";
import type { McpServerConfig } from "../../types/mcp";

export interface McpServerEntry {
  name: string;
  transport: string;
  config: McpServerConfig;
  createdAt: string;
  updatedAt: string;
}

export function getMcpServers(): Promise<McpServerEntry[]> {
  return api.get<McpServerEntry[]>("/api/settings/mcp");
}

export function getMcpServer(name: string): Promise<McpServerConfig> {
  return api.get<McpServerConfig>(`/api/settings/mcp/${encodeURIComponent(name)}`);
}

export function addMcpServer(name: string, config: McpServerConfig): Promise<{ name: string }> {
  return api.post<{ name: string }>("/api/settings/mcp", { name, config });
}

export function updateMcpServer(name: string, config: McpServerConfig): Promise<{ name: string }> {
  return api.put<{ name: string }>(`/api/settings/mcp/${encodeURIComponent(name)}`, config);
}

export function deleteMcpServer(name: string): Promise<void> {
  return api.del(`/api/settings/mcp/${encodeURIComponent(name)}`);
}

export function importMcpServers(): Promise<{ imported: number; skipped: number }> {
  return api.post<{ imported: number; skipped: number }>("/api/settings/mcp/import", {});
}

export function previewMcpImport(): Promise<{ available: boolean; servers: Record<string, McpServerConfig> }> {
  return api.get<{ available: boolean; servers: Record<string, McpServerConfig> }>("/api/settings/mcp/import/preview");
}
