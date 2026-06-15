import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "../types/mcp";
import { validateMcpConfig } from "../types/mcp";

// Reads MCP servers from Claude Code's ~/.claude.json so PPM inherits them
// automatically. Intentionally uses the real homedir (like claude-usage.service)
// because this config belongs to the Claude Code CLI, not PPM's ~/.ppm dir.

interface ClaudeJsonProject {
  mcpServers?: Record<string, McpServerConfig>;
}

interface ClaudeJson {
  mcpServers?: Record<string, McpServerConfig>;
  projects?: Record<string, ClaudeJsonProject>;
}

/** Match against ~/.claude.json project keys, which use forward slashes even on Windows. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

let warnedUnreadable = false;

function readClaudeJson(): ClaudeJson | null {
  const file = join(homedir(), ".claude.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ClaudeJson;
  } catch {
    if (!warnedUnreadable) {
      console.warn("[mcp] ~/.claude.json unreadable — skipping Claude Code MCP inheritance");
      warnedUnreadable = true;
    }
    return null;
  }
}

/**
 * MCP servers configured in Claude Code's ~/.claude.json that apply to `cwd`.
 * Merges global (top-level) servers with the project-scoped servers whose key
 * matches `cwd`. Project-scoped entries override global ones on name conflict.
 * Invalid entries are skipped. Returns {} when the file is missing or unreadable.
 */
export function listInheritedClaudeMcpServers(cwd: string): Record<string, McpServerConfig> {
  const data = readClaudeJson();
  if (!data) return {};

  const result: Record<string, McpServerConfig> = {};
  const add = (servers?: Record<string, McpServerConfig>) => {
    if (!servers) return;
    for (const [name, cfg] of Object.entries(servers)) {
      if (validateMcpConfig(cfg).length === 0) result[name] = cfg;
    }
  };

  // Global (user-scope) servers
  add(data.mcpServers);

  // Project-scoped servers for the matching project key
  if (data.projects) {
    const target = normalizePath(cwd);
    for (const [key, proj] of Object.entries(data.projects)) {
      if (normalizePath(key) === target) {
        add(proj.mcpServers);
        break;
      }
    }
  }

  return result;
}
