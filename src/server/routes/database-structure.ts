/**
 * What a database holds: `GET /connections/:id/objects` lists every table,
 * view, function and the rest by schema for the object tree,
 * `GET /connections/:id/columns` every column (what searching the tree by column
 * reads), and `GET /connections/:id/structure?table=&schema=` describes one
 * table in full — columns, keys both ways, indexes and constraints — and
 * `GET /connections/:id/object-sql?kind=&name=` the scripts of the SQL tab. All
 * of them take `?database=` for one of the server's other databases, which
 * `GET /connections/:id/databases` lists.
 *
 * Changing it: `POST /connections/:id/structure/preview` turns a change — the
 * table editor's Save, New table, or one of the tree's table commands — into
 * the script the Save changes dialog shows, and `POST …/structure/apply` runs
 * that script and writes one audit entry for it.
 */
import { Hono, type Context } from "hono";
import { defaultSchemaFor } from "../../services/database/grid.service.ts";
import { READONLY_STRUCTURE, isReadonlyRefusal } from "../../services/database/db-errors.ts";
import { dialectFor } from "../../services/database/dialects.ts";
import { DdlApplyError, ddlScript, type DdlPlan } from "../../services/database/ddl/ddl-types.ts";
import { insertScript, selectScript } from "../../services/database/object-scripts.ts";
import { StructureRequestError, parseStructureApply } from "../../services/database/structure-change-request.ts";
import { prepareStructureChange, structurePreview, type PreparedStructureChange } from "../../services/database/structure-edit.service.ts";
import { detectOperation, type QueryOperation } from "../../services/query-audit/query-audit.service.ts";
import type { ConnectionRow } from "../../services/db.service.ts";
import type { GridTarget } from "../../services/database/grid.service.ts";
import type { DbObjectKind, DbObjectRef, DbObjectScripts } from "../../shared/db-structure.ts";
import type {
  StructureApplyRequest, StructureApplyResult, StructureChange, StructureFailure,
} from "../../shared/db-structure-change.ts";
import { ok, err } from "../../types/api.ts";
import { logQuery } from "./query-audit-hook.ts";
import {
  connAudit, connTarget, connTimeoutMs, databaseParam, requestDatabase, resolveTargetConn, withTimeout,
} from "./database-route-helpers.ts";

export const databaseStructureRoutes = new Hono();

/** A catalog read that has not answered by now is a connection that will not. */
const STRUCTURE_TIMEOUT_MS = 30_000;

/** GET /connections/:id/databases — the server's databases, for the tree under a server connection */
databaseStructureRoutes.get("/:id/databases", async (c) => {
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  try {
    const { adapter, config } = connTarget(conn);
    return c.json(ok(await withTimeout(adapter.listDatabases(config), connTimeoutMs(config, STRUCTURE_TIMEOUT_MS))));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /connections/:id/objects */
databaseStructureRoutes.get("/:id/objects", async (c) => {
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  try {
    const { adapter, config } = connTarget(conn, requestDatabase(c));
    return c.json(ok(await withTimeout(adapter.listObjects(config), connTimeoutMs(config, STRUCTURE_TIMEOUT_MS))));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /connections/:id/columns — every column of every table and view, for searching the tree by column */
databaseStructureRoutes.get("/:id/columns", async (c) => {
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  try {
    const { adapter, config } = connTarget(conn, requestDatabase(c));
    return c.json(ok(await withTimeout(adapter.listColumns(config), connTimeoutMs(config, STRUCTURE_TIMEOUT_MS))));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /connections/:id/structure?table=...&schema=... */
databaseStructureRoutes.get("/:id/structure", async (c) => {
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const table = c.req.query("table");
  if (!table) return c.json(err("table query param required"), 400);
  const schema = c.req.query("schema") || defaultSchemaFor(conn.type);
  try {
    const { adapter, config } = connTarget(conn, requestDatabase(c));
    const structure = await withTimeout(adapter.getStructure(config, table, schema ?? undefined), connTimeoutMs(config, STRUCTURE_TIMEOUT_MS));
    if (!structure) return c.json(err(schema ? `Table "${schema}.${table}" not found` : `Table "${table}" not found`), 404);
    return c.json(ok(structure));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

const OBJECT_KINDS = new Set<DbObjectKind>(["table", "view", "matview", "function", "procedure", "trigger", "sequence"]);
const RELATION_KINDS = new Set<DbObjectKind>(["table", "view", "matview"]);

/**
 * GET /connections/:id/object-sql?kind=&name=&schema=&args=&table= — the object's CREATE, and for
 * a table or view the SELECT (a table also the INSERT) a Query tab starts from, with the kind the
 * object really is — asked for as a table, a view answers as one. `args` picks one overload of a
 * routine; `table` says which table a trigger belongs to.
 */
databaseStructureRoutes.get("/:id/object-sql", async (c) => {
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const kind = c.req.query("kind") as DbObjectKind | undefined;
  const name = c.req.query("name");
  if (!name || !kind || !OBJECT_KINDS.has(kind)) return c.json(err("kind and name query params required"), 400);
  const schema = c.req.query("schema") || defaultSchemaFor(conn.type);
  const args = c.req.query("args");
  const table = c.req.query("table");
  try {
    const { adapter, config } = connTarget(conn, requestDatabase(c));
    const timeout = connTimeoutMs(config, STRUCTURE_TIMEOUT_MS);
    // A tab opened on a name from the table cache or a foreign key does not know whether it is a
    // table or a view; the catalog does, and the three share one namespace.
    const relation = RELATION_KINDS.has(kind) ? await withTimeout(adapter.getStructure(config, name, schema ?? undefined), timeout) : null;
    const actual: DbObjectKind = relation ? (relation.kind === "foreign" ? "table" : relation.kind) : kind;
    const ref: DbObjectRef = { schema, name, kind: actual, ...(args !== undefined ? { args } : {}), ...(table ? { table } : {}) };
    const create = await withTimeout(adapter.getObjectSql(config, ref), timeout);
    if (create === null) return c.json(err(`${schema ? `${schema}.` : ""}${name} not found`), 404);
    const scripts: DbObjectScripts = { kind: actual, create };
    if (relation) {
      const dialect = dialectFor(conn.type);
      scripts.select = selectScript(dialect, relation);
      if (actual === "table") scripts.insert = insertScript(dialect, relation);
    }
    return c.json(ok(scripts));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

async function readStructureRequest(c: Context): Promise<StructureApplyRequest | Response> {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json(err("Request body must be JSON"), 400); }
  try {
    return parseStructureApply(body);
  } catch (e) {
    if (e instanceof StructureRequestError) return c.json(err(e.message), e.status);
    throw e;
  }
}

/** The table a change is about, from the change itself: the audit log names it even when nothing could be planned. */
function changeTarget(change: StructureChange): { schema: string | null; table: string } {
  if (change.kind === "alter") return { schema: change.base.schema, table: change.base.name };
  if (change.kind === "create") return { schema: change.current.schema, table: change.current.name };
  return { schema: change.schema, table: change.table };
}

function changeParams(c: Context, change: StructureChange): Record<string, unknown> {
  return {
    ...databaseParam(c),
    kind: change.kind,
    ...changeTarget(change),
    ...("column" in change ? { column: change.column } : {}),
    ...("newName" in change ? { newName: change.newName } : {}),
  };
}

/** One statement is logged as what it is; a script as a script. */
function planOperation(plan: DdlPlan): QueryOperation {
  const run = plan.statements.filter((s) => !s.phase && !s.check && !s.sql.startsWith("--"));
  return run.length === 1 ? detectOperation(run[0]!.sql) : "script";
}

/** The script a refused change would have run, for the audit log; planned from the request's names when the catalog cannot be read. */
async function attemptedScript(target: GridTarget, change: StructureChange): Promise<{ sql: string; operation: QueryOperation }> {
  try {
    const prepared = await prepareStructureChange(target, change);
    if (prepared.plan.statements.length > 0) return { sql: ddlScript(prepared.plan.statements), operation: planOperation(prepared.plan) };
  } catch { /* described from the request below */ }
  const { schema, table } = changeTarget(change);
  return { sql: `-- ${change.kind} ${schema ? `${schema}.` : ""}${table}`, operation: "other" };
}

function prepareFailure(c: Context, e: unknown): Response {
  if (e instanceof StructureRequestError) return c.json(err(e.message), e.status);
  return c.json(err((e as Error).message), 500);
}

/** What the Save dialog says about a script that stopped, and which statement it points at. */
function describeFailure(e: DdlApplyError, prepared: PreparedStructureChange): { message: string; data: StructureFailure } {
  const total = prepared.plan.statements.length;
  const data: StructureFailure = { statement: e.statement, index: e.index, applied: e.applied, total };
  if (e.index < 0) return { message: `The commit failed: ${e.message}. Nothing was saved.`, data };
  const failed = `Statement ${e.index + 1} of ${total} failed: ${e.message}.`;
  if (prepared.dialect !== "mysql") return { message: `${failed} Nothing was saved.`, data };
  const after = total - e.index - 1;
  const done = e.applied === 0
    ? "Nothing before it ran"
    : `${e.applied === 1 ? "The statement before it stays" : `The ${e.applied} statements before it stay`} applied, since MySQL commits each DDL statement`;
  return { message: `${failed} ${done}; ${after === 0 ? "it was the last one" : `the ${after === 1 ? "one" : after} after it did not run`}.`, data };
}

/**
 * A rebuild or an ALTER that rewrites a big table runs for as long as it takes, and Bun.serve
 * closes a request that has sent nothing for 10 s — the browser would then report a failure for
 * a script still running. The route runs with no idle timeout (`c.env` is the server).
 */
function keepRequestOpen(c: Context): void {
  (c.env as { timeout?: (req: Request, seconds: number) => void } | undefined)?.timeout?.(c.req.raw, 0);
}

/** POST /connections/:id/structure/preview — the script a change turns into, as the Save changes dialog shows it. */
databaseStructureRoutes.post("/:id/structure/preview", async (c) => {
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  if (conn.readonly) return c.json(err(READONLY_STRUCTURE), 403);
  const request = await readStructureRequest(c);
  if (request instanceof Response) return request;
  try {
    const target = connTarget(conn, requestDatabase(c));
    const prepared = await withTimeout(prepareStructureChange(target, request.change), connTimeoutMs(target.config, STRUCTURE_TIMEOUT_MS));
    return c.json(ok(structurePreview(prepared)));
  } catch (e) {
    return prepareFailure(c, e);
  }
});

/**
 * POST /connections/:id/structure/apply — run the script: in one transaction on Postgres and
 * SQLite, statement by statement on MySQL. `sql`, the script the dialog showed, must still be the
 * script the change turns into; a rebuild runs only with `allowRecreate`.
 */
databaseStructureRoutes.post("/:id/structure/apply", async (c) => {
  const startedAt = Date.now();
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const request = await readStructureRequest(c);
  if (request instanceof Response) return request;
  const params = changeParams(c, request.change);

  if (conn.readonly) {
    await refuseReadonly(c, conn, request.change, params, startedAt);
    return c.json(err(READONLY_STRUCTURE), 403);
  }

  const target = connTarget(conn, requestDatabase(c));
  let prepared: PreparedStructureChange;
  try {
    prepared = await withTimeout(prepareStructureChange(target, request.change), connTimeoutMs(target.config, STRUCTURE_TIMEOUT_MS));
  } catch (e) {
    return prepareFailure(c, e);
  }
  const preview = structurePreview(prepared);
  if (request.sql !== undefined && request.sql !== preview.sql) {
    return c.json({ ...err("The table has changed since this script was made. Review the new script and save again."), data: preview }, 409);
  }
  if (prepared.plan.recreate && !request.allowRecreate) {
    return c.json(err("This change rebuilds the table. Tick Allow recreate to run it."), 400);
  }
  if (prepared.plan.statements.length === 0) return c.json(ok<StructureApplyResult>({ executionTimeMs: 0 }));

  keepRequestOpen(c);
  const audit = {
    ...connAudit(conn), source: "structure" as const, operation: planOperation(prepared.plan), sql: preview.sql,
    params: prepared.plan.recreate ? { ...params, recreate: true } : params,
  };
  const ranAt = Date.now();
  try {
    await target.adapter.applyDdl(target.config, prepared.plan);
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    const described = e instanceof DdlApplyError ? describeFailure(e, prepared) : null;
    const message = described?.message ?? (e as Error).message;
    // The database refusing DDL as read-only (a standby, a READ ONLY default) is a refusal like PPM's own.
    const readonly = isReadonlyRefusal(e) || isReadonlyRefusal((e as Error).cause);
    logQuery(c, { ...audit, status: readonly ? "blocked" : "error", error: message, durationMs });
    const status = readonly ? 403 : described ? 400 : 500;
    return c.json({ ...err(message), ...(described ? { data: described.data } : {}) }, status);
  }
  const executionTimeMs = Date.now() - ranAt;
  logQuery(c, { ...audit, status: "ok", durationMs: Date.now() - startedAt });
  return c.json(ok<StructureApplyResult>({ executionTimeMs }));
});

async function refuseReadonly(c: Context, conn: ConnectionRow, change: StructureChange, params: Record<string, unknown>, startedAt: number): Promise<void> {
  let attempted: { sql: string; operation: QueryOperation };
  try {
    attempted = await withTimeout(attemptedScript(connTarget(conn, requestDatabase(c)), change), STRUCTURE_TIMEOUT_MS);
  } catch {
    const { schema, table } = changeTarget(change);
    attempted = { sql: `-- ${change.kind} ${schema ? `${schema}.` : ""}${table}`, operation: "other" };
  }
  logQuery(c, {
    ...connAudit(conn), source: "structure", operation: attempted.operation, sql: attempted.sql, params,
    status: "blocked", error: READONLY_STRUCTURE, durationMs: Date.now() - startedAt,
  });
}
