import { Hono } from "hono";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { mcpConfigService } from "../../services/mcp-config.service";
import { validateMcpName, validateMcpConfig, type McpServerConfig } from "../../types/mcp";
import { ok, err } from "../../types/api";

export const mcpRoutes = new Hono();

const CLAUDE_CONFIG = join(homedir(), ".claude.json");

function readClaudeMcpServers(): Record<string, unknown> | null {
  if (!existsSync(CLAUDE_CONFIG)) return null;
  try {
    const data = JSON.parse(readFileSync(CLAUDE_CONFIG, "utf-8"));
    return data.mcpServers ?? null;
  } catch { return null; }
}

// GET / — list all (auto-imports from ~/.claude.json on first access if table empty)
mcpRoutes.get("/", (c) => {
  let servers = mcpConfigService.listWithMeta();
  if (servers.length === 0) {
    const claudeServers = readClaudeMcpServers();
    if (claudeServers && Object.keys(claudeServers).length > 0) {
      mcpConfigService.bulkImport(claudeServers as Record<string, McpServerConfig>);
      servers = mcpConfigService.listWithMeta();
    }
  }
  return c.json(ok(servers));
});

// GET /import/preview — show what would be imported
mcpRoutes.get("/import/preview", (c) => {
  const servers = readClaudeMcpServers();
  if (!servers) return c.json(ok({ available: false, servers: {} }));
  return c.json(ok({ available: true, servers }));
});

// POST /import — import from ~/.claude.json
mcpRoutes.post("/import", (c) => {
  const servers = readClaudeMcpServers();
  if (!servers) return c.json(err("~/.claude.json not found or has no mcpServers"), 404);
  const result = mcpConfigService.bulkImport(servers as Record<string, McpServerConfig>);
  return c.json(ok(result));
});

// GET /:name — single server
mcpRoutes.get("/:name", (c) => {
  const config = mcpConfigService.get(c.req.param("name"));
  if (!config) return c.json(err("Server not found"), 404);
  return c.json(ok(config));
});

// POST / — add new server
mcpRoutes.post("/", async (c) => {
  const { name, config } = await c.req.json();
  const nameErr = validateMcpName(name);
  if (nameErr) return c.json(err(nameErr), 400);
  const configErrs = validateMcpConfig(config);
  if (configErrs.length) return c.json(err(configErrs.join("; ")), 400);
  if (mcpConfigService.exists(name)) return c.json(err("Server already exists"), 409);
  mcpConfigService.set(name, config);
  return c.json(ok({ name }), 201);
});

// PUT /:name — update server config
mcpRoutes.put("/:name", async (c) => {
  const name = c.req.param("name");
  if (!mcpConfigService.exists(name)) return c.json(err("Server not found"), 404);
  const config = await c.req.json();
  const configErrs = validateMcpConfig(config);
  if (configErrs.length) return c.json(err(configErrs.join("; ")), 400);
  mcpConfigService.set(name, config);
  return c.json(ok({ name }));
});

// DELETE /:name — remove server
mcpRoutes.delete("/:name", (c) => {
  const removed = mcpConfigService.remove(c.req.param("name"));
  if (!removed) return c.json(err("Server not found"), 404);
  return c.json(ok(true));
});
