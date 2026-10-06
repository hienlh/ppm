import { Hono, type Context } from "hono";
import {
  getConnections, getConnectionById, getConnectionByName, insertConnection, updateConnection, deleteConnection,
  decryptConfig, moveConnectionGroup,
  type ConnectionConfig, type ConnectionRow,
} from "../../services/db.service.ts";
import {
  ConnectionConfigError, editableConfig, normalizeConnectionConfig, withLogin, type DbLogin,
} from "../../services/database/connection-config.ts";
import { runConnectionTest } from "../../services/database/connection-test.ts";
import {
  DbLoginRequiredError, asksForLogin, closeConnection, forgetLogin, hasHeldLogin, holdLogin, loginPrompt, loginRequiredBody,
  missingLogin,
} from "../../services/database/connection-login.ts";
import { findSshAgent } from "../../services/database/ssh-agent-socket.ts";
import { DatabaseTargetError, ownDatabase, readDatabaseParam, withDatabase } from "../../services/database/connection-database.ts";
import { localSshUser } from "../../services/database/ssh-tunnel.ts";
import type { PasswordMode, StoredConnectionConfig } from "../../shared/db-connection-config.ts";
import { parseDbUrl } from "../../shared/db-connection-url.ts";
import { getAdapter } from "../../services/database/adapter-registry.ts";
import { syncTables, searchTables, getTablesFromCache } from "../../services/table-cache.service.ts";
import { isReadOnlyQuery } from "../../services/database/readonly-check.ts";
import { isReadonlyRefusal, readonlyRefusalMessage } from "../../services/database/db-errors.ts";
import { detectOperation, type QueryOperation } from "../../services/query-audit/query-audit.service.ts";
import { ChangesetRequestError, changesetScript, parseChangeset, type ValidChangeset } from "../../services/database/changeset.ts";
import { prepareChangeset, type PreparedChangeset } from "../../services/database/changeset.service.ts";
import { defaultSchemaFor } from "../../services/database/grid.service.ts";
import type { Changeset, ChangesetApplyResult, RowKey } from "../../shared/db-changeset.ts";
import { logQuery } from "./query-audit-hook.ts";
import { ok, err } from "../../types/api.ts";
import { rowsToRecords } from "../../shared/db-grid.ts";
import { dialectFor } from "../../services/database/dialects.ts";
import { DB_TYPES, isDbType, type DbType } from "../../shared/db-types.ts";
import {
  connAudit, connConfig, connTarget, connTimeoutMs, databaseParam, driverMissingResponse, holdRequestOpen, requestDatabase, resolveConn,
  resolveTargetConn, setRequestFileConnection, withTimeout,
} from "./database-route-helpers.ts";
import {
  FILE_CONNECTION_ID, fileConnectionRow, isFileConnection, openFileDatabase,
} from "../../services/database/file-database.ts";
import { fsErrorBody } from "../../services/fs-ops/fs-error-response.ts";
import { databaseDriverRoutes } from "./database-drivers.ts";
import { databaseGridRoutes } from "./database-grid.ts";
import { gridExportDownloadRoutes } from "./database-grid-export.ts";
import {
  applyAndAudit, attemptedScript, databaseChangesetRoutes, failureResponse, requestErrorStatus,
} from "./database-changeset.ts";
import { databaseStructureRoutes } from "./database-structure.ts";
import { databaseImpExpRoutes, impExpJobRoutes } from "./database-impexp.ts";
import { databaseQueryRoutes } from "./database-query.ts";

export const databaseRoutes = new Hono();

databaseRoutes.route("/drivers", databaseDriverRoutes);

/**
 * GET /api/db/ssh/agent — whether the PPM host has an SSH agent the SSH agent method can use (the
 * line under that choice on the SSH Tunnel tab), and the user an empty Login logs in as.
 */
databaseRoutes.get("/ssh/agent", (c) => {
  const socket = findSshAgent();
  return c.json(ok({ found: socket !== null, socket, user: localSshUser() }));
});

/**
 * Anything a saved connection does needs its engine's driver. Registered
 * before the routes it guards; the cached table list is read from PPM's own
 * database and needs none. `/connections/:id/*` also matches
 * `/connections/export` and `/connections/5` itself, hence the path test.
 */
databaseRoutes.use("/connections/:id/*", async (c, next) => {
  if (!/\/connections\/[^/]+\/./.test(c.req.path)) return next();
  // A database file named by the request, checked again every time: SQLite needs no driver and
  // a file no login. Only the data routes serve it; the rest know saved connections only.
  if (c.req.param("id") === FILE_CONNECTION_ID) {
    if (c.req.query("database") !== undefined) return c.json(err("A database file holds no other databases"), 400);
    try {
      setRequestFileConnection(c, fileConnectionRow(await openFileDatabase({ path: c.req.query("path"), project: c.req.query("project") })));
    } catch (e) {
      const { body, status } = fsErrorBody(e);
      return c.json(body, status);
    }
    return next();
  }
  if (c.req.path.endsWith("/tables") && c.req.query("cached") === "1") return next();
  // Editing a connection needs no driver: the form is how one whose driver is gone gets fixed.
  // Nor does closing one, or copying its settings, or reading what was run on it from PPM's log.
  if (c.req.path.endsWith("/config") || c.req.path.endsWith("/disconnect") || c.req.path.endsWith("/duplicate")) return next();
  if (c.req.path.endsWith("/history")) return next();
  const conn = resolveConn(c.req.param("id"));
  if (!conn) return next();
  let saved: StoredConnectionConfig | null = null;
  try {
    saved = decryptConfig(conn.connection_config);
  } catch { /* the route itself says what is wrong */ }
  // One of the server's other databases, from the tree: a name it cannot have, or a connection
  // that is one database, is the request's mistake.
  try {
    const database = readDatabaseParam(c.req.query("database"));
    if (database !== undefined && saved) withDatabase(saved, database);
  } catch (e) {
    if (e instanceof DatabaseTargetError) return c.json(err(e.message), 400);
    throw e;
  }
  const missing = await driverMissingResponse(c, conn.type, saved);
  if (missing) return missing;
  // A connection that asks for its password opens once Database Log In has a login for it.
  if (c.req.path.endsWith("/login")) return next();
  let needsLogin: ReturnType<typeof missingLogin> = null;
  try {
    needsLogin = missingLogin(conn);
  } catch { /* an unreadable config: the route itself says what is wrong */ }
  return needsLogin ? c.json(loginRequiredBody(needsLogin), 428) : next();
});

databaseRoutes.route("/connections", databaseGridRoutes);
// The file of an export started by POST /connections/:id/grid/export, fetched with its ticket.
databaseRoutes.route("/grid-export", gridExportDownloadRoutes);
databaseRoutes.route("/connections", databaseChangesetRoutes);
databaseRoutes.route("/connections", databaseStructureRoutes);
databaseRoutes.route("/connections", databaseImpExpRoutes);
// The Query tab's runs and their Stop.
databaseRoutes.route("/connections", databaseQueryRoutes);
// An Import/Export job, found by its id once the request that started it has been answered.
databaseRoutes.route("/impexp", impExpJobRoutes);

/** What the sidebar needs from a connection's config, beside its row. */
interface ConnectionListing {
  password_mode: PasswordMode;
  /** A login is held for a connection that asks for one. */
  logged_in: boolean;
  /** The Advanced tab's display filter; the browser applies it (see `filterAllowedDatabases`). */
  allowed_databases: string[];
  allowed_databases_regex: string | null;
  /** The database the URL names; null for SQLite and for a server connection naming none. */
  default_database: string | null;
  /**
   * The tree shows the connection as one database rather than a server with a list of them:
   * a SQLite file, or a server connection with a default database and "Use only database" ticked.
   */
  single_database: boolean;
  /** Where it connects, for the tree's tooltip and its "Server" search: host:port, a socket or a file. */
  server: string | null;
  /** The login the URL names; null for SQLite and for one PPM asks for each time. */
  user: string | null;
}

/**
 * A connection as the browser sees it: the row without its config, plus what the sidebar needs
 * from the config. Never the URL, which is where the password is.
 */
function sanitizeConn(conn: ConnectionRow): Omit<ConnectionRow, "connection_config"> & ConnectionListing {
  const { connection_config, ...safe } = conn;
  const listing: ConnectionListing = {
    password_mode: "save", logged_in: hasHeldLogin(conn.id), allowed_databases: [], allowed_databases_regex: null,
    default_database: null, single_database: conn.type === "sqlite", server: null, user: null,
  };
  try {
    const config = decryptConfig(connection_config);
    if (config.type === "sqlite") {
      listing.server = config.path;
    } else {
      listing.password_mode = config.passwordMode ?? "save";
      listing.allowed_databases = config.allowedDatabases ?? [];
      listing.allowed_databases_regex = config.allowedDatabasesRegex ?? null;
      listing.default_database = ownDatabase(config);
      listing.single_database = listing.default_database !== null && config.singleDatabase !== false;
      const parsed = parseDbUrl(config.connectionString);
      if (parsed.kind === "url") {
        const { host, port, socket, user } = parsed.parts;
        listing.server = socket || (port === null ? host : `${host}:${port}`) || null;
        listing.user = user || null;
      }
    }
  } catch { /* listed as it is; opening it says what is wrong */ }
  return { ...safe, ...listing };
}

/** Validate hex color string (e.g. #3b82f6) */
function isValidHex(color: string): boolean {
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color);
}

/** A checkbox sent as a boolean or as 1/0, as the column stores it; left out is no change. */
function flag(value: number | boolean | undefined): number | undefined {
  return value === undefined ? undefined : value ? 1 : 0;
}

/** A 400 naming the form field the problem is in, so the form can open its tab and focus it. */
function configError(c: Context, e: ConnectionConfigError): Response {
  return c.json({ ...err(e.message), field: e.field }, 400);
}

/** A name another connection already has, or null. `except` is the connection being renamed. */
function nameTaken(name: string, except?: number): boolean {
  const other = getConnectionByName(name);
  return !!other && other.id !== except;
}

function isLogin(value: unknown): value is DbLogin {
  if (!value || typeof value !== "object") return false;
  const { user, password } = value as Record<string, unknown>;
  return (user === undefined || typeof user === "string") && (password === undefined || typeof password === "string");
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

/**
 * GET /api/db/connections/export — full connection data including credentials (decrypted): every
 * password, the SSH and SSL ones too. The one route that sends a secret to the browser, on
 * purpose — Import recreates the connections from the file, and the menu says what it holds.
 */
databaseRoutes.get("/connections/export", (c) => {
  try {
    const conns = getConnections();
    const exported = conns.map(({ id, sort_order, created_at, updated_at, connection_config, ...rest }) => ({
      ...rest,
      connection_config: JSON.stringify(decryptConfig(connection_config)),
    }));
    return c.json(ok({ version: 1, exported_at: new Date().toISOString(), connections: exported }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/db/connections/import — bulk create from exported JSON */
databaseRoutes.post("/connections/import", async (c) => {
  try {
    const body = await c.req.json<{ connections: Array<{ type: string; name: string; connection_config: string; group_name?: string | null; color?: string | null; readonly?: number; ai_access?: number }> }>();
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
        if (!isDbType(entry.type)) {
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

        const conn = insertConnection(entry.type, name, config, entry.group_name, entry.color);
        if (entry.readonly === 0) updateConnection(conn.id, { readonly: 0 });
        if (entry.ai_access === 0) updateConnection(conn.id, { aiAccess: 0 });
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

/** The longest folder name the tree takes, as the form does. */
const MAX_FOLDER_NAME = 100;

/**
 * POST /api/db/connections/folder — body: { from, to }. Renames folder `from` to `to` by moving
 * every connection in it, in one statement; `to: null` deletes the folder and leaves its
 * connections outside any folder. A folder with no connections lives only in the browser.
 */
databaseRoutes.post("/connections/folder", async (c) => {
  try {
    const body = await c.req.json<{ from?: unknown; to?: unknown }>();
    if (typeof body.from !== "string" || !body.from) return c.json(err("from is required"), 400);
    let to: string | null = null;
    if (body.to !== null) {
      if (typeof body.to !== "string" || !body.to.trim()) return c.json(err("Give the folder a name"), 400);
      to = body.to.trim();
      if (to.length > MAX_FOLDER_NAME) return c.json(err(`A folder name is at most ${MAX_FOLDER_NAME} characters`), 400);
    }
    return c.json(ok({ moved: moveConnectionGroup(body.from, to) }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** "<name> (copy)", or "(copy 2)" and on when that is taken too. */
function copyName(name: string): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${name} (copy)` : `${name} (copy ${n})`;
    if (!getConnectionByName(candidate)) return candidate;
  }
}

/**
 * POST /api/db/connections/:id/duplicate — a new connection with the same settings, password
 * included, which the browser never has. A login held for the original is not carried over.
 */
databaseRoutes.post("/connections/:id/duplicate", (c) => {
  try {
    const conn = resolveConn(c.req.param("id"));
    if (!conn) return c.json(err("Connection not found"), 404);
    const copy = insertConnection(conn.type, copyName(conn.name), decryptConfig(conn.connection_config), conn.group_name, conn.color);
    updateConnection(copy.id, { readonly: conn.readonly, aiAccess: conn.ai_access });
    return c.json(ok(sanitizeConn(getConnectionById(copy.id) ?? copy)), 201);
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

/** GET /api/db/connections/:id/config — the saved config for the edit form, with no password in it */
databaseRoutes.get("/connections/:id/config", (c) => {
  const conn = resolveConn(c.req.param("id"));
  if (!conn) return c.json(err("Connection not found"), 404);
  try {
    return c.json(ok(editableConfig(decryptConfig(conn.connection_config))));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/db/connections — body: { type, name, connectionConfig, groupName?, color?, readonly? } */
databaseRoutes.post("/connections", async (c) => {
  try {
    const body = await c.req.json<{
      type: DbType;
      name: string;
      connectionConfig: unknown;
      groupName?: string;
      color?: string;
      readonly?: number | boolean;
      aiAccess?: number | boolean;
    }>();
    if (!body.type || typeof body.name !== "string" || !body.connectionConfig) {
      return c.json(err("type, name, and connectionConfig are required"), 400);
    }
    if (!isDbType(body.type)) {
      return c.json(err(`type must be one of ${DB_TYPES.join(", ")}`), 400);
    }
    if (body.color && !isValidHex(body.color)) {
      return c.json(err("color must be a valid hex color (e.g. #3b82f6)"), 400);
    }
    const name = body.name.trim();
    if (!name) return c.json({ ...err("Give the connection a name"), field: "name" }, 400);
    if (nameTaken(name)) return c.json({ ...err(`A connection named "${name}" already exists`), field: "name" }, 409);
    const config = normalizeConnectionConfig(body.type, body.connectionConfig);
    const conn = insertConnection(body.type, name, config, body.groupName, body.color);
    // Both columns default to on (readonly, available to the AI chat); only a form that unticked one says otherwise.
    updateConnection(conn.id, { readonly: flag(body.readonly), aiAccess: flag(body.aiAccess) });
    return c.json(ok(sanitizeConn(getConnectionById(conn.id) ?? conn)), 201);
  } catch (e) {
    if (e instanceof ConnectionConfigError) return configError(c, e);
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
      connectionConfig?: unknown;
      groupName?: string | null;
      color?: string | null;
      readonly?: number | boolean;
      aiAccess?: number | boolean;
    }>();

    if (body.color && !isValidHex(body.color)) {
      return c.json(err("color must be a valid hex color (e.g. #3b82f6)"), 400);
    }
    let name: string | undefined;
    if (body.name !== undefined) {
      name = String(body.name).trim();
      if (!name) return c.json({ ...err("Give the connection a name"), field: "name" }, 400);
      if (nameTaken(name, conn.id)) return c.json({ ...err(`A connection named "${name}" already exists`), field: "name" }, 409);
    }
    // A config sent with no URL keeps the saved one; `keepPassword` keeps the saved password.
    const before = decryptConfig(conn.connection_config);
    const config = body.connectionConfig === undefined
      ? undefined
      : normalizeConnectionConfig(conn.type, body.connectionConfig, before);
    // A held login belongs to the config it was typed for; pools and a tunnel opened with
    // settings that changed are no use to anyone.
    if (config) {
      if (JSON.stringify(config) === JSON.stringify(before)) await forgetLogin(conn);
      else await closeConnection(conn);
    }

    updateConnection(conn.id, {
      name,
      config,
      groupName: body.groupName,
      color: body.color,
      readonly: flag(body.readonly),
      aiAccess: flag(body.aiAccess),
    });
    const updated = getConnectionById(conn.id);
    return c.json(ok(updated ? sanitizeConn(updated) : null));
  } catch (e) {
    if (e instanceof ConnectionConfigError) return configError(c, e);
    return c.json(err((e as Error).message), 500);
  }
});

/** DELETE /api/db/connections/:id */
databaseRoutes.delete("/connections/:id", async (c) => {
  try {
    const conn = resolveConn(c.req.param("id"));
    if (!conn) return c.json(err("Connection not found"), 404);
    await closeConnection(conn);
    deleteConnection(String(conn.id));
    return c.json(ok({ deleted: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

// ---------------------------------------------------------------------------
// Connection operations
// ---------------------------------------------------------------------------

/**
 * POST /api/db/test — test a config the form has not saved, from the PPM host.
 * Body: { type, connectionConfig, connectionId?, login? }. `connectionId` is the connection being
 * edited: with `connectionConfig.keepPassword` its saved password stands in for an empty field.
 * `login` is what Database Log In was given, for a connection that asks for its password.
 * Answers `DbTestResult` — the version and the databases, or the driver's error and its details.
 */
databaseRoutes.post("/test", async (c) => {
  try {
    const body = await c.req.json<{ type: DbType; connectionConfig: unknown; connectionId?: number | string | null; login?: unknown }>();
    if (!body.type || !body.connectionConfig) return c.json(err("type and connectionConfig required"), 400);
    if (!isDbType(body.type)) return c.json(err(`type must be one of ${DB_TYPES.join(", ")}`), 400);

    let saved: ConnectionRow | null = null;
    if (body.connectionId !== undefined && body.connectionId !== null) {
      saved = resolveConn(String(body.connectionId));
      if (!saved) return c.json(err("Connection not found"), 404);
      if (saved.type !== body.type) return c.json({ ...err("A saved connection keeps its type"), field: "type" }, 400);
    }
    const previous = saved ? decryptConfig(saved.connection_config) : null;
    let config = normalizeConnectionConfig(body.type, body.connectionConfig, previous);

    if (asksForLogin(config)) {
      if (!isLogin(body.login)) {
        const prompt = loginPrompt({ id: saved?.id ?? null, name: saved?.name ?? "", type: body.type }, config);
        return c.json(loginRequiredBody(new DbLoginRequiredError(prompt)), 428);
      }
      config = withLogin(config, body.login);
    }

    const missing = await driverMissingResponse(c, body.type, config);
    if (missing) return missing;
    return c.json(ok(await runConnectionTest(config)));
  } catch (e) {
    if (e instanceof ConnectionConfigError) return configError(c, e);
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * POST /api/db/connections/:id/login — body: { user?, password }. What Database Log In sends for
 * a connection that asks for its password: the login is tested from the PPM host and, when it
 * works, held in memory until Disconnect. Answers `DbTestResult`; a failed login holds nothing.
 */
databaseRoutes.post("/connections/:id/login", async (c) => {
  try {
    const conn = resolveConn(c.req.param("id"));
    if (!conn) return c.json(err("Connection not found"), 404);
    const body = await jsonBody<{ user: string; password: string }>(c);
    if (!isLogin(body)) return c.json(err("user and password must be text"), 400);
    const config = decryptConfig(conn.connection_config);
    if (!asksForLogin(config)) return c.json(err("This connection saves its password: there is no login to give it"), 400);
    const login = { user: body.user?.trim() || undefined, password: body.password ?? "" };
    if (config.type !== "sqlite" && config.passwordMode === "askUser" && !login.user) {
      return c.json({ ...err("Enter the user name"), field: "user" }, 400);
    }
    const result = await runConnectionTest(withLogin(config, login));
    if (result.ok) await holdLogin(conn, login);
    return c.json(ok(result));
  } catch (e) {
    if (e instanceof ConnectionConfigError) return configError(c, e);
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * POST /api/db/connections/:id/disconnect — close its pools and forget a held login. Body
 * `{ keepLogin: true }` is the tree's Reconnect: the pools close, a held login stays, so opening
 * the connection again does not ask for its password.
 */
databaseRoutes.post("/connections/:id/disconnect", async (c) => {
  try {
    const conn = resolveConn(c.req.param("id"));
    if (!conn) return c.json(err("Connection not found"), 404);
    const body: { keepLogin?: unknown } = await c.req.json().catch(() => ({}));
    await closeConnection(conn, { keepLogin: body?.keepLogin === true });
    return c.json(ok({ disconnected: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/db/connections/:id/test */
databaseRoutes.post("/connections/:id/test", async (c) => {
  try {
    const conn = resolveConn(c.req.param("id"));
    if (!conn) return c.json(err("Connection not found"), 404);
    const config = connConfig(conn);
    const adapter = getAdapter(conn.type);
    const result = await withTimeout(adapter.testConnection(config), connTimeoutMs(config, 15_000));
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /api/db/connections/:id/tables — ?cached=1 reads from cache, otherwise live sync */
databaseRoutes.get("/connections/:id/tables", async (c) => {
  try {
    const conn = resolveTargetConn(c);
    if (!conn) return c.json(err("Connection not found"), 404);
    // A database file has no row for the table cache to belong to; its list is read as it stands.
    if (isFileConnection(conn)) return c.json(ok(await getAdapter("sqlite").getTables(connConfig(conn))));
    const useCached = c.req.query("cached") === "1";
    const timeout = useCached ? 0 : connTimeoutMs(decryptConfig(conn.connection_config), 15_000);
    const result = useCached ? getTablesFromCache(conn.id) : await withTimeout(syncTables(conn.id), timeout);
    const tables = result.map((t) => ({ name: t.tableName, schema: t.schemaName, rowCount: t.rowCount }));
    return c.json(ok(tables));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /api/db/connections/:id/schema?table=...&schema=... */
databaseRoutes.get("/connections/:id/schema", async (c) => {
  try {
    const conn = resolveTargetConn(c);
    if (!conn) return c.json(err("Connection not found"), 404);
    const table = c.req.query("table");
    // An empty schema is the connection's own, as it is for /grid.
    const schema = c.req.query("schema") || undefined;
    if (!table) return c.json(err("table query param required"), 400);
    const config = connConfig(conn, requestDatabase(c));
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
    const conn = resolveTargetConn(c);
    if (!conn) return c.json(err("Connection not found"), 404);
    const table = c.req.query("table");
    if (!table) return c.json(err("table query param required"), 400);
    const config = connConfig(conn, requestDatabase(c));
    const adapter = getAdapter(conn.type);
    const data = await adapter.getTableData(config, table, {
      schema: c.req.query("schema") || undefined,
      page: parseInt(c.req.query("page") ?? "1", 10),
      // At least one: SQLite reads a negative LIMIT as no limit at all.
      limit: Math.min(Math.max(parseInt(c.req.query("limit") ?? "100", 10), 1), 1000),
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
  const startedAt = Date.now();
  try {
    const conn = resolveTargetConn(c);
    if (!conn) return c.json(err("Connection not found"), 404);
    const body = await c.req.json<{ sql: string; source?: "filter" }>();
    if (!body.sql) return c.json(err("sql is required"), 400);
    // A query sends nothing until it is done, however long that takes.
    holdRequestOpen(c, 0);

    const audit = {
      ...connAudit(conn),
      // The grid reuses this endpoint for column filters, so it says when the SQL is not user-typed.
      source: body.source === "filter" ? ("filter" as const) : ("editor" as const),
      operation: detectOperation(body.sql),
      sql: body.sql,
      ...(requestDatabase(c) !== undefined ? { params: databaseParam(c) } : {}),
    };

    if (conn.readonly && !isReadOnlyQuery(body.sql, dialectFor(conn.type).name)) {
      const message = "Connection is readonly — only SELECT queries allowed. Change this in PPM web UI.";
      logQuery(c, { ...audit, status: "blocked", error: message, durationMs: Date.now() - startedAt });
      return c.json(err(message), 403);
    }

    const config = connConfig(conn, requestDatabase(c));
    const adapter = getAdapter(conn.type);
    try {
      const result = await adapter.runQuery(config, body.sql);
      logQuery(c, {
        ...audit,
        status: "ok",
        rows: rowsToRecords(result.columns, result.rows).records,
        rowCount: result.changeType === "select" ? result.rows.length : result.rowsAffected,
        durationMs: Date.now() - startedAt,
      });
      return c.json(ok(result));
    } catch (e) {
      // A read that writes (`SELECT nextval('s')`, a function that deletes)
      // passes the first check and is refused by the database itself.
      if (isReadonlyRefusal(e)) {
        const message = readonlyRefusalMessage(e);
        logQuery(c, { ...audit, status: "blocked", error: message, durationMs: Date.now() - startedAt });
        return c.json(err(message), 403);
      }
      logQuery(c, { ...audit, status: "error", error: (e as Error).message, durationMs: Date.now() - startedAt });
      throw e;
    }
  } catch (e) {
    // SQL refused before it reached the database — ATTACH on SQLite — is the request's own mistake.
    const refused = e as { status?: number; code?: string };
    if (refused.status === 400) return c.json({ ...err((e as Error).message), ...(refused.code ? { code: refused.code } : {}) }, 400);
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * Run one of the older single-change endpoints as a changeset: parameterised,
 * in one transaction, and every UPDATE or DELETE must hit exactly one row.
 * The audit entry keeps the endpoint's own operation and params; its SQL is
 * the script that ran. `missing` is the endpoint's required-field message,
 * checked after the readonly refusal so a blocked attempt is always logged.
 */
async function legacyWrite(
  c: Context,
  conn: ConnectionRow,
  body: Changeset,
  opts: { operation: QueryOperation; params: unknown; missing: string | null; readonlyMessage: string; startedAt: number },
): Promise<ChangesetApplyResult | Response> {
  const database = requestDatabase(c);
  const audit = {
    ...connAudit(conn), source: "grid" as const, operation: opts.operation,
    params: database === undefined ? opts.params : { database, ...(opts.params as object) },
  };
  let cs: ValidChangeset | null = null;
  let invalid = opts.missing;
  try {
    cs = parseChangeset(body, defaultSchemaFor(conn.type));
  } catch (e) {
    if (!(e instanceof ChangesetRequestError)) throw e;
    invalid ??= e.message;
  }

  if (conn.readonly) {
    const sql = cs ? await attemptedScript(conn, cs, database) : `-- ${opts.operation} on ${dialectFor(conn.type).qualify(String(body.table ?? ""), body.schema)}`;
    logQuery(c, { ...audit, sql, status: "blocked", error: opts.readonlyMessage, durationMs: Date.now() - opts.startedAt });
    return c.json(err(opts.readonlyMessage), 403);
  }
  if (invalid || !cs) return c.json(err(invalid ?? "Invalid request"), 400);

  const target = connTarget(conn, database);
  let prepared: PreparedChangeset;
  try {
    prepared = await prepareChangeset(target, cs);
  } catch (e) {
    return c.json(err((e as Error).message), requestErrorStatus(e));
  }
  const outcome = await applyAndAudit(c, target, prepared, { ...audit, sql: changesetScript(prepared.statements) }, opts.startedAt);
  return outcome.ok ? outcome.result : failureResponse(c, outcome);
}

/** The row a legacy body names: a `key` of every key column, or one `pkColumn` and its value. */
function legacyKey(body: { key?: unknown; pkColumn?: unknown; pkValue?: unknown }): RowKey | null {
  if (body.key && typeof body.key === "object" && !Array.isArray(body.key)) return body.key as RowKey;
  return typeof body.pkColumn === "string" && body.pkColumn ? { [body.pkColumn]: body.pkValue ?? null } : null;
}

async function jsonBody<T>(c: Context): Promise<Partial<T>> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

/**
 * PUT /api/db/connections/:id/cell — body: { table, schema?, pkColumn, pkValue | key, column, value }.
 * Answers 409 when no row has that key any more.
 */
databaseRoutes.put("/connections/:id/cell", async (c) => {
  const startedAt = Date.now();
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const body = await jsonBody<{
    table: string; schema?: string; key?: RowKey;
    pkColumn: string; pkValue: unknown; column: string; value: unknown;
  }>(c);
  const key = legacyKey(body);
  const done = await legacyWrite(c, conn, {
    table: body.table ?? "",
    schema: body.schema,
    updates: key && body.column ? [{ key, set: { [body.column]: body.value ?? null } }] : [],
  }, {
    operation: "update",
    params: { table: body.table, schema: body.schema, column: body.column, pkColumn: body.pkColumn, pkValue: body.pkValue, ...(body.key ? { key: body.key } : {}) },
    missing: !body.table || !key || !body.column ? "table, pkColumn (or key), and column are required" : null,
    readonlyMessage: "Connection is readonly — cell editing is disabled. Change this in PPM web UI.",
    startedAt,
  });
  return done instanceof Response ? done : c.json(ok({ updated: true }));
});

/** DELETE /api/db/connections/:id/row — body: { table, schema?, pkColumn, pkValue | key } */
databaseRoutes.delete("/connections/:id/row", async (c) => {
  const startedAt = Date.now();
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const body = await jsonBody<{ table: string; schema?: string; key?: RowKey; pkColumn: string; pkValue: unknown }>(c);
  const key = body.key || body.pkValue != null ? legacyKey(body) : null;
  const done = await legacyWrite(c, conn, {
    table: body.table ?? "",
    schema: body.schema,
    deletes: key ? [{ key }] : [],
  }, {
    operation: "delete",
    params: { table: body.table, schema: body.schema, pkColumn: body.pkColumn, pkValue: body.pkValue, ...(body.key ? { key: body.key } : {}) },
    missing: !body.table || !key ? "table, pkColumn, and pkValue (or key) are required" : null,
    readonlyMessage: "Connection is readonly — row deletion is disabled. Change this in PPM web UI.",
    startedAt,
  });
  return done instanceof Response ? done : c.json(ok({ deleted: true }));
});

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

/**
 * POST /api/db/connections/:id/rows/delete — body: { table, schema?, pkColumn, pkValues[] | keys[] }.
 * All rows or none: one of them failing leaves every row in place.
 */
databaseRoutes.post("/connections/:id/rows/delete", async (c) => {
  const startedAt = Date.now();
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const body = await jsonBody<{ table: string; schema?: string; pkColumn: string; pkValues: unknown[]; keys: RowKey[] }>(c);
  const keys: RowKey[] = Array.isArray(body.keys)
    ? body.keys
    : Array.isArray(body.pkValues) && body.pkColumn ? body.pkValues.map((v) => ({ [body.pkColumn!]: v })) : [];
  // One entry for the whole batch — it is a single user action, and the ids live in params.
  const done = await legacyWrite(c, conn, {
    table: body.table ?? "",
    schema: body.schema,
    deletes: keys.map((key) => ({ key })),
  }, {
    operation: "delete",
    params: { table: body.table, schema: body.schema, pkColumn: body.pkColumn, pkValues: body.pkValues, ...(body.keys ? { keys: body.keys } : {}) },
    missing: !body.table || keys.length === 0 ? "table, pkColumn, and pkValues[] (or keys[]) are required" : null,
    readonlyMessage: "Connection is readonly — bulk delete is disabled.",
    startedAt,
  });
  return done instanceof Response ? done : c.json(ok({ deleted: done.deleted }));
});

/** POST /api/db/connections/:id/row — insert a new row; body: { table, schema?, values } */
databaseRoutes.post("/connections/:id/row", async (c) => {
  const startedAt = Date.now();
  const conn = resolveTargetConn(c);
  if (!conn) return c.json(err("Connection not found"), 404);
  const body = await jsonBody<{ table: string; schema?: string; values: Record<string, unknown> }>(c);
  const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : {};
  const done = await legacyWrite(c, conn, {
    table: body.table ?? "",
    schema: body.schema,
    inserts: [values],
  }, {
    operation: "insert",
    params: { table: body.table, schema: body.schema, columns: Object.keys(values) },
    missing: !body.table || Object.keys(values).length === 0 ? "table and values are required" : null,
    readonlyMessage: "Connection is readonly — insert is disabled.",
    startedAt,
  });
  return done instanceof Response ? done : c.json(ok({ inserted: true }), 201);
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** GET /api/db/connections/:id/export?table=X&schema=Y&format=csv|json&limit=10000 */
databaseRoutes.get("/connections/:id/export", async (c) => {
  try {
    const conn = resolveTargetConn(c);
    if (!conn) return c.json(err("Connection not found"), 404);
    const table = c.req.query("table");
    if (!table) return c.json(err("table query param required"), 400);
    const schema = c.req.query("schema") || undefined;
    const format = c.req.query("format") === "json" ? "json" : "csv";
    const limit = Math.min(parseInt(c.req.query("limit") ?? "10000", 10), 10000);

    const config = connConfig(conn, requestDatabase(c));
    const adapter = getAdapter(conn.type);
    const data = await adapter.getTableData(config, table, { schema, page: 1, limit });

    if (format === "json") {
      return new Response(JSON.stringify(data.rows, null, 2), {
        headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${table}.json"` },
      });
    }

    // CSV
    const escape = (val: string): string => {
      if (val.includes(",") || val.includes('"') || val.includes("\n")) return `"${val.replace(/"/g, '""')}"`;
      return val;
    };
    const lines = [data.columns.map(escape).join(",")];
    for (const row of data.rows) {
      lines.push(data.columns.map((col) => escape(String(row[col] ?? ""))).join(","));
    }
    return new Response(lines.join("\n"), {
      headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${table}.csv"` },
    });
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

