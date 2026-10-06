/**
 * Logins for connections that ask for their password each time they are opened.
 *
 * What Database Log In is given is held in this process's memory, keyed by connection id, until
 * Disconnect, an edit or deletion of the connection, or PPM restarting. It is never written to
 * disk and never sent back to a browser. DBGate differs here on purpose: it forgets the login
 * when the page reloads, and sends the typed password back to the browser with the edit form.
 *
 * Every route that opens a saved connection builds its config through `effectiveConfig`, which
 * adds the held login — or throws `DbLoginRequiredError` when there is none, so the browser can
 * open Database Log In and retry.
 */
import { decryptConfig, type ConnectionRow } from "../db.service.ts";
import { getAdapter } from "./adapter-registry.ts";
import { savedLoginUser, withLogin, type DbLogin } from "./connection-config.ts";
import { takeOpenedDatabases, withDatabase } from "./connection-database.ts";
import type { EndpointConfig } from "./connection-endpoint.ts";
import {
  DB_LOGIN_REQUIRED, asksForPassword, type DbLoginPrompt, type DbLoginRequiredBody, type StoredConnectionConfig,
} from "../../shared/db-connection-config.ts";
import type { DbType } from "../../shared/db-types.ts";
import type { DbConnectionConfig } from "../../types/database.ts";

const held = new Map<number, DbLogin>();

export class DbLoginRequiredError extends Error {
  constructor(readonly prompt: DbLoginPrompt) {
    super(`Log in to ${prompt.name || "this connection"} to open it`);
    this.name = "DbLoginRequiredError";
  }
}

/** Whether a stored config asks for its password (or its whole login) instead of saving it. */
export function asksForLogin(config: StoredConnectionConfig): boolean {
  return config.type !== "sqlite" && asksForPassword(config.passwordMode);
}

/** What Database Log In shows for `conn`; an `id` of null is a connection the form has not saved. */
export function loginPrompt(conn: { id: number | null; name: string; type: DbType }, config: StoredConnectionConfig): DbLoginPrompt {
  const askUser = config.type !== "sqlite" && config.passwordMode === "askUser";
  return { connectionId: conn.id, name: conn.name, type: conn.type, user: askUser ? "" : savedLoginUser(config), askUser };
}

export function loginRequiredBody(e: DbLoginRequiredError): DbLoginRequiredBody {
  return { ok: false, code: DB_LOGIN_REQUIRED, error: e.message, login: e.prompt };
}

export function hasHeldLogin(connectionId: number): boolean {
  return held.has(connectionId);
}

/**
 * `config` as `conn`'s own: its pools and SSH tunnel are keyed by the connection too, so a
 * Duplicate with the same settings never shares them, and closing one leaves the other's open.
 */
function ownedBy(conn: ConnectionRow, config: StoredConnectionConfig): StoredConnectionConfig {
  if (config.type === "sqlite") return config;
  const owned: EndpointConfig = { ...config, connectionId: conn.id };
  return owned;
}

/**
 * The config a saved connection opens with. For one that asks for its password, the saved
 * config plus the held login; throws `DbLoginRequiredError` when nothing is held.
 */
export function effectiveConfig(conn: ConnectionRow): StoredConnectionConfig {
  const config = ownedBy(conn, decryptConfig(conn.connection_config));
  if (!asksForLogin(config)) return config;
  const login = held.get(conn.id);
  if (!login) throw new DbLoginRequiredError(loginPrompt(conn, config));
  return withLogin(config, login);
}

/** A 428-worthy check for routes: null when the connection can be opened as it stands. */
export function missingLogin(conn: ConnectionRow): DbLoginRequiredError | null {
  const config = decryptConfig(conn.connection_config);
  if (!asksForLogin(config) || held.has(conn.id)) return null;
  return new DbLoginRequiredError(loginPrompt(conn, config));
}

/**
 * Close the pools `config` opened, readonly or not: its own database's and those of every other
 * database the tree opened on the connection.
 */
async function closeEveryDatabase(conn: ConnectionRow, saved: StoredConnectionConfig): Promise<void> {
  const adapter = getAdapter(conn.type);
  const config = ownedBy(conn, saved);
  const configs: StoredConnectionConfig[] = [config];
  for (const database of takeOpenedDatabases(conn.id)) {
    try {
      configs.push(withDatabase(config, database));
    } catch { /* a database that could not be opened left no pool */ }
  }
  await Promise.all(configs.map((c) => adapter.close(c as DbConnectionConfig).catch(() => {})));
}

/** Close the pools the held login opened. */
async function closePools(conn: ConnectionRow, login: DbLogin): Promise<void> {
  try {
    await closeEveryDatabase(conn, withLogin(decryptConfig(conn.connection_config), login));
  } catch { /* an unreadable config opened no pools */ }
}

/** Hold `login` for `conn`, closing whatever an earlier login had open. */
export async function holdLogin(conn: ConnectionRow, login: DbLogin): Promise<void> {
  const before = held.get(conn.id);
  held.set(conn.id, { user: login.user, password: login.password });
  if (before && (before.user !== login.user || before.password !== login.password)) await closePools(conn, before);
}

/**
 * Forget the held login for `conn` and close the pools it opened. For an edit or a deletion,
 * `conn` is the row from before the change: its config is what the pools were opened with.
 */
export async function forgetLogin(conn: ConnectionRow): Promise<boolean> {
  const login = held.get(conn.id);
  if (!login) return false;
  held.delete(conn.id);
  await closePools(conn, login);
  return true;
}

/**
 * Close whatever `conn` has open — its pools and its SSH tunnel — whether it opened them with the
 * saved password or a held login, and forget that login unless `keepLogin` (a reconnect). For an
 * edit or a deletion, `conn` is the row from before the change.
 */
export async function closeConnection(conn: ConnectionRow, options: { keepLogin?: boolean } = {}): Promise<void> {
  const login = held.get(conn.id);
  if (login && options.keepLogin) {
    await closePools(conn, login);
    return;
  }
  if (await forgetLogin(conn)) return;
  try {
    const config = decryptConfig(conn.connection_config);
    if (!asksForLogin(config)) await closeEveryDatabase(conn, config);
  } catch { /* a config that cannot be read opened nothing */ }
}

/** Test hook: every held login dropped, nothing closed. */
export function _clearHeldLogins(): void {
  held.clear();
}
