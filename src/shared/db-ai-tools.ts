import type { DbType } from "./db-types.ts";

/**
 * PPM's database tools for an AI chat: `db_query` reads, `open_query` hands the user a script in
 * a Query tab, and `db_execute` runs a change once the user approves it with PPM's password. All
 * three work on the connections saved in PPM, so the AI never holds a database's credentials.
 *
 * Claude addresses MCP tools as `mcp__<server>__<tool>`; Codex takes the server name from its
 * config key, where a hyphen is not a safe character. Neither is plain `ppm`, which a user may
 * already have as an MCP server of their own.
 */

export const DB_QUERY_TOOL = "db_query";
export const OPEN_QUERY_TOOL = "open_query";
export const DB_EXECUTE_TOOL = "db_execute";
export const DB_TOOLS = [DB_QUERY_TOOL, OPEN_QUERY_TOOL, DB_EXECUTE_TOOL] as const;

export const CLAUDE_DB_TOOLS_MCP_SERVER = "ppm-db";
export const CODEX_DB_TOOLS_MCP_SERVER = "ppm_db";

/**
 * The `tool` of the `approval_request` a `db_execute` call waits on. Not any provider's name for
 * a tool, so the chat can tell this approval from a provider's own and draw its own card.
 */
export const DB_EXECUTE_APPROVAL = "ppm:db_execute";

/** What a `db_execute` approval shows the user. Built by the server from the saved connection. */
export interface DbExecuteApprovalInput {
  connectionId: number;
  connectionName: string;
  dbType: DbType;
  /** The folder the connection sits in (`Prod`, `Develop`), as the CONNECTIONS tree shows it. */
  group: string | null;
  color: string | null;
  /** The connection is readonly: approving lifts that for this one script. */
  readonly: boolean;
  /** One of the server's other databases; absent for the connection's own. */
  database?: string;
  sql: string;
  /** Why the AI wants to run it, in its own words. */
  reason: string;
  /** Rows the script should change in all; a run that changes another number is rolled back. */
  expectedRows?: number;
  /** Approving asks for PPM's password; false only when PPM runs without one. */
  passwordRequired: boolean;
}

/** `POST /api/db/ai-approvals/:requestId` — the user's answer to a `db_execute` approval. */
export interface DbApprovalAnswer {
  approved: boolean;
  /** PPM's password, typed by the user; needed to approve. */
  password?: string;
}

/** What `open_query` asks the user's device to open: a Query tab on a saved connection. */
export interface DbQueryTabOpen {
  connectionId: number;
  connectionName: string;
  dbType: DbType;
  connectionColor: string | null;
  /** One of the server's other databases; absent for the connection's own. */
  database?: string;
  sql: string;
}

export const MAX_DB_TOOL_SQL_CHARS = 50_000;
export const MAX_DB_TOOL_REASON_CHARS = 2_000;

/** A `db_execute` approval's input, from a `session_state` or an `approval_request`; null for anything else. */
export function dbExecuteApprovalInput(tool: string, input: unknown): DbExecuteApprovalInput | null {
  if (tool !== DB_EXECUTE_APPROVAL || !input || typeof input !== "object") return null;
  const i = input as Partial<DbExecuteApprovalInput>;
  if (typeof i.connectionId !== "number" || typeof i.connectionName !== "string" || typeof i.sql !== "string") return null;
  return i as DbExecuteApprovalInput;
}
