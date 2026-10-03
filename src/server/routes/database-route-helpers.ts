import type { Context } from "hono";
import { getConnectionById, type ConnectionRow } from "../../services/db.service.ts";
import { effectiveConfig } from "../../services/database/connection-login.ts";
import { noteOpenedDatabase, ownDatabase, readDatabaseParam, withDatabase } from "../../services/database/connection-database.ts";
import { getAdapter } from "../../services/database/adapter-registry.ts";
import { driverForEngine, type DbDriverId } from "../../services/database/drivers/db-driver-catalog.ts";
import { DbDriverMissingError, loadDbDriver } from "../../services/database/drivers/db-driver-loader.ts";
import { sshTunnelOpenBudgetMs } from "../../services/database/ssh-tunnel.ts";
import type { SshTunnelSettings } from "../../shared/db-connection-config.ts";
import { DB_DRIVER_MISSING, type DbDriverMissingBody } from "../../shared/db-drivers.ts";
import type { DbType } from "../../shared/db-types.ts";
import type { StoredConnectionConfig } from "../../shared/db-connection-config.ts";
import type { GridTarget } from "../../services/database/grid.service.ts";
import type { DbConnectionConfig } from "../../types/database.ts";
import type { AuditFields } from "./query-audit-hook.ts";
import { fileConnectionConfig, isFileConnection, type FileConnectionRow } from "../../services/database/file-database.ts";

/**
 * Let one request stay silent for up to `seconds`. Bun.serve closes a connection that sends nothing
 * for 10 s, and a COUNT(*) or a sorted page of a big table sends nothing until it is done, so the
 * browser got a dropped connection instead of the answer. `c.env` is the server `app.fetch` was
 * handed; a test calling `app.fetch(req)` has none, and nothing needs lifting there.
 */
export function holdRequestOpen(c: Context, seconds: number): void {
  (c.env as { timeout?: (req: Request, seconds: number) => void } | undefined)?.timeout?.(c.req.raw, seconds);
}

/** Look a connection up by the `:id` path segment; null when missing or not a number. */
export function resolveConn(id: string): ConnectionRow | null {
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return null;
  return getConnectionById(numId);
}

/** Database files the `/connections/file/*` middleware checked, by the request they came with. */
const fileRequests = new WeakMap<Request, FileConnectionRow>();

export function setRequestFileConnection(c: Context, conn: FileConnectionRow): void {
  fileRequests.set(c.req.raw, conn);
}

/**
 * The connection a data route works on: a saved one, or the database file the request names
 * (`/connections/file/…?path=`). Routes that edit, log in to or copy a connection use
 * `resolveConn` instead, which knows only saved ones.
 */
export function resolveTargetConn(c: Context): ConnectionRow | null {
  return fileRequests.get(c.req.raw) ?? resolveConn(c.req.param("id") ?? "");
}

/**
 * The adapter config for a saved connection. `readonly` comes from the row, so
 * a readonly connection is served by pools and file handles on which the
 * database itself refuses writes — every route must build its config here.
 * A connection that asks for its password gets the login held for it, and
 * throws `DbLoginRequiredError` when none is. `database`, from the request's
 * `?database=` (see `requestDatabase`), is one of the server's other databases.
 */
export function connConfig(conn: ConnectionRow, database?: string): DbConnectionConfig {
  if (isFileConnection(conn)) return fileConnectionConfig(conn);
  const config = effectiveConfig(conn);
  if (database === undefined) return { ...config, readonly: !!conn.readonly };
  const target = withDatabase(config, database);
  if (database !== ownDatabase(config)) noteOpenedDatabase(conn.id, database);
  return { ...target, readonly: !!conn.readonly };
}

export function connTarget(conn: ConnectionRow, database?: string): GridTarget {
  return { type: conn.type, adapter: getAdapter(conn.type), config: connConfig(conn, database) };
}

/**
 * The database a request names with `?database=`, or undefined for the connection's own. The
 * `/connections/:id/*` middleware has already answered 400 for a name no server can have.
 */
export function requestDatabase(c: Context): string | undefined {
  return readDatabaseParam(c.req.query("database"));
}

/** `{ database }` for an audit entry's params when the request named one; the log says where it ran. */
export function databaseParam(c: Context): { database?: string } {
  const database = requestDatabase(c);
  return database === undefined ? {} : { database };
}

/** Connection identity shared by every audit entry from these routes */
export function connAudit(conn: ConnectionRow): Pick<AuditFields, "connectionId" | "connectionName" | "dbType"> {
  // A database file is not a saved connection, so the log names it by its path.
  if (isFileConnection(conn)) return { connectionId: null, connectionName: conn.file.path, dbType: "sqlite" };
  return { connectionId: conn.id, connectionName: conn.name, dbType: conn.type };
}

/** Race a promise against a timeout — ensures routes always respond */
export function withTimeout<T>(promise: Promise<T>, ms: number, message = "Connection timed out"): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/** `ms` for a connection that goes straight to its server; longer by what its SSH tunnel may take to open. */
export function connTimeoutMs(config: DbConnectionConfig | StoredConnectionConfig, ms: number): number {
  return ms + (config.type === "sqlite" ? 0 : sshTunnelOpenBudgetMs(config.ssh as SshTunnelSettings | undefined));
}

/**
 * A 424 naming the driver `type` needs, when that driver is not installed or
 * does not load; null when the request can go ahead. The browser draws its
 * Install button from `code` and `driver`.
 */
export async function driverMissingResponse(c: Context, type: DbType, config?: StoredConnectionConfig | null): Promise<Response | null> {
  const def = driverForEngine(type);
  const missing = def ? await missingDriver(c, def.id) : null;
  if (missing) return missing;
  // The tunnel's client is a driver of its own, installed the same way.
  return config && config.type !== "sqlite" && config.ssh?.enabled ? missingDriver(c, "ssh") : null;
}

async function missingDriver(c: Context, id: DbDriverId): Promise<Response | null> {
  try {
    await loadDbDriver(id);
    return null;
  } catch (e) {
    if (!(e instanceof DbDriverMissingError)) throw e;
    const body: DbDriverMissingBody = {
      ok: false, error: e.message, code: DB_DRIVER_MISSING, driver: { id: e.driverId, displayName: e.driverName },
    };
    return c.json(body, 424);
  }
}
