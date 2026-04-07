import { Hono } from "hono";
import { sqliteService } from "../../services/sqlite.service.ts";
import { ok, err } from "../../types/api.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

export const sqliteRoutes = new Hono<Env>();

/** GET /sqlite/tables?path=relative/path.db */
sqliteRoutes.get("/tables", (c) => {
  try {
    const dbPath = c.req.query("path");
    if (!dbPath) return c.json(err("Missing query parameter: path"), 400);
    const tables = sqliteService.getTables(c.get("projectPath"), dbPath);
    return c.json(ok(tables));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /sqlite/schema?path=...&table=... */
sqliteRoutes.get("/schema", (c) => {
  try {
    const dbPath = c.req.query("path");
    const table = c.req.query("table");
    if (!dbPath || !table) return c.json(err("Missing query parameters: path, table"), 400);
    const schema = sqliteService.getTableSchema(c.get("projectPath"), dbPath, table);
    return c.json(ok(schema));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /sqlite/data?path=...&table=...&page=1&limit=100&orderBy=...&orderDir=ASC */
sqliteRoutes.get("/data", (c) => {
  try {
    const dbPath = c.req.query("path");
    const table = c.req.query("table");
    if (!dbPath || !table) return c.json(err("Missing query parameters: path, table"), 400);
    const page = parseInt(c.req.query("page") ?? "1", 10);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 1000);
    const orderBy = c.req.query("orderBy");
    const orderDir = c.req.query("orderDir") === "DESC" ? "DESC" : "ASC";
    const data = sqliteService.getTableData(c.get("projectPath"), dbPath, table, page, limit, orderBy, orderDir as "ASC" | "DESC");
    return c.json(ok(data));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /sqlite/query — body: { path, sql } */
sqliteRoutes.post("/query", async (c) => {
  try {
    const body = await c.req.json<{ path: string; sql: string }>();
    if (!body.path || !body.sql) return c.json(err("Missing required fields: path, sql"), 400);
    const result = sqliteService.executeQuery(c.get("projectPath"), body.path, body.sql);
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** PUT /sqlite/cell — body: { path, table, rowid, column, value } */
sqliteRoutes.put("/cell", async (c) => {
  try {
    const body = await c.req.json<{ path: string; table: string; rowid: number; column: string; value: unknown }>();
    if (!body.path || !body.table || body.rowid == null || !body.column) {
      return c.json(err("Missing required fields: path, table, rowid, column"), 400);
    }
    sqliteService.updateCell(c.get("projectPath"), body.path, body.table, body.rowid, body.column, body.value);
    return c.json(ok({ updated: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** DELETE /sqlite/row — body: { path, table, rowid } */
sqliteRoutes.delete("/row", async (c) => {
  try {
    const body = await c.req.json<{ path: string; table: string; rowid: number }>();
    if (!body.path || !body.table || body.rowid == null) {
      return c.json(err("Missing required fields: path, table, rowid"), 400);
    }
    sqliteService.deleteRow(c.get("projectPath"), body.path, body.table, body.rowid);
    return c.json(ok({ deleted: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
