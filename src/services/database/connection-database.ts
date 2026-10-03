/**
 * The other databases of a server connection. A connection's URL names one database, or none;
 * the tree lists the server's others under it, and whatever is opened from one of them reaches it
 * with `?database=` on the routes. PPM reaches another database by pointing the URL at it: in
 * Postgres a session belongs to one database, so that is a pool of its own, and in MySQL it is
 * the database the statements a tab types run in.
 *
 * A connection that uses only its own database, or whose Advanced tab lists the databases it
 * shows, is never pointed at another: `withDatabase` refuses it. The tab's regular expression is
 * not checked here — see `filterAllowedDatabases` — and none of this is a permission: SQL a person
 * types reaches whatever the login may.
 *
 * The pools a database opens are keyed by that URL, so Disconnect has to know which databases
 * were opened to close them all: `noteOpenedDatabase` records each one, `takeOpenedDatabases`
 * hands them over when the connection is closed.
 */
import { buildDbUrl, parseDbUrl } from "../../shared/db-connection-url.ts";
import type { StoredConnectionConfig } from "../../shared/db-connection-config.ts";

/** A `database` a request cannot be served for; the routes answer 400 with its message. */
export class DatabaseTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseTargetError";
  }
}

/** Far past every engine's own limit (63 bytes in Postgres, 64 characters in MySQL): only a bound. */
const MAX_DATABASE_NAME = 256;

/** The `database` query parameter as given, or undefined for none. Throws for one no server can have. */
export function readDatabaseParam(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw.length > MAX_DATABASE_NAME) throw new DatabaseTargetError("That database name is too long.");
  if (raw.includes("\u0000")) throw new DatabaseTargetError("A database name cannot contain a NUL character.");
  return raw;
}

/** The database `config`'s URL names; null for SQLite, for a URL with none, and for one PPM cannot read. */
export function ownDatabase(config: StoredConnectionConfig): string | null {
  if (config.type === "sqlite") return null;
  const parsed = parseDbUrl(config.connectionString);
  return parsed.kind === "url" && parsed.parts.database ? parsed.parts.database : null;
}

/**
 * `config` pointed at `database`. MySQL lists only that database then, as the object tree shows
 * one database at a time; the connection's own database keeps its URL byte for byte, and with it
 * its pools. Another database is refused when the connection uses only its own, or is not in the
 * connection's allowed list (by name, ignoring case, as the tree's filter reads it).
 */
export function withDatabase(config: StoredConnectionConfig, database: string): StoredConnectionConfig {
  if (config.type === "sqlite") throw new DatabaseTargetError("A SQLite connection is a single database.");
  const parsed = parseDbUrl(config.connectionString);
  if (parsed.kind !== "url") {
    throw new DatabaseTargetError("PPM cannot read this connection's URL, so it cannot open another database on it. Edit the connection.");
  }
  const own = parsed.parts.database;
  if (own && own !== database && config.singleDatabase !== false) {
    throw new DatabaseTargetError(`This connection uses only database "${own}".`);
  }
  const allowed = (config.allowedDatabases ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (own !== database && allowed.length > 0 && !allowed.includes(database.toLowerCase())) {
    throw new DatabaseTargetError(`"${database}" is not one of this connection's allowed databases.`);
  }
  const single = config.type === "postgres" ? {} : { singleDatabase: true };
  if (own === database) return { ...config, ...single };
  return { ...config, ...single, connectionString: buildDbUrl({ ...parsed.parts, database }) };
}

const opened = new Map<number, Set<string>>();

/** `database` was opened on connection `connectionId`, other than the one its URL names. */
export function noteOpenedDatabase(connectionId: number, database: string): void {
  let set = opened.get(connectionId);
  if (!set) opened.set(connectionId, (set = new Set()));
  set.add(database);
}

/** The databases opened on `connectionId`, forgotten: whoever takes them closes their pools. */
export function takeOpenedDatabases(connectionId: number): string[] {
  const set = opened.get(connectionId);
  opened.delete(connectionId);
  return set ? [...set] : [];
}

/** Test hook. */
export function _resetOpenedDatabases(): void {
  opened.clear();
}
