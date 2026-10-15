import { DB_TYPE_LABELS, dialectNameOf, type DbType } from "./db-types.ts";
import { splitSqlScript, sqlCode } from "./split-sql-statements.ts";

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

/**
 * Statements MySQL and MariaDB commit by themselves, with everything before them, by first words:
 * MySQL's "Statements That Cause an Implicit Commit" as both servers behave (measured on MySQL 8.4
 * and MariaDB 11.8) — DDL (a TEMPORARY table aside), accounts, passwords and grants, table locks and
 * table maintenance. Not LOAD DATA, which that list names for NDB tables only (it commits nothing
 * on InnoDB or MyISAM), and not RESET PERSIST, which commits nothing either.
 */
const COMMITS_BY_ITSELF = /^(alter|create|drop|rename|truncate|grant|revoke|set\s+password|lock|unlock|analyze|optimize|repair|check|flush|reset(?!\s+persist\b)|install|uninstall)\b/i;
/** The key-cache statements, which MySQL commits by itself and MariaDB runs inside the transaction. */
const MYSQL_COMMITS_BY_ITSELF = /^(cache\s+index|load\s+index)\b/i;
const TEMPORARY_TABLE = /^(create|drop)\s+(or\s+replace\s+)?temporary\b/i;

/**
 * The words that make MySQL or MariaDB commit `statement` by itself, with everything before it
 * (`ALTER`, `SET PASSWORD`), or null — always null on the other databases. Read from the SQL.
 */
export function commitsByItself(dbType: DbType, statement: string): string | null {
  if (dialectNameOf(dbType) !== "mysql") return null;
  const code = sqlCode(statement, "mysql").trim();
  if (TEMPORARY_TABLE.test(code)) return null;
  const words = (COMMITS_BY_ITSELF.exec(code) ?? (dbType === "mysql" ? MYSQL_COMMITS_BY_ITSELF.exec(code) : null))?.[1];
  return words ? words.replace(/\s+/g, " ").toUpperCase() : null;
}

/**
 * What a `db_execute` approval adds when part of a MySQL or MariaDB script cannot be rolled back:
 * the last statement that commits by itself takes everything before it along. Null on the other
 * databases, and for a script with none. Read from the SQL; what the server actually kept is in
 * the run's own report (`runApprovedScript`).
 */
export function selfCommitNote(dbType: DbType, sql: string): string | null {
  if (dialectNameOf(dbType) !== "mysql") return null;
  const statements = splitSqlScript(sql, "mysql");
  for (let i = statements.length - 1; i >= 0; i--) {
    const words = commitsByItself(dbType, statements[i]!.sql);
    if (!words) continue;
    const what = `${DB_TYPE_LABELS[dbType]} commits the ${words}${statements.length > 1 ? ` in statement ${i + 1}` : ""} by itself`;
    return i === 0 ? `${what}, so it cannot be rolled back.` : `${what}, together with everything before it, so statements 1–${i + 1} cannot be rolled back.`;
  }
  return null;
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
