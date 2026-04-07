import { Hono } from "hono";
import {
  getConnections, getConnectionById, insertConnection, updateConnection, deleteConnection,
  type ConnectionConfig, type ConnectionRow,
} from "../../services/db.service.ts";
import { getAdapter } from "../../services/database/adapter-registry.ts";
import { syncTables, searchTables, getTablesFromCache } from "../../services/table-cache.service.ts";
import { isReadOnlyQuery } from "../../services/database/readonly-check.ts";
import { ok, err } from "../../types/api.ts";
import type { DbConnectionConfig } from "../../types/database.ts";

export const databaseRoutes = new Hono();

/** Strip sensitive connection_config from connection responses */
function sanitizeConn(conn: ConnectionRow): Omit<ConnectionRow, "connection_config"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { connection_config: _, ...safe } = conn;
  return safe;
}

/** Validate hex color string (e.g. #3b82f6) */
function isValidHex(color: string): boolean {
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color);
}

/** Resolve connection + parse config, return 404 on miss */
function resolveConn(id: string) {
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return null;
  return getConnectionById(numId);
}

// ---------------------------------------------------------------------------
// Connection CRUD
// ---------------------------------------------------------------------------

/** GET /api/db/connections */
databaseRoutes.get("/connections", (c) => {
  try {
    return c.json(ok(getConnections().map(sanitizeConn)));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /api/db/connections/export — full connection data including credentials */
databaseRoutes.get("/connections/export", (c) => {
  try {
    const conns = getConnections();
    const exported = conns.map(({ id, sort_order, created_at, updated_at, ...rest }) => rest);
    return c.json(ok({ version: 1, exported_at: new Date().toISOString(), connections: exported }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/db/connections/import — bulk create from exported JSON */
databaseRoutes.post("/connections/import", async (c) => {
  try {
    const body = await c.req.json<{ connections: Array<{ type: string; name: string; connection_config: string; group_name?: string | null; color?: string | null; readonly?: number }> }>();
    if (!Array.isArray(body.connections)) return c.json(err("connections array is required"), 400);

    const existingNames = new Set(getConnections().map((c) => c.name));
    const created: ReturnType<typeof sanitizeConn>[] = [];
    const errors: string[] = [];

    for (const entry of body.connections) {
      try {
        if (!entry.type || !entry.name || !entry.connection_config) {
          errors.push(`Skipped: missing type/name/connection_config`);
          continue;
        }
        if (!["sqlite", "postgres"].includes(entry.type)) {
          errors.push(`Skipped "${entry.name}": invalid type "${entry.type}"`);
          continue;
        }
        let config: ConnectionConfig;
        try { config = JSON.parse(entry.connection_config); } catch {
          errors.push(`Skipped "${entry.name}": invalid connection_config JSON`);
          continue;
        }

        // Deduplicate name
        let name = entry.name;
        let suffix = 2;
        while (existingNames.has(name)) { name = `${entry.name} (${suffix++})`; }
        existingNames.add(name);

        const conn = insertConnection(entry.type as "sqlite" | "postgres", name, config, entry.group_name, entry.color);
        if (entry.readonly === 0) updateConnection(conn.id, { readonly: 0 });
        created.push(sanitizeConn(getConnectionById(conn.id)!));
      } catch (e) {
        errors.push(`Failed "${entry.name}": ${(e as Error).message}`);
      }
    }

    return c.json(ok({ imported: created.length, skipped: errors.length, errors, connections: created }), 201);
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /api/db/connections/:id */
databaseRoutes.get("/connections/:id", (c) => {
  const conn = resolveConn(c.req.param("id"));
  if (!conn) return c.json(err("Connection not found"), 404);
  return c.json(ok(sanitizeConn(conn)));
});

/** POST /api/db/connections */
databaseRoutes.post("/connections", async (c) => {
  try {
    const body = await c.req.json<{
      type: "sqlite" | "postgres";
      name: string;
      connectionConfig: ConnectionConfig;
      groupName?: string;
      color?: string;
    }>();
    if (!body.type || !body.name || !body.connectionConfig) {
      return c.json(err("type, name, and connectionConfig are required"), 400);
    }
    if (!["sqlite", "postgres"].includes(body.type)) {
      return c.json(err("type must be sqlite or postgres"), 400);
    }
    if (body.color && !isValidHex(body.color)) {
      return c.json(err("color must be a valid hex color (e.g. #3b82f6)"), 400);
    }
    const conn = insertConnection(body.type, body.name, body.connectionConfig, body.groupName, body.color);
    return c.json(ok(sanitizeConn(conn)), 201);
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** PUT /api/db/connections/:id — allows toggling readonly (UI-only) */
databaseRoutes.put("/connections/:id", async (c) => {
  try {
    const conn = resolveConn(c.req.param("id"));
    if (!conn) return c.json(err("Connection not found"), 404);

    const body = await c.req.json<{
      name?: string;
      connectionConfig?: ConnectionConfig;
      groupName?: string | null;
      color?: string | null;
      readonly?: number;
    }>();

    if (body.color && !isValidHex(body.color)) {
      return c.json(err("color must be a valid hex color (e.g. #3b82f6)"), 400);
    }

    updateConnection(conn.id, {
      name: body.name,
      config: body.connectionConfig,
      groupName: body.groupName,
      color: body.color,
      readonly: body.readonly,
    });
    const updated = getConnectionById(conn.id);
    return c.json(ok(updated ? sanitizeConn(updated) : null));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** DELETE /api/db/connections/:id */
databaseRoutes.delete("/connections/:id", (c) => {
  try {
    const conn = resolveConn(c.req.param("id"));
    if (!conn) return c.json(err("Connection not found"), 404);
    deleteConnection(String(conn.id));
    return c.json(ok({ deleted: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

// ---------------------------------------------------------------------------
// Connection operations
// ---------------------------------------------------------------------------

/** POST /api/db/connections/:id/test */
databaseRoutes.post("/connections/:id/test", async (c) => {
  try {
    const conn = resolveConn(c.req.param("id"));
    if (!conn) return c.json(err("Connection not found"), 404);
    const config = JSON.parse(conn.connection_config) as DbConnectionConfig;
    const adapter = getAdapter(conn.type);
    const result = await adapter.testConnection(config);
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /api/db/connections/:id/tables — ?cached=1 reads from cache, otherwise live sync */
databaseRoutes.get("/connections/:id/tables", async (c) => {
  try {
    const conn = resolveConn(c.req.param("id"));
    if (!conn) return c.json(err("Connection not found"), 404);
    const useCached = c.req.query("cached") === "1";
    const result = useCached ? getTablesFromCache(conn.id) : await syncTables(conn.id);
    const tables = result.map((t) => ({ name: t.tableName, schema: t.schemaName, rowCount: t.rowCount }));
    return c.json(ok(tables));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /api/db/connections/:id/schema?table=...&schema=... */
databaseRoutes.get("/connections/:id/schema", async (c) => {
  try {
    const conn = resolveConn(c.req.param("id"));
    if (!conn) return c.json(err("Connection not found"), 404);
    const table = c.req.query("table");
    const schema = c.req.query("schema");
    if (!table) return c.json(err("table query param required"), 400);
    const config = JSON.parse(conn.connection_config) as DbConnectionConfig;
    const adapter = getAdapter(conn.type);
    const cols = await adapter.getTableSchema(config, table, schema);
    return c.json(ok(cols));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /api/db/connections/:id/data?table=...&page=1&limit=100&orderBy=...&orderDir=ASC */
databaseRoutes.get("/connections/:id/data", async (c) => {
  try {
    const conn = resolveConn(c.req.param("id"));
    if (!conn) return c.json(err("Connection not found"), 404);
    const table = c.req.query("table");
    if (!table) return c.json(err("table query param required"), 400);
    const config = JSON.parse(conn.connection_config) as DbConnectionConfig;
    const adapter = getAdapter(conn.type);
    const data = await adapter.getTableData(config, table, {
      schema: c.req.query("schema"),
      page: parseInt(c.req.query("page") ?? "1", 10),
      limit: Math.min(parseInt(c.req.query("limit") ?? "100", 10), 1000),
      orderBy: c.req.query("orderBy"),
      orderDir: (c.req.query("orderDir") as "ASC" | "DESC") ?? "ASC",
    });
    return c.json(ok(data));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/db/connections/:id/query — body: { sql } — enforces readonly */
databaseRoutes.post("/connections/:id/query", async (c) => {
  try {
    const conn = resolveConn(c.req.param("id"));
    if (!conn) return c.json(err("Connection not found"), 404);
    const body = await c.req.json<{ sql: string }>();
    if (!body.sql) return c.json(err("sql is required"), 400);

    if (conn.readonly && !isReadOnlyQuery(body.sql)) {
      return c.json(err("Connection is readonly — only SELECT queries allowed. Change this in PPM web UI."), 403);
    }

    const config = JSON.parse(conn.connection_config) as DbConnectionConfig;
    const adapter = getAdapter(conn.type);
    const result = await adapter.executeQuery(config, body.sql);
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** PUT /api/db/connections/:id/cell — body: { table, schema?, pkColumn, pkValue, column, value } — enforces readonly */
databaseRoutes.put("/connections/:id/cell", async (c) => {
  try {
    const conn = resolveConn(c.req.param("id"));
    if (!conn) return c.json(err("Connection not found"), 404);

    if (conn.readonly) {
      return c.json(err("Connection is readonly — cell editing is disabled. Change this in PPM web UI."), 403);
    }

    const body = await c.req.json<{
      table: string; schema?: string;
      pkColumn: string; pkValue: unknown; column: string; value: unknown;
    }>();
    if (!body.table || !body.pkColumn || !body.column) {
      return c.json(err("table, pkColumn, and column are required"), 400);
    }

    const config = JSON.parse(conn.connection_config) as DbConnectionConfig;
    const adapter = getAdapter(conn.type);
    await adapter.updateCell(config, body.table, {
      schema: body.schema,
      pkColumn: body.pkColumn,
      pkValue: body.pkValue,
      column: body.column,
      value: body.value,
    });
    return c.json(ok({ updated: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** DELETE /api/db/connections/:id/row — body: { table, schema?, pkColumn, pkValue } — enforces readonly */
databaseRoutes.delete("/connections/:id/row", async (c) => {
  try {
    const conn = resolveConn(c.req.param("id"));
    if (!conn) return c.json(err("Connection not found"), 404);

    if (conn.readonly) {
      return c.json(err("Connection is readonly — row deletion is disabled. Change this in PPM web UI."), 403);
    }

    const body = await c.req.json<{
      table: string; schema?: string;
      pkColumn: string; pkValue: unknown;
    }>();
    if (!body.table || !body.pkColumn || body.pkValue == null) {
      return c.json(err("table, pkColumn, and pkValue are required"), 400);
    }

    const config = JSON.parse(conn.connection_config) as DbConnectionConfig;
    const adapter = getAdapter(conn.type);
    await adapter.deleteRow(config, body.table, {
      schema: body.schema,
      pkColumn: body.pkColumn,
      pkValue: body.pkValue,
    });
    return c.json(ok({ deleted: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** GET /api/db/search?q=... — search cached tables across all connections */
databaseRoutes.get("/search", (c) => {
  try {
    const q = c.req.query("q") ?? "";
    return c.json(ok(searchTables(q)));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

