import type { Json } from "../mcp-http-endpoint.ts";
import {
  DB_CONNECTION_DELETE_TOOL, DB_CONNECTION_SAVE_TOOL, DB_CONNECTION_TEST_TOOL,
} from "../../shared/assistant-db-connection-tool-names.ts";
import { isAssistantProject } from "../../shared/assistant-project.ts";
import { projectService } from "../project.service.ts";
import { dbConnectionDeleteSummary } from "./assistant-approval-summary-db-connection.ts";
import {
  availableConnection, connectionPath, listConnections, readEditable, type DbConnectionToolDeps,
} from "./assistant-db-connection-lookup.ts";
import { dbConnectionSave } from "./assistant-db-connection-save-tool.ts";
import { allowRoute, type RouteRule } from "./assistant-route-rules.ts";
import type { FamilyHandler, FamilyHandlers, ToolContext } from "./assistant-tool-family.ts";
import { errorResult, jsonResult, notApprovedResult } from "./assistant-tool-output.ts";

/**
 * The connection tools' handlers and the only routes they may call: the list, one connection's
 * password-free config, create, edit, delete and the saved connection's Test — never the export
 * that carries every password, the data routes or the AI chat's write approvals (see
 * `assistant-route-call.ts`, which keeps the rest of the database router out of reach). The routes
 * announce `db:connections_changed` themselves, so every open PPM shows the change at once.
 */
export const DB_CONNECTION_ROUTES: readonly RouteRule[] = [
  allowRoute("GET", "/api/db/connections"),
  allowRoute("GET", "/api/db/connections/:id/config"),
  allowRoute("POST", "/api/db/connections"),
  allowRoute("PUT", "/api/db/connections/:id"),
  allowRoute("DELETE", "/api/db/connections/:id"),
  allowRoute("POST", "/api/db/connections/:id/test"),
];

/** How many tests one chat may run a minute: a test dials out, so it is not a port scanner. */
export const MAX_TESTS_PER_MINUTE = 10;
const MINUTE_MS = 60_000;

export const realDbConnectionToolDeps: DbConnectionToolDeps = {
  projectRoots: () => projectService.list().filter((p) => !isAssistantProject(p.name)).map((p) => p.path),
};

async function dbConnectionDelete(ctx: ToolContext, args: Record<string, unknown>): Promise<Json> {
  const list = await listConnections(ctx);
  if (typeof list === "string") return errorResult(list);
  const found = availableConnection(list, args.id);
  if (!found.ok) return errorResult(found.error);
  const { conn } = found;

  const verdict = await ctx.ask({
    tool: DB_CONNECTION_DELETE_TOOL,
    input: { id: conn.id, name: conn.name, type: conn.type },
    summary: dbConnectionDeleteSummary(conn),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(`delete connection ${conn.name}`, verdict);

  // The answer can come much later: the id may name another connection by then.
  const after = await listConnections(ctx);
  if (typeof after === "string") return errorResult(`Not deleted: ${after}`);
  const still = availableConnection(after, conn.id);
  if (!still.ok || still.conn.name !== conn.name || still.conn.type !== conn.type) {
    return errorResult(`Not deleted: connection #${conn.id} was renamed, changed or removed while the card waited. Read db_list_connections and ask again.`);
  }
  const r = await ctx.callRoute("DELETE", connectionPath(conn.id));
  if (!r.ok) return errorResult(`Not deleted: ${r.error ?? `PPM answered ${r.status}`}`);
  return jsonResult({ outcome: "deleted", id: conn.id, name: conn.name, type: conn.type });
}

/** Tests a chat ran in the last minute, by session. */
export function createTestLimiter(now: () => number = Date.now) {
  const runs = new Map<string, number[]>();
  return (sessionId: string): boolean => {
    const t = now();
    const recent = (runs.get(sessionId) ?? []).filter((at) => t - at < MINUTE_MS);
    if (recent.length >= MAX_TESTS_PER_MINUTE) {
      runs.set(sessionId, recent);
      return false;
    }
    runs.set(sessionId, [...recent, t]);
    return true;
  };
}

async function dbConnectionTest(ctx: ToolContext, args: Record<string, unknown>, take: (sessionId: string) => boolean): Promise<Json> {
  const list = await listConnections(ctx);
  if (typeof list === "string") return errorResult(list);
  const found = availableConnection(list, args.id);
  if (!found.ok) return errorResult(found.error);
  const { conn } = found;
  if (conn.password_mode && conn.password_mode !== "save" && !conn.logged_in) {
    return errorResult(`Not tested: "${conn.name}" asks for its password each time it opens, and nobody is logged in to it. The user opens it in PPM first.`);
  }
  const editable = await readEditable(ctx, conn.id);
  if (typeof editable === "string") return errorResult(editable);
  if (!take(ctx.sessionId)) return errorResult(`Not tested: at most ${MAX_TESTS_PER_MINUTE} connection tests a minute from one chat. Wait a minute.`);

  const r = await ctx.callRoute<{ ok: boolean; error?: string }>("POST", connectionPath(conn.id, "/test"), {});
  if (!r.ok || !r.data) return errorResult(`Not tested: ${r.error ?? `PPM answered ${r.status}`}`);
  // Where the test went, so the user can see a test was not aimed somewhere they did not expect.
  const ssh = editable.type !== "sqlite" && editable.ssh?.enabled ? `${editable.ssh.host}:${editable.ssh.port ?? 22}` : null;
  return jsonResult({
    connection: conn.name, type: conn.type, ok: r.data.ok,
    ...(r.data.error ? { error: r.data.error } : {}),
    ...(conn.type !== "sqlite" && conn.server ? { host: conn.server } : {}),
    ...(ssh ? { throughSsh: ssh } : {}),
  });
}

type DepsHandler = (ctx: ToolContext, args: Record<string, unknown>) => Promise<Json>;

/** A handler answering an unexpected failure as a tool error rather than a 500. */
const guard = (run: DepsHandler): FamilyHandler => async (ctx, args) => {
  try {
    return await run(ctx, args);
  } catch (e) {
    return errorResult(`The connection tool failed: ${(e as Error).message}. Nothing more was done.`);
  }
};

/** The handlers over given dependencies; tests pass their own. */
export function createDbConnectionToolHandlers(deps: DbConnectionToolDeps = realDbConnectionToolDeps): FamilyHandlers {
  const take = createTestLimiter(deps.now);
  return {
    [DB_CONNECTION_SAVE_TOOL]: guard((ctx, args) => dbConnectionSave(ctx, args, deps)),
    [DB_CONNECTION_DELETE_TOOL]: guard(dbConnectionDelete),
    [DB_CONNECTION_TEST_TOOL]: guard((ctx, args) => dbConnectionTest(ctx, args, take)),
  };
}

export const DB_CONNECTION_TOOL_HANDLERS: FamilyHandlers = createDbConnectionToolHandlers();
