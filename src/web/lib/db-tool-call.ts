import {
  CLAUDE_DB_TOOLS_MCP_SERVER, CODEX_DB_TOOLS_MCP_SERVER, DB_EXECUTE_TOOL, DB_QUERY_TOOL, OPEN_QUERY_TOOL,
} from "../../shared/db-ai-tools";

/**
 * Reads a chat event as a call of PPM's database tools, for the tool card that shows it. Pure,
 * so it is tested without the stores.
 */

export type DbTool = typeof DB_QUERY_TOOL | typeof OPEN_QUERY_TOOL | typeof DB_EXECUTE_TOOL;

export interface DbToolCall {
  tool: DbTool;
  connection: string;
  sql: string;
  database?: string;
  reason?: string;
  expectedRows?: number;
}

/*
 * Claude names the tool `mcp__ppm-db__db_query`. Codex names it `ppm_db:db_query` and wraps the
 * arguments as `{ server, tool, arguments }`, live and in the history read back alike.
 */
const TOOL_NAME = new RegExp(
  `^(?:mcp__${CLAUDE_DB_TOOLS_MCP_SERVER}__|${CODEX_DB_TOOLS_MCP_SERVER}:)(${DB_QUERY_TOOL}|${OPEN_QUERY_TOOL}|${DB_EXECUTE_TOOL})$`,
);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** What each tool does, as its card names it. */
export const DB_TOOL_LABELS: Record<DbTool, string> = {
  [DB_QUERY_TOOL]: "Database query",
  [OPEN_QUERY_TOOL]: "Open query",
  [DB_EXECUTE_TOOL]: "Database change",
};

/** The database tool a tool name is, under either provider's name, or null. */
export function dbToolOf(toolName: string): DbTool | null {
  return (TOOL_NAME.exec(toolName)?.[1] as DbTool | undefined) ?? null;
}

/** The database tool call an event is, under either provider's name, or null. */
export function dbToolCall(toolName: string, input: unknown): DbToolCall | null {
  const tool = dbToolOf(toolName);
  if (!tool || !isObj(input)) return null;
  const args = "arguments" in input && isObj(input.arguments) ? input.arguments : input;
  if (typeof args.connection !== "string" || typeof args.sql !== "string") return null;
  return {
    tool,
    connection: args.connection,
    sql: args.sql,
    ...(typeof args.database === "string" && args.database ? { database: args.database } : {}),
    ...(typeof args.reason === "string" && args.reason ? { reason: args.reason } : {}),
    ...(typeof args.expected_rows === "number" ? { expectedRows: args.expected_rows } : {}),
  };
}
