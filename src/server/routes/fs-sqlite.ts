import { Hono } from "hono";
import { sqliteService } from "../../services/sqlite.service.ts";
import { detectOperation } from "../../services/query-audit/query-audit.service.ts";
import { logQuery, type AuditFields } from "./query-audit-hook.ts";
import {
  assertAllowed,
  assertNotPpmDir,
  resolvePath,
} from "../../services/fs-path-guard.service.ts";
import { fsErrorBody } from "../../services/fs-ops/fs-error-response.ts";
import { ok, err } from "../../types/api.ts";

/**
 * SQLite viewer for database files outside any project, so a `.db` opened from
 * the explorer behaves like one inside a project. Paths are absolute and pass
 * the same guard as every other filesystem route; the PPM directory stays out
 * of reach because it holds the credentials database.
 */
export const fsSqliteRoutes = new Hono();

/** Guard an absolute db path; the service is addressed with no project root. */
function guardDbPath(input: string): string {
  const resolved = resolvePath(input);
  assertAllowed(resolved);
  assertNotPpmDir(resolved);
  return resolved;
}

/** These routes address a database by file path, so there is no connection id. */
function fileAudit(dbPath: string): Pick<AuditFields, "connectionId" | "connectionName" | "dbType"> {
  return { connectionId: null, connectionName: dbPath, dbType: "sqlite" };
}

function fail(e: unknown) {
  return fsErrorBody(e);
}

/** GET /api/fs/sqlite/tables?path=/abs/file.db */
fsSqliteRoutes.get("/tables", (c) => {
  try {
    const path = c.req.query("path");
    if (!path) return c.json(err("Missing query parameter: path"), 400);
    return c.json(ok(sqliteService.getTables("", guardDbPath(path))));
  } catch (e) {
    const { body, status } = fail(e);
    return c.json(body, status);
  }
});

/** GET /api/fs/sqlite/schema?path=...&table=... */
fsSqliteRoutes.get("/schema", (c) => {
  try {
    const path = c.req.query("path");
    const table = c.req.query("table");
    if (!path || !table) return c.json(err("Missing query parameters: path, table"), 400);
    return c.json(ok(sqliteService.getTableSchema("", guardDbPath(path), table)));
  } catch (e) {
    const { body, status } = fail(e);
    return c.json(body, status);
  }
});

/** GET /api/fs/sqlite/data?path=...&table=...&page=1&limit=100&orderBy=...&orderDir=ASC */
fsSqliteRoutes.get("/data", (c) => {
  try {
    const path = c.req.query("path");
    const table = c.req.query("table");
    if (!path || !table) return c.json(err("Missing query parameters: path, table"), 400);
    const page = parseInt(c.req.query("page") ?? "1", 10);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 1000);
    const orderBy = c.req.query("orderBy");
    const orderDir = c.req.query("orderDir") === "DESC" ? "DESC" : "ASC";
    const data = sqliteService.getTableData(
      "", guardDbPath(path), table, page, limit, orderBy, orderDir as "ASC" | "DESC",
    );
    return c.json(ok(data));
  } catch (e) {
    const { body, status } = fail(e);
    return c.json(body, status);
  }
});

/** POST /api/fs/sqlite/query — body: { path, sql } */
fsSqliteRoutes.post("/query", async (c) => {
  const startedAt = Date.now();
  try {
    const body = await c.req.json<{ path?: string; sql?: string }>();
    if (!body.path || !body.sql) return c.json(err("Missing required fields: path, sql"), 400);
    const dbPath = guardDbPath(body.path);

    const audit = {
      ...fileAudit(dbPath),
      source: "editor" as const,
      operation: detectOperation(body.sql),
      sql: body.sql,
    };

    try {
      const result = sqliteService.executeQuery("", dbPath, body.sql);
      logQuery(c, {
        ...audit,
        status: "ok",
        rows: result.rows,
        rowCount: result.changeType === "select" ? result.rows.length : result.rowsAffected,
        durationMs: Date.now() - startedAt,
      });
      return c.json(ok(result));
    } catch (e) {
      logQuery(c, { ...audit, status: "error", error: (e as Error).message, durationMs: Date.now() - startedAt });
      throw e;
    }
  } catch (e) {
    const { body, status } = fail(e);
    return c.json(body, status);
  }
});
