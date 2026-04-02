import type { Database } from "bun:sqlite";
import type { McpServerConfig, McpTransportType } from "../types/mcp";
import { validateMcpName, validateMcpConfig } from "../types/mcp";
import { getDb } from "./db.service";

function resolveTransport(config: McpServerConfig): McpTransportType {
  if ("type" in config && config.type) return config.type;
  return "stdio";
}

function safeParse(json: string, label: string): McpServerConfig | null {
  try { return JSON.parse(json); }
  catch { console.warn(`[mcp] Skipping ${label}: corrupt config`); return null; }
}

export class McpConfigService {
  private explicitDb: Database | null;

  constructor(db?: Database) {
    this.explicitDb = db ?? null;
  }

  /** Get DB — explicit (testing) or lazy singleton */
  private get db(): Database {
    return this.explicitDb ?? getDb();
  }

  /** List all MCP servers as Record (SDK-compatible format) */
  list(): Record<string, McpServerConfig> {
    try {
      const rows = this.db.query("SELECT name, config FROM mcp_servers ORDER BY name").all() as { name: string; config: string }[];
      const result: Record<string, McpServerConfig> = {};
      for (const row of rows) {
        const parsed = safeParse(row.config, row.name);
        if (parsed) result[row.name] = parsed;
      }
      return result;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (msg.includes("no such table")) {
        console.warn("[mcp] mcp_servers table not found — returning empty list");
        return {};
      }
      throw e;
    }
  }

  /** List as array with metadata (for UI) */
  listWithMeta(): Array<{ name: string; transport: string; config: McpServerConfig; createdAt: string; updatedAt: string }> {
    const rows = this.db.query("SELECT name, transport, config, created_at, updated_at FROM mcp_servers ORDER BY name").all() as {
      name: string; transport: string; config: string; created_at: string; updated_at: string;
    }[];
    const result: Array<{ name: string; transport: string; config: McpServerConfig; createdAt: string; updatedAt: string }> = [];
    for (const r of rows) {
      const parsed = safeParse(r.config, r.name);
      if (parsed) result.push({ name: r.name, transport: r.transport, config: parsed, createdAt: r.created_at, updatedAt: r.updated_at });
    }
    return result;
  }

  /** Get single server */
  get(name: string): McpServerConfig | null {
    const row = this.db.query("SELECT config FROM mcp_servers WHERE name = ?").get(name) as { config: string } | null;
    return row ? safeParse(row.config, name) : null;
  }

  /** Add or update server */
  set(name: string, config: McpServerConfig): void {
    const transport = resolveTransport(config);
    this.db.query(`
      INSERT INTO mcp_servers (name, transport, config, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        transport = excluded.transport,
        config = excluded.config,
        updated_at = datetime('now')
    `).run(name, transport, JSON.stringify(config));
  }

  /** Remove server. Returns true if deleted. */
  remove(name: string): boolean {
    const result = this.db.query("DELETE FROM mcp_servers WHERE name = ?").run(name);
    return result.changes > 0;
  }

  /** Check if name exists */
  exists(name: string): boolean {
    const row = this.db.query("SELECT 1 FROM mcp_servers WHERE name = ?").get(name);
    return row != null;
  }

  /** Bulk insert (for import) — validates entries, skips existing/invalid, wrapped in transaction */
  bulkImport(servers: Record<string, McpServerConfig>): { imported: number; skipped: number } {
    let imported = 0, skipped = 0;
    const tx = this.db.transaction(() => {
      for (const [name, config] of Object.entries(servers)) {
        if (this.exists(name)) { skipped++; continue; }
        const nameErr = validateMcpName(name);
        if (nameErr) { skipped++; continue; }
        const configErrs = validateMcpConfig(config);
        if (configErrs.length) { skipped++; continue; }
        this.set(name, config);
        imported++;
      }
    });
    tx();
    return { imported, skipped };
  }
}

export const mcpConfigService = new McpConfigService();
