import { useState, useEffect, useCallback } from "react";
import { getMcpServers, deleteMcpServer, type McpServerEntry } from "@/lib/api-mcp";

/** Loads + manages MCP servers (config-based, distinct from file resources). */
export function useMcpServers() {
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setServers(await getMcpServers());
    } catch {
      // keep previous list on transient failure
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const remove = useCallback(async (name: string) => {
    await deleteMcpServer(name);
    await reload();
  }, [reload]);

  return { servers, loading, reload, remove };
}
