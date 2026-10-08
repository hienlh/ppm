import { DB_EXECUTE_TOOL, DB_QUERY_TOOL, OPEN_QUERY_TOOL } from "../../shared/db-ai-tools.ts";
import { DB_APPROVAL_WAIT_MS } from "./db-approval-broker.ts";

/**
 * The three tools the database MCP endpoint serves. Their descriptions end with the connections
 * the AI may use, read when a chat's agent lists the tools, so it can name one without a call.
 */

export {
  DB_QUERY_TOOL, OPEN_QUERY_TOOL, DB_EXECUTE_TOOL, DB_TOOLS, CLAUDE_DB_TOOLS_MCP_SERVER, CODEX_DB_TOOLS_MCP_SERVER,
} from "../../shared/db-ai-tools.ts";

/** Environment variable the Codex app-server reads the bearer token from. */
export const CODEX_DB_TOOLS_MCP_TOKEN_ENV = "PPM_DB_TOOLS_MCP_TOKEN";

/** Rows each `db_query` result keeps unless the call asks otherwise, and at most. */
export const DB_QUERY_DEFAULT_ROWS = 100;
export const DB_QUERY_MAX_ROWS = 1_000;
/** Rows of a `RETURNING` result `db_execute` keeps. */
export const DB_EXECUTE_RESULT_ROWS = 100;
/** One `db_query` statement's time, when the connection sets no shorter query timeout. */
export const DB_QUERY_TIMEOUT_MS = 2 * 60_000;
/** One approved statement's time, when the connection sets no query timeout. */
export const DB_EXECUTE_STATEMENT_TIMEOUT_MS = 30 * 60_000;
/** How long `open_query` waits for a device to say the tab is open. */
export const OPEN_QUERY_WAIT_MS = 8_000;
/**
 * The providers' own timeout for a call: it must outlast the user's time to answer an approval
 * and the approved script's run, or the agent would give up on a change that then commits.
 */
export const DB_TOOLS_TIMEOUT_MS = DB_APPROVAL_WAIT_MS + DB_EXECUTE_STATEMENT_TIMEOUT_MS + 5 * 60_000;

/** How a provider reaches the endpoint for one session; built by `chatService` per turn. */
export interface DbToolsMcpAccess {
  url: string;
  token: string;
}

const CONNECTION = { type: "string", description: "The connection's name, as listed below." };
const DATABASE = {
  type: "string",
  description: "Another database on the same server, when the connection allows it; omit for the connection's own.",
};
const SQL = { type: "string", description: "One statement or a script of several, separated by semicolons." };

/** Where `db_query` sends the AI for a change, by which of the other two tools the user has on. */
export function dbChangeHint(on: (tool: string) => boolean): string {
  const execute = on(DB_EXECUTE_TOOL), open = on(OPEN_QUERY_TOOL);
  if (execute && open) return "To change data, call db_execute; to give the user a script to run themselves, call open_query.";
  if (execute) return "To change data, call db_execute, which asks the user to approve it.";
  if (open) return "To change data, give the user the script with open_query; they run it themselves.";
  return "You cannot change data: the user turned PPM's tools for that off. Give them the SQL to run themselves.";
}

/**
 * The tools, each description ending with `connections` (see `describeAiConnections`). `on` is
 * which tools the user has on; `db_query` names only those for a change.
 */
export function dbToolDefinitions(connections: string, on: (tool: string) => boolean) {
  return [
    {
      name: DB_QUERY_TOOL,
      title: "Query a database saved in PPM",
      description:
        "Run read-only SQL on a database connection the user saved in PPM. PPM connects with the credentials it keeps, "
        + "so you never need them, and runs the SQL inside a read-only transaction: it cannot change anything. Use it, "
        + "rather than `ppm db query`, psql or another client, to look at data and schema (information_schema, "
        + `pg_catalog, sqlite_master). Each result is cut at max_rows. ${dbChangeHint(on)}\n\n${connections}`,
      inputSchema: {
        type: "object",
        properties: {
          connection: CONNECTION,
          sql: SQL,
          database: DATABASE,
          max_rows: { type: "integer", minimum: 1, maximum: DB_QUERY_MAX_ROWS, description: `Rows each result keeps (default ${DB_QUERY_DEFAULT_ROWS}).` },
        },
        required: ["connection", "sql"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: OPEN_QUERY_TOOL,
      title: "Open a Query tab in PPM",
      description:
        "Open a PPM Query tab on the user's device, on a database connection saved in PPM, holding SQL you wrote. "
        + "Nothing runs: the user reads the script and presses Run themselves. Use it when the user wants to run or "
        + "review a script on their side. The tab opens beside the chat. On a readonly connection the user can still "
        + "run a change, with \"Run with write access (once)\" and PPM's password."
        + `\n\n${connections}`,
      inputSchema: {
        type: "object",
        properties: { connection: CONNECTION, sql: SQL, database: DATABASE },
        required: ["connection", "sql"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: DB_EXECUTE_TOOL,
      title: "Change a database, once the user approves",
      description:
        "Run SQL that changes data or schema on a database connection saved in PPM, after the user approves it. PPM "
        + "shows the user the connection, your reason and the exact SQL, and runs it only after they type PPM's "
        + `password; nothing runs if they decline or do not answer within ${Math.round(DB_APPROVAL_WAIT_MS / 60_000)} minutes. `
        + "An approval covers exactly this SQL, once: a changed script needs a new approval. The script runs in one "
        + "transaction PPM opens and ends, so do not put BEGIN, COMMIT or ROLLBACK in it; if a statement fails, or the "
        + "rows changed in all are not expected_rows, everything is rolled back. On MySQL and MariaDB, DDL commits by "
        + "itself and cannot be rolled back. Look at what the change will touch with db_query first, and pass "
        + "expected_rows whenever you know it. Readonly connections can be changed this way too: the approval is what "
        + `lifts it, for this one script.\n\n${connections}`,
      inputSchema: {
        type: "object",
        properties: {
          connection: CONNECTION,
          sql: SQL,
          reason: { type: "string", description: "What the change does and why, in a sentence or two the user reads before approving." },
          database: DATABASE,
          expected_rows: {
            type: "integer", minimum: 0,
            description: "Rows the script should insert, update or delete in all; any other count rolls it back.",
          },
        },
        required: ["connection", "sql", "reason"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
  ];
}
