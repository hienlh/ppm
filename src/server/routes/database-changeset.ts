/**
 * Saving grid edits. `POST /connections/:id/changeset/preview` answers the
 * script the Save dialog shows, plus the tables still pointing at rows about to
 * be deleted; `POST /connections/:id/changeset/apply` runs the changeset in one
 * transaction and writes one audit entry for it.
 */
import { Hono, type Context } from "hono";
import type { ConnectionRow } from "../../services/db.service.ts";
import {
  ChangesetRequestError, ChangesetStatementError, buildChangeset, changesetScript, describeFailure, parseChangeset,
  type ChangesetTable, type ValidChangeset,
} from "../../services/database/changeset.ts";
import {
  changesetOperation, prepareChangeset, previewOf, runChangeset, type PreparedChangeset,
} from "../../services/database/changeset.service.ts";
import { isReadonlyRefusal } from "../../services/database/db-errors.ts";
import { dialectFor } from "../../services/database/dialects.ts";
import { GridTableNotFoundError, defaultSchemaFor, type GridTarget } from "../../services/database/grid.service.ts";
import type { ChangesetApplyResult, ChangesetFailure } from "../../shared/db-changeset.ts";
import { ok, err } from "../../types/api.ts";
import { logQuery, type AuditFields } from "./query-audit-hook.ts";
import { connAudit, connTarget, databaseParam, holdRequestOpen, requestDatabase, resolveTargetConn } from "./database-route-helpers.ts";

export const databaseChangesetRoutes = new Hono();

export const READONLY_SAVE = "Connection is readonly — saving changes is disabled. Change this in PPM web UI.";

async function readChangeset(c: Context, conn: ConnectionRow): Promise<ValidChangeset | Response> {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json(err("Request body must be JSON"), 400); }
  try {
    return parseChangeset(body, defaultSchemaFor(conn.type));
  } catch (e) {
    if (e instanceof ChangesetRequestError) return c.json(err(e.message), 400);
    throw e;
  }
}

/** Status for a changeset that could not be built: a bad request, a missing table, or a failure reading the catalog. */
export function requestErrorStatus(e: unknown): 400 | 404 | 500 {
  if (e instanceof ChangesetRequestError) return 400;
  if (e instanceof GridTableNotFoundError) return 404;
  return 500;
}

/**
 * The script a refused save would have run, for the audit log. When the
 * catalog cannot be read (the file is missing, the table does not exist) the
 * statements are written from the names the request gives: that is still
 * what was attempted.
 */
export async function attemptedScript(conn: ConnectionRow, cs: ValidChangeset, database?: string): Promise<string> {
  try {
    return changesetScript((await prepareChangeset(connTarget(conn, database), cs)).statements);
  } catch { /* written from the request below */ }
  const names = new Set([
    ...cs.inserts.flatMap((row) => Object.keys(row)),
    ...cs.updates.flatMap((u) => [...Object.keys(u.key), ...Object.keys(u.set)]),
    ...cs.deletes.flatMap((x) => Object.keys(x.key)),
  ]);
  const table: ChangesetTable = {
    schema: cs.schema,
    name: cs.table,
    columns: [...names].map((name) => ({ name, type: "", kind: "other" as const })),
    rowidAliases: [],
  };
  try {
    return changesetScript(buildChangeset(dialectFor(conn.type), table, { ...cs, cascade: [] }).statements);
  } catch {
    const n = cs.inserts.length + cs.updates.length + cs.deletes.length;
    return `-- ${n} change(s) to ${dialectFor(conn.type).qualify(cs.table, cs.schema)}`;
  }
}

export type ChangesetOutcome =
  | { ok: true; result: ChangesetApplyResult }
  | { ok: false; status: 400 | 403 | 409 | 500; message: string; failure?: ChangesetFailure };

/**
 * Run a prepared changeset and log it as one entry. The routes that still
 * edit one cell or one row at a time come through here too, with their own
 * audit fields, so every write from the grid is audited the same way.
 */
export async function applyAndAudit(
  c: Context,
  target: GridTarget,
  prepared: PreparedChangeset,
  audit: Omit<AuditFields, "status">,
  startedAt: number,
): Promise<ChangesetOutcome> {
  try {
    const result = await runChangeset(target, prepared);
    const rowCount = result.inserted + result.updated + result.deleted + result.cascaded;
    logQuery(c, { ...audit, status: "ok", rowCount, durationMs: Date.now() - startedAt });
    return { ok: true, result };
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    const statementError = e instanceof ChangesetStatementError ? e : null;
    const described = statementError ? describeFailure(statementError, prepared.statements) : null;
    const message = described?.message ?? (e as Error).message;
    // The database refusing a write as read-only (a standby, a READ ONLY
    // default) is a refusal like PPM's own, whichever statement hit it.
    if (isReadonlyRefusal(e) || isReadonlyRefusal(statementError?.dbError)) {
      logQuery(c, { ...audit, status: "blocked", error: message, durationMs });
      return { ok: false, status: 403, message, failure: described?.data };
    }
    logQuery(c, { ...audit, status: "error", error: message, durationMs });
    if (!described) return { ok: false, status: 500, message };
    return { ok: false, status: statementError!.affected !== undefined ? 409 : 400, message, failure: described.data };
  }
}

/** The response for a failed outcome: the message, and where the Save dialog should point. */
export function failureResponse(c: Context, outcome: Extract<ChangesetOutcome, { ok: false }>): Response {
  return c.json({ ...err(outcome.message), ...(outcome.failure ? { data: outcome.failure } : {}) }, outcome.status);
}

/** POST /connections/:id/changeset/preview — the script, and the tables pointing at deleted rows. */
databaseChangesetRoutes.post("/:id/changeset/preview", async (c) => {
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const cs = await readChangeset(c, conn);
  if (cs instanceof Response) return cs;
  try {
    return c.json(ok(previewOf(await prepareChangeset(connTarget(conn, requestDatabase(c)), cs))));
  } catch (e) {
    return c.json(err((e as Error).message), requestErrorStatus(e));
  }
});

/** POST /connections/:id/changeset/apply — every statement in one transaction, or none. */
databaseChangesetRoutes.post("/:id/changeset/apply", async (c) => {
  const startedAt = Date.now();
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const cs = await readChangeset(c, conn);
  if (cs instanceof Response) return cs;
  const database = requestDatabase(c);
  const params = {
    ...databaseParam(c),
    table: cs.table,
    schema: cs.schema,
    inserts: cs.inserts.length,
    updates: cs.updates.length,
    deletes: cs.deletes.length,
    ...(cs.cascade.length > 0 ? { cascade: cs.cascade } : {}),
  };

  if (conn.readonly) {
    logQuery(c, {
      ...connAudit(conn), source: "grid", operation: changesetOperation(cs), params,
      sql: await attemptedScript(conn, cs, database), status: "blocked", error: READONLY_SAVE, durationMs: Date.now() - startedAt,
    });
    return c.json(err(READONLY_SAVE), 403);
  }

  const target = connTarget(conn, database);
  let prepared: PreparedChangeset;
  try {
    prepared = await prepareChangeset(target, cs);
  } catch (e) {
    return c.json(err((e as Error).message), requestErrorStatus(e));
  }
  if (prepared.statements.length === 0) {
    return c.json(ok<ChangesetApplyResult>({ inserted: 0, updated: 0, deleted: 0, cascaded: 0, executionTimeMs: 0 }));
  }

  // A save that waits on a lock sends nothing until the lock is let go.
  holdRequestOpen(c, 0);
  const outcome = await applyAndAudit(c, target, prepared, {
    ...connAudit(conn),
    source: "grid",
    operation: changesetOperation(cs),
    sql: changesetScript(prepared.statements),
    params,
  }, startedAt);
  return outcome.ok ? c.json(ok(outcome.result)) : failureResponse(c, outcome);
});
