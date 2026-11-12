import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { AI_CHAT_MARK } from "../../services/ai-chat-env.ts";
import { createLogger } from "../../services/logger.ts";
import { CLAUDE_TAB_TOOLS_MCP_SERVER } from "../../shared/tab-open-protocol.ts";
import { CLAUDE_DB_TOOLS_MCP_SERVER } from "../../shared/db-ai-tools.ts";
import type { SendMessageOpts } from "../../types/chat.ts";

const log = createLogger("antigravity");

/**
 * The `conversation_summaries.db` layout agy 1.5.2 and the Antigravity app shared on 2026-11-07.
 * A CLI and an app that disagree on it would be two programs writing one catalogue in two shapes.
 */
const SHARED_STORE_SCHEMA_VERSION = 3;

/** The store agy uses when given no `--app-data-dir`. */
const CLI_STORE = "antigravity-cli";

/**
 * Everything agy is given of PPM's environment. agy hands its whole environment to every command
 * it runs, and PPM's carries tokens. The session bus and runtime dir are where agy reads its
 * Google sign-in, from the keyring.
 */
const AGY_ENV_ALLOWLIST = ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SHELL"];

/**
 * agy's environment. `home` replaces HOME; an extra account's home also gets the
 * `WSL_DISTRO_NAME` its sign-in was made with, which is what makes agy keep that token in
 * `<home>/.gemini` instead of the keyring.
 */
export function agyEnv(home?: string, accountHome = false): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of AGY_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (home) env.HOME = home;
  if (home && accountHome) env.WSL_DISTRO_NAME = "ppm";
  return { ...env, ...AI_CHAT_MARK };
}

/** An ACP `http` MCP server, as `session/new` and `session/load` take it. */
export interface AcpHttpMcpServer {
  type: "http";
  name: string;
  url: string;
  headers: { name: string; value: string }[];
}

/**
 * PPM's tab and database tools for a chat, as ACP MCP servers; `[]` without them. agy 1.5.2
 * advertises no `mcpCapabilities` yet takes `http` entries and sends their headers (measured
 * 2026-11-07), so the token travels in a header as it does for Claude, never in agy's
 * environment, which every command it runs inherits. The names are Claude's: agy calls the
 * tools `mcp_ppm-db_db_query` and so on, and asks no permission for them.
 */
export function agyMcpServers(opts?: Pick<SendMessageOpts, "tabToolsMcp" | "dbToolsMcp">): AcpHttpMcpServer[] {
  const servers: AcpHttpMcpServer[] = [];
  const add = (name: string, access?: { url: string; token: string }) => {
    if (access) servers.push({ type: "http", name, url: access.url, headers: [{ name: "Authorization", value: `Bearer ${access.token}` }] });
  };
  add(CLAUDE_TAB_TOOLS_MCP_SERVER, opts?.tabToolsMcp);
  add(CLAUDE_DB_TOOLS_MCP_SERVER, opts?.dbToolsMcp);
  return servers;
}

/**
 * The `--app-data-dir` for a chat: the Antigravity app's store for a new chat, so the app lists
 * it too, and for an existing chat the store its files are in. The app's store is used only
 * while its catalogue has the layout this was checked against; otherwise agy keeps to its own.
 */
export function agyStoreArgs(home: string, existingBrainDir?: string): string[] {
  const storeDir = existingBrainDir ? dirname(resolve(existingBrainDir)) : join(home, ".gemini", "antigravity");
  const store = basename(storeDir);
  if (store === CLI_STORE) return [];
  if (!existingBrainDir && !existsSync(join(storeDir, "conversation_summaries.db"))) return [];
  return sharedStoreUsable(storeDir) ? ["--app-data-dir", store] : [];
}

function sharedStoreUsable(storeDir: string): boolean {
  const file = join(storeDir, "conversation_summaries.db");
  let version: number | null = null;
  try {
    const db = new Database(file, { readonly: true });
    try {
      version = (db.query("PRAGMA user_version").get() as { user_version?: number } | null)?.user_version ?? null;
    } finally {
      db.close();
    }
  } catch (e) {
    log.warn(`could not read ${file}, keeping agy to its own store: ${(e as Error).message}`);
    return false;
  }
  if (version === SHARED_STORE_SCHEMA_VERSION) return true;
  log.warn(`${file} has layout ${version}, not ${SHARED_STORE_SCHEMA_VERSION}; keeping agy to its own store so it cannot write the app's in another shape`);
  return false;
}
