import type { Json } from "../mcp-http-endpoint.ts";
import { DB_CONNECTION_SAVE_TOOL } from "../../shared/assistant-db-connection-tool-names.ts";
import { editableFormSettings, type EditableConnectionConfig } from "../../shared/db-connection-config.ts";
import { redactUrl } from "../../shared/db-url-secret.ts";
import { urlEndpoint } from "../database/connection-endpoint-reset.ts";
import { sqliteRealPath } from "../database/sqlite-path-guard.ts";
import { dbConnectionEditSummary, type DbConnectionTarget } from "./assistant-approval-summary-db-connection.ts";
import {
  availableConnection, connectionPath, decorArgs, listConnections, nameProblem, passwordModeArg, readEditable, targetArg,
  type DbConnectionToolDeps, type Listed,
} from "./assistant-db-connection-lookup.ts";
import type { ToolContext } from "./assistant-tool-family.ts";
import { errorResult, jsonResult, notApprovedResult } from "./assistant-tool-output.ts";

/**
 * `db_connection_save` with an `id`: change a connection the user made available to the AI chat.
 * Pointing one that has a saved secret somewhere else is refused before the card — the password
 * belongs to where it was typed, and only the user types it again, in PPM. Whatever else the
 * connection form set (password mode, allowed databases, tunnel, certificates) is sent back as it
 * was, so changing a URL does not quietly reset the rest.
 */

type ServerEditable = Extract<EditableConnectionConfig, { hasPassword: boolean }>;

const hasSavedSecret = (e: ServerEditable): boolean =>
  e.hasPassword || !!e.ssh?.hasPassword || !!e.ssh?.hasPassphrase || !!e.ssl?.hasKeyPassword;

const askMode = (e: ServerEditable): boolean => e.passwordMode === "askPassword" || e.passwordMode === "askUser";

export async function dbConnectionEdit(ctx: ToolContext, args: Record<string, unknown>, deps: DbConnectionToolDeps, list: Listed[]): Promise<Json> {
  const found = availableConnection(list, args.id);
  if (!found.ok) return errorResult(found.error);
  const { conn } = found;
  if (args.type !== undefined && args.type !== conn.type) return errorResult(`"${conn.name}" is a ${conn.type} connection; a connection keeps its type.`);
  const editable = await readEditable(ctx, conn.id);
  if (typeof editable === "string") return errorResult(editable);

  let newName: string | undefined;
  if (args.name !== undefined) {
    if (typeof args.name !== "string") return errorResult("`name`, when given, must be text.");
    const name = args.name.trim();
    const problem = name === conn.name ? null : nameProblem(name, list, conn.id);
    if (problem) return errorResult(`Not changed: ${problem}`);
    if (name !== conn.name) newName = name;
  }
  const mode = passwordModeArg(args.passwordMode);
  if (typeof mode === "object") return errorResult(mode.error);
  if (mode && conn.type === "sqlite") return errorResult("A SQLite file has no password: leave `passwordMode` out.");
  const target = targetArg(editable.type, args, deps);
  if (typeof target === "string") return errorResult(`Not changed: ${target}`);
  const decor = decorArgs(args);
  if (typeof decor === "string") return errorResult(decor);

  let now: DbConnectionTarget | undefined;
  let next = target ?? undefined;
  let modeChange: "save" | "ask" | undefined;
  if (editable.type === "sqlite") {
    now = { file: sqliteRealPath(editable.path, deps.home) };
    if (next && next.path === now.file) next = undefined;
  } else {
    now = editable.connectionString === null ? { url: "(a URL PPM cannot read)" } : { url: editable.connectionString };
    if (next && next.connectionString === editable.connectionString) next = undefined;
    if (next && urlEndpoint(next.connectionString) !== urlEndpoint(editable.connectionString) && hasSavedSecret(editable)) {
      return errorResult(`Not changed: "${conn.name}" has a saved password, and this URL points it at another server or login. `
        + "The password belongs to where it was typed: the user changes the server and re-enters the password in PPM.");
    }
    if (mode && (mode === "ask") !== askMode(editable)) modeChange = mode;
  }
  const folder = decor.folder !== undefined && decor.folder !== (conn.group_name ?? null) ? decor.folder : undefined;
  const color = decor.color !== undefined && decor.color !== (conn.color ?? null) ? decor.color : undefined;
  if (!newName && !next && !modeChange && folder === undefined && color === undefined) {
    return errorResult("Nothing to change: the connection already has these settings.");
  }

  const verdict = await ctx.ask({
    tool: DB_CONNECTION_SAVE_TOOL,
    input: { id: conn.id, ...(newName ? { name: newName } : {}), ...(next?.shown ?? {}), ...(modeChange ? { passwordMode: modeChange } : {}), ...(folder !== undefined ? { group: folder } : {}), ...(color !== undefined ? { color } : {}) },
    summary: dbConnectionEditSummary({ conn, newName, ...(next ? { now, next: next.shown } : {}), passwordMode: modeChange, folder, color }),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(`change connection ${conn.name}`, verdict);

  // The answer can come much later: the connection may have been changed, renamed or hidden since.
  const after = await listConnections(ctx);
  if (typeof after === "string") return errorResult(`Not changed: ${after}`);
  const still = availableConnection(after, conn.id);
  const editableNow = await readEditable(ctx, conn.id);
  const stale = !still.ok || still.conn.name !== conn.name || still.conn.type !== conn.type || JSON.stringify(editableNow) !== JSON.stringify(editable)
    || (newName !== undefined && nameProblem(newName, after, conn.id) !== null)
    || (next?.path !== undefined && sqliteRealPath(next.path, deps.home) !== next.path);
  if (stale) return errorResult(`Not changed: "${conn.name}" changed while the card waited. Nothing was saved; read db_list_connections and ask again.`);

  let connectionConfig: Record<string, unknown> | undefined;
  if (editable.type === "sqlite") {
    if (next?.path) connectionConfig = { type: "sqlite", path: next.path };
  } else if (next || modeChange) {
    const passwordMode = modeChange === undefined ? undefined : modeChange === "save" ? "save" : "askPassword";
    connectionConfig = {
      ...editableFormSettings(editable), type: editable.type, keepPassword: true,
      ...(next?.connectionString ? { connectionString: next.connectionString } : {}),
      ...(passwordMode ? { passwordMode } : {}),
    };
  }
  const r = await ctx.callRoute<{ name: string; secretsCleared?: string[] }>("PUT", connectionPath(conn.id), {
    ...(newName ? { name: newName } : {}),
    ...(folder !== undefined ? { groupName: folder } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(connectionConfig ? { connectionConfig } : {}),
  });
  if (!r.ok) return errorResult(`Not changed: ${r.error ?? `PPM answered ${r.status}`}`);
  return jsonResult({
    outcome: "updated", id: conn.id, name: r.data?.name ?? newName ?? conn.name,
    ...(next?.shown.url ? { url: redactUrl(next.shown.url) } : {}), ...(next?.shown.file ? { file: next.shown.file } : {}),
    ...(r.data?.secretsCleared?.length ? { secretsCleared: r.data.secretsCleared, note: "The user types these again in PPM's connection form." } : {}),
  });
}
