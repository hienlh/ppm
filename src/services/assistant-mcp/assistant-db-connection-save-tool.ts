import type { Json } from "../mcp-http-endpoint.ts";
import { DB_CONNECTION_SAVE_TOOL } from "../../shared/assistant-db-connection-tool-names.ts";
import { isDbType } from "../../shared/db-types.ts";
import { sqliteRealPath } from "../database/sqlite-path-guard.ts";
import { dbConnectionCreateSummary } from "./assistant-approval-summary-db-connection.ts";
import {
  decorArgs, listConnections, nameProblem, passwordModeArg, targetArg, type DbConnectionToolDeps,
} from "./assistant-db-connection-lookup.ts";
import { dbConnectionEdit } from "./assistant-db-connection-edit-tool.ts";
import type { ToolContext } from "./assistant-tool-family.ts";
import { errorResult, jsonResult, notApprovedResult } from "./assistant-tool-output.ts";

/**
 * `db_connection_save`: add a connection, or (with `id`) change one. Everything is checked before
 * the card — a URL with a password in it is refused outright, a SQLite file is judged by its real
 * path — and again after the answer, since it can come much later. The route is the one the
 * connection form calls; it is never sent `readonly` or `aiAccess`, so a connection the Assistant
 * adds is read-only and available to the AI chat (the route's defaults), and only the user, in
 * PPM, makes one writable.
 */

export async function dbConnectionSave(ctx: ToolContext, args: Record<string, unknown>, deps: DbConnectionToolDeps): Promise<Json> {
  const list = await listConnections(ctx);
  if (typeof list === "string") return errorResult(list);
  if (args.id !== undefined) return dbConnectionEdit(ctx, args, deps, list);

  if (typeof args.name !== "string") return errorResult("`name` is required: what the connection is called in PPM.");
  const name = args.name.trim();
  const named = nameProblem(name, list);
  if (named) return errorResult(`Not added: ${named}`);
  if (!isDbType(args.type)) return errorResult("`type` must be postgres, mysql, mariadb or sqlite.");
  const type = args.type;
  const mode = passwordModeArg(args.passwordMode);
  if (typeof mode === "object") return errorResult(mode.error);
  if (mode && type === "sqlite") return errorResult("A SQLite file has no password: leave `passwordMode` out.");
  const target = targetArg(type, args, deps);
  if (typeof target === "string") return errorResult(`Not added: ${target}`);
  if (!target) return errorResult(type === "sqlite" ? "`file` is required for a SQLite connection." : "`url` is required for a server connection.");
  const decor = decorArgs(args);
  if (typeof decor === "string") return errorResult(decor);
  const passwordMode = mode ?? "save";

  const verdict = await ctx.ask({
    tool: DB_CONNECTION_SAVE_TOOL,
    input: { name, type, ...target.shown, ...(type === "sqlite" ? {} : { passwordMode }), ...decor },
    summary: dbConnectionCreateSummary({ name, type, passwordMode, ...target.shown, ...decor }),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(`add connection ${name}`, verdict);

  // The answer can come much later: the name may be taken, the file replaced by a link, since.
  const after = await listConnections(ctx);
  if (typeof after === "string") return errorResult(`Not added: ${after}`);
  const stale = nameProblem(name, after)
    ?? (target.path !== undefined && sqliteRealPath(target.path, deps.home) !== target.path ? `${target.path} changed while the card waited.` : null);
  if (stale) return errorResult(`Not added: ${stale} Nothing was saved; read db_list_connections and ask again.`);

  const connectionConfig = type === "sqlite"
    ? { type, path: target.path }
    : { type, connectionString: target.connectionString, ...(passwordMode === "ask" ? { passwordMode: "askPassword" } : {}) };
  const r = await ctx.callRoute<{ id: number; name: string; readonly: number; ai_access: number }>("POST", "/api/db/connections", {
    type, name, connectionConfig,
    ...(typeof decor.folder === "string" ? { groupName: decor.folder } : {}),
    ...(typeof decor.color === "string" ? { color: decor.color } : {}),
  });
  if (!r.ok || !r.data) return errorResult(`Not added: ${r.error ?? `PPM answered ${r.status}`}`);
  return jsonResult({
    outcome: "created", id: r.data.id, name: r.data.name, type, readonly: r.data.readonly !== 0, availableToAi: r.data.ai_access !== 0,
    ...(type !== "sqlite" && passwordMode === "save" ? { note: "No password is saved. If the database needs one, the user types it in PPM's connection form." } : {}),
  });
}
