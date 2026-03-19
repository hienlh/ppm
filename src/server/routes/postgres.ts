import { Hono } from "hono";
import { postgresService } from "../../services/postgres.service.ts";
import { ok, err } from "../../types/api.ts";

export const postgresRoutes = new Hono();

/** POST /postgres/test — body: { connectionString } */
postgresRoutes.post("/test", async (c) => {
  try {
    const body = await c.req.json<{ connectionString: string }>();
    if (!body.connectionString) return c.json(err("Missing connectionString"), 400);
    const result = await postgresService.testConnection(body.connectionString);
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /postgres/tables — body: { connectionString } */
postgresRoutes.post("/tables", async (c) => {
  try {
    const body = await c.req.json<{ connectionString: string }>();
    if (!body.connectionString) return c.json(err("Missing connectionString"), 400);
    const tables = await postgresService.getTables(body.connectionString);
    return c.json(ok(tables));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /postgres/schema — body: { connectionString, table, schema? } */
postgresRoutes.post("/schema", async (c) => {
  try {
    const body = await c.req.json<{ connectionString: string; table: string; schema?: string }>();
    if (!body.connectionString || !body.table) return c.json(err("Missing connectionString or table"), 400);
    const schema = await postgresService.getTableSchema(body.connectionString, body.table, body.schema);
    return c.json(ok(schema));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /postgres/data — body: { connectionString, table, schema?, page?, limit?, orderBy?, orderDir? } */
postgresRoutes.post("/data", async (c) => {
  try {
    const body = await c.req.json<{
      connectionString: string; table: string; schema?: string;
      page?: number; limit?: number; orderBy?: string; orderDir?: string;
    }>();
    if (!body.connectionString || !body.table) return c.json(err("Missing connectionString or table"), 400);
    const limit = Math.min(body.limit ?? 100, 1000);
    const data = await postgresService.getTableData(
      body.connectionString, body.table, body.schema, body.page ?? 1, limit,
      body.orderBy, (body.orderDir as "ASC" | "DESC") ?? "ASC",
    );
    return c.json(ok(data));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /postgres/query — body: { connectionString, sql } */
postgresRoutes.post("/query", async (c) => {
  try {
    const body = await c.req.json<{ connectionString: string; sql: string }>();
    if (!body.connectionString || !body.sql) return c.json(err("Missing connectionString or sql"), 400);
    const result = await postgresService.executeQuery(body.connectionString, body.sql);
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /postgres/cell — body: { connectionString, table, schema?, pkColumn, pkValue, column, value } */
postgresRoutes.post("/cell", async (c) => {
  try {
    const body = await c.req.json<{
      connectionString: string; table: string; schema?: string;
      pkColumn: string; pkValue: unknown; column: string; value: unknown;
    }>();
    if (!body.connectionString || !body.table || !body.pkColumn || !body.column) {
      return c.json(err("Missing required fields"), 400);
    }
    await postgresService.updateCell(
      body.connectionString, body.table, body.schema,
      body.pkColumn, body.pkValue, body.column, body.value,
    );
    return c.json(ok({ updated: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
