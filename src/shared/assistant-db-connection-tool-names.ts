/**
 * The PPM Assistant's tools that add, change, delete and test a saved database connection, in the
 * order `tools/list` gives them. Spread into `ASSISTANT_TOOLS` (`assistant-tool-names.ts`), which is
 * what grants them to Claude and Codex; definitions and handlers live in
 * `src/services/assistant-mcp/assistant-db-connection-*.ts`. Listing connections and querying one
 * (`db_list_connections`, `db_query`) are not in this family: they read the database service directly.
 */
export const DB_CONNECTION_SAVE_TOOL = "db_connection_save";
export const DB_CONNECTION_DELETE_TOOL = "db_connection_delete";
export const DB_CONNECTION_TEST_TOOL = "db_connection_test";

export const DB_CONNECTION_TOOLS = [DB_CONNECTION_SAVE_TOOL, DB_CONNECTION_DELETE_TOOL, DB_CONNECTION_TEST_TOOL] as const;
