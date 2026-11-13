import {
  DB_CONNECTION_DELETE_TOOL, DB_CONNECTION_SAVE_TOOL, DB_CONNECTION_TEST_TOOL,
} from "../../shared/assistant-db-connection-tool-names.ts";
import type { AssistantToolDefinition } from "./assistant-tool-family.ts";

/**
 * How the connection tools are described to the agent, in the order of `DB_CONNECTION_TOOLS`.
 * Definitions only, so the tool list can be built without loading what the tools reach
 * (handlers: `assistant-db-connection-tools.ts`).
 */

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

const ID = { type: ["integer", "string"], description: "The connection's id, as db_list_connections gives it." };

export const DB_CONNECTION_TOOL_DEFINITIONS: readonly AssistantToolDefinition[] = [
  {
    name: DB_CONNECTION_SAVE_TOOL,
    title: "Add or change a database connection",
    description: "Add a saved database connection, or change one (`id` from db_list_connections; give only what changes). "
      + "A server connection takes `url` (postgres://, mysql://, mariadb://) and never a password: a URL holding one is "
      + "refused — the user types the password in PPM's connection form, or pass `passwordMode: \"ask\"` so PPM asks each "
      + "time it opens. A SQLite connection takes `file`, its full path; a file where PPM, logins or keys are kept is "
      + "refused. A new connection is read-only and available to the AI chat; only the user can make it writable, in PPM. "
      + "Pointing a connection with a saved password at another server is refused: the user does that in PPM. Always "
      + "asks the user first. Only connections available to the AI chat can be changed.",
    inputSchema: object({
      id: ID,
      name: { type: "string", minLength: 1, maxLength: 100, description: "The connection's name; required when adding." },
      type: { type: "string", enum: ["postgres", "mysql", "mariadb", "sqlite"], description: "Required when adding; a connection keeps its type." },
      url: { type: "string", description: "A server's URL without a password, e.g. postgres://app@db.example.com:5432/shop." },
      file: { type: "string", description: "A SQLite database file's full path." },
      passwordMode: { type: "string", enum: ["save", "ask"], description: "\"ask\": PPM asks the user for the password each time the connection opens." },
      group: { type: ["string", "null"], description: "The folder it is listed in; null for none." },
      color: { type: ["string", "null"], description: "#rgb or #rrggbb, or null to clear it." },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: DB_CONNECTION_DELETE_TOOL,
    title: "Delete a database connection",
    description: "Delete a saved connection from PPM. The database and its data are not touched; PPM forgets how to reach "
      + "it, with any saved password, and this cannot be undone. Always asks the user first. Only connections available to "
      + "the AI chat.",
    inputSchema: object({ id: ID }, ["id"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: DB_CONNECTION_TEST_TOOL,
    title: "Test a database connection",
    description: "Check that a saved connection opens, from the PPM host, and say where it went (the server, and the SSH "
      + "server when it tunnels). Runs without asking; at most 10 tests a minute. Only connections available to the AI chat; "
      + "one that asks for its password needs the user logged in to it in PPM first.",
    inputSchema: object({ id: ID }, ["id"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];
