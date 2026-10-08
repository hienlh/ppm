import { decryptConfig, type ConnectionRow } from "../db.service.ts";
import { DatabaseTargetError, readDatabaseParam, withDatabase } from "../database/connection-database.ts";
import { missingLogin } from "../database/connection-login.ts";
import { driverForEngine } from "../database/drivers/db-driver-catalog.ts";
import { DbDriverMissingError, loadDbDriver } from "../database/drivers/db-driver-loader.ts";
import { connConfig } from "../../server/routes/database-route-helpers.ts";
import type { StoredConnectionConfig } from "../../shared/db-connection-config.ts";
import type { DbConnectionConfig } from "../../types/database.ts";

/**
 * Where a database tool's SQL runs: the connection's own database or another on its server
 * (checked as the CONNECTIONS tree checks one), with its driver loaded and its login held.
 */

/** The `database` argument, checked the way `?database=` is for the CONNECTIONS tree. */
export function aiDatabaseArg(conn: ConnectionRow, raw: unknown): { ok: true; database?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true };
  if (typeof raw !== "string") return { ok: false, error: "`database` must be a database name." };
  try {
    const database = readDatabaseParam(raw);
    if (database !== undefined) withDatabase(decryptConfig(conn.connection_config), database);
    return { ok: true, ...(database !== undefined ? { database } : {}) };
  } catch (e) {
    if (e instanceof DatabaseTargetError) return { ok: false, error: e.message };
    throw e;
  }
}

async function ensureDrivers(conn: ConnectionRow, saved: StoredConnectionConfig): Promise<void> {
  const ids = [driverForEngine(conn.type)?.id, saved.type !== "sqlite" && saved.ssh?.enabled ? "ssh" as const : undefined];
  for (const id of ids) {
    if (!id) continue;
    try {
      await loadDbDriver(id);
    } catch (e) {
      if (e instanceof DbDriverMissingError) {
        throw new Error(`${e.message} Ask the user to install it from Settings → Database Drivers in PPM.`);
      }
      throw e;
    }
  }
}

/**
 * The adapter config the tools open `conn` with: `readonly` is the tool's, not the row's —
 * `db_query` always reads inside a read-only transaction, and `db_execute` writes only once the
 * user approved it. Throws an `Error` whose message is for the AI.
 */
export async function aiTargetConfig(conn: ConnectionRow, database: string | undefined, readonly: boolean): Promise<DbConnectionConfig> {
  const saved = decryptConfig(conn.connection_config);
  await ensureDrivers(conn, saved);
  if (missingLogin(conn)) {
    throw new Error(
      `Connection "${conn.name}" asks for its password, and nobody has logged in to it since PPM started. `
      + "Ask the user to open it in PPM's Database panel and log in, then call again.",
    );
  }
  return { ...connConfig(conn, database), readonly };
}
