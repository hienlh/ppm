import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { EditableConnectionConfig } from "../../shared/db-connection-config.ts";
import { hasPassword, redactUrl } from "../../shared/db-url-secret.ts";
import type { ServerDbType } from "../../shared/db-connection-url.ts";
import type { DbType } from "../../shared/db-types.ts";
import { ConnectionConfigError, normalizeConnectionConfig } from "../database/connection-config.ts";
import { sqlitePathRefusal, sqliteRealPath } from "../database/sqlite-path-guard.ts";
import type { ListedConnection } from "./assistant-approval-summary-db-connection.ts";
import type { ToolContext } from "./assistant-tool-family.ts";

/**
 * What the connection tools share: reading the list and one connection's password-free config
 * through PPM's routes, and the checks an argument goes through before any card. A connection the
 * user made unavailable to the AI chat (`ai_access = 0`) is one these tools neither see nor touch.
 */

export interface DbConnectionToolDeps {
  /** The registered projects' folders: a SQLite file inside one is the user's to have the AI open. */
  projectRoots: () => readonly string[];
  /** Replace the home folder and the private stores, for tests. */
  home?: string;
  privateRoots?: readonly string[];
  /** The clock the test limit counts with. */
  now?: () => number;
}

export type Listed = ListedConnection & { ai_access?: number; color?: string | null; password_mode?: string; logged_in?: boolean };

const base = "/api/db/connections";
export const connectionPath = (id: number, sub = ""): string => `${base}/${id}${sub}`;

export async function listConnections(ctx: ToolContext): Promise<Listed[] | string> {
  const r = await ctx.callRoute<Listed[]>("GET", base);
  return r.ok && Array.isArray(r.data) ? r.data : `Could not read the connections: ${r.error ?? `PPM answered ${r.status}`}`;
}

export async function readEditable(ctx: ToolContext, id: number): Promise<EditableConnectionConfig | string> {
  const r = await ctx.callRoute<EditableConnectionConfig>("GET", connectionPath(id, "/config"));
  return r.ok && r.data ? r.data : `Could not read the connection's settings: ${r.error ?? `PPM answered ${r.status}`}`;
}

/** A connection id as `db_list_connections` gives it: a whole number, or its digits. */
export function connectionIdArg(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d{1,15}$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** The listed connection `id` names when it is available to the AI chat; otherwise why not. */
export function availableConnection(list: Listed[], idArg: unknown): { ok: true; conn: Listed } | { ok: false; error: string } {
  const id = connectionIdArg(idArg);
  if (id === null) return { ok: false, error: "`id` must be a connection id from db_list_connections." };
  const conn = list.find((c) => c.id === id);
  if (!conn) return { ok: false, error: `No saved connection has the id ${id}. Call db_list_connections for the list.` };
  if (conn.ai_access === 0) {
    return { ok: false, error: `Connection #${id} is not available to the AI chat; the user changes it in PPM themselves.` };
  }
  return { ok: true, conn };
}

export function nameProblem(name: string, list: Listed[], exceptId?: number): string | null {
  if (!name || name.length > 100 || /\p{Cc}/u.test(name)) return "`name` must be 1-100 characters with no control characters.";
  return list.some((c) => c.name === name && c.id !== exceptId) ? `A connection is already named "${name}".` : null;
}

/** Why `url` cannot be saved for a `type` connection from the Assistant, or null. */
export function urlProblem(type: ServerDbType, url: string): string | null {
  if (hasPassword(url)) {
    return "The URL holds a password, which the Assistant never handles. Give the URL without it: the user types the "
      + "password in PPM (the connection's form), or pass `passwordMode: \"ask\"` so PPM asks for it each time it opens.";
  }
  try {
    normalizeConnectionConfig(type, { type, connectionString: url });
    return null;
  } catch (e) {
    if (e instanceof ConnectionConfigError) return e.message;
    throw e;
  }
}

/** A SQLite file the Assistant may save: its real path, or why not. */
export function checkSqliteFile(file: string, deps: DbConnectionToolDeps): { ok: true; real: string } | { ok: false; error: string } {
  if (!isAbsolute(file.trim())) return { ok: false, error: "`file` must be the database file's full path." };
  const refusal = sqlitePathRefusal(file, {
    aiTool: { projectRoots: deps.projectRoots(), ...(deps.home ? { home: deps.home } : {}), ...(deps.privateRoots ? { roots: deps.privateRoots } : {}) },
    ...(deps.home ? { home: deps.home } : {}),
  });
  if (refusal) return { ok: false, error: refusal };
  const real = sqliteRealPath(file, deps.home);
  let isFile = false;
  try { isFile = existsSync(real) && statSync(real).isFile(); } catch { /* answered below */ }
  return isFile ? { ok: true, real } : { ok: false, error: `There is no database file at ${real}.` };
}

const HEX_COLOR = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

/** `group` and `color` as the routes take them; `undefined` leaves them, `null` clears them. */
export function decorArgs(args: Record<string, unknown>): { folder?: string | null; color?: string | null } | string {
  const out: { folder?: string | null; color?: string | null } = {};
  if (args.group !== undefined) {
    if (args.group === null || args.group === "") out.folder = null;
    else if (typeof args.group === "string" && args.group.trim().length <= 100 && !/\p{Cc}/u.test(args.group)) out.folder = args.group.trim() || null;
    else return "`group` must be a folder name of at most 100 characters, or null for none.";
  }
  if (args.color !== undefined) {
    if (args.color === null) out.color = null;
    else if (typeof args.color === "string" && HEX_COLOR.test(args.color)) out.color = args.color.toLowerCase();
    else return "`color` must be #rgb or #rrggbb, or null to clear it.";
  }
  return out;
}

export interface SaveTarget {
  /** As sent to the route. */
  connectionString?: string;
  path?: string;
  /** As the card shows it. */
  shown: { url?: string; file?: string };
}

/** The `url` or `file` a `type` connection takes, checked; null when neither is given. */
export function targetArg(type: DbType, args: Record<string, unknown>, deps: DbConnectionToolDeps): SaveTarget | null | string {
  if (type === "sqlite") {
    if (args.url !== undefined) return "A SQLite connection takes `file`, not `url`.";
    if (args.file === undefined) return null;
    if (typeof args.file !== "string") return "`file` must be the database file's full path.";
    const checked = checkSqliteFile(args.file, deps);
    // The real path is what is saved, so the file opened later is the one the card showed.
    return checked.ok ? { path: checked.real, shown: { file: checked.real } } : checked.error;
  }
  if (args.file !== undefined) return `A ${type} connection takes \`url\`, not \`file\`.`;
  if (args.url === undefined) return null;
  if (typeof args.url !== "string" || !args.url.trim()) return "`url` must be the server's URL, like postgres://user@host:5432/db.";
  const problem = urlProblem(type, args.url.trim());
  return problem ?? { connectionString: args.url.trim(), shown: { url: redactUrl(args.url) } };
}

/** "save" or "ask" (`undefined` when not given); a string for anything else. */
export function passwordModeArg(value: unknown): "save" | "ask" | undefined | { error: string } {
  if (value === undefined) return undefined;
  return value === "save" || value === "ask" ? value : { error: "`passwordMode` must be \"save\" or \"ask\"." };
}
