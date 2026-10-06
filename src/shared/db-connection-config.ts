/**
 * What a saved connection keeps, shared by the server, the connection form and the CLI.
 *
 * A server connection is still stored as its URL, the one thing every service connects with,
 * and a connection saved before the form existed has nothing else. What the form adds sits
 * beside the URL, each field optional, so an absent field means what it always meant.
 */
import type { ServerDbType } from "./db-connection-url.ts";
import type { DbType } from "./db-types.ts";

export const PASSWORD_MODES = ["save", "askPassword", "askUser"] as const;
/**
 * `save` keeps the password, encrypted. The two ask modes keep none (`askUser` no login either):
 * PPM asks when the connection opens and holds the answer in the server's memory until
 * Disconnect or a restart.
 */
export type PasswordMode = (typeof PASSWORD_MODES)[number];

export function asksForPassword(mode: PasswordMode | undefined): boolean {
  return mode === "askPassword" || mode === "askUser";
}

export const ISOLATION_LEVELS = ["READ UNCOMMITTED", "READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];
/** What each server runs a transaction at when nothing says otherwise. */
export const DEFAULT_ISOLATION: Record<ServerDbType, IsolationLevel> = {
  postgres: "READ COMMITTED",
  mysql: "REPEATABLE READ",
  mariadb: "REPEATABLE READ",
};

export const SSH_AUTH_METHODS = ["password", "agent", "keyFile"] as const;
export type SshAuthMethod = (typeof SSH_AUTH_METHODS)[number];
export const DEFAULT_SSH_PORT = 22;

/**
 * The SSH Tunnel tab. The tunnel opens from the PPM host; the database's host and port in the URL
 * are then as the SSH server sees them. With a bastion, PPM reaches the SSH host through it, using
 * the same login for both, as DBGate does.
 */
export type SshTunnelSettings = {
  /** Unticked keeps what was typed, and the connection goes straight to the server. */
  enabled: boolean;
  host: string;
  /** Absent: 22. */
  port?: number;
  /** `[user@]host[:port]`, reached first. */
  bastionHost?: string;
  auth: SshAuthMethod;
  /** Empty: the user PPM runs as, as `ssh` does. */
  user: string;
  /** `password` only. Encrypted with the rest of the config, never sent back to a browser. */
  password?: string;
  /** `keyFile` only: a path on the PPM host, read each time the tunnel opens. */
  keyFile?: string;
  /** `keyFile` only; encrypted like the password. */
  passphrase?: string;
};

/**
 * The SSL tab's files: paths on the PPM host, read each time a connection opens, so a certificate
 * replaced on disk needs no edit. Whether TLS is used at all, and verified, is the URL's `sslmode`
 * (`ssl-mode` for MySQL), which the tab's two checkboxes write.
 */
export type SslFileSettings = {
  ca?: string;
  cert?: string;
  key?: string;
  /** The key's passphrase. Encrypted, never sent back to a browser. */
  keyPassword?: string;
};

/** A bastion as the field is filled in, `[user@]host[:port]`; `error` says what cannot be read. */
export function parseSshAddress(text: string): { user: string; host: string; port: number } | { error: string } {
  const s = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return { error: "Write the bastion as host or user@host:port, without ssh://." };
  const at = s.lastIndexOf("@");
  const user = at >= 0 ? s.slice(0, at) : "";
  const rest = at >= 0 ? s.slice(at + 1) : s;
  let host = rest;
  let portText: string | null = null;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0 || (rest.length > close + 1 && rest[close + 1] !== ":")) return { error: "Write an IPv6 address in brackets, like [::1]:22." };
    host = rest.slice(1, close);
    if (rest.length > close + 1) portText = rest.slice(close + 2);
  } else {
    const colon = rest.indexOf(":");
    if (colon >= 0) {
      if (rest.indexOf(":", colon + 1) >= 0) return { error: "Write an IPv6 address in brackets, like [::1]:22." };
      host = rest.slice(0, colon);
      portText = rest.slice(colon + 1);
    }
  }
  if (!host || /[\s/]/.test(host)) return { error: "Enter the bastion's host name, like jump.example.com or deploy@jump.example.com:22." };
  let port = DEFAULT_SSH_PORT;
  if (portText !== null) {
    const n = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
    if (!(n >= 1 && n <= 65535)) return { error: "The bastion's port must be a number from 1 to 65535." };
    port = n;
  }
  return { user, host, port };
}

/** What the edit form is sent of the SSH tab: the secrets taken out, and whether each is saved. */
export type EditableSshTunnelSettings = Omit<SshTunnelSettings, "password" | "passphrase"> & {
  hasPassword: boolean;
  hasPassphrase: boolean;
};

export type EditableSslFileSettings = Omit<SslFileSettings, "keyPassword"> & { hasKeyPassword: boolean };

/** A type, not an interface: a stored config is handed to adapters, which take any extra keys. */
export type ServerConnectionSettings = {
  /** Absent: `save`. */
  passwordMode?: PasswordMode;
  /** How the form shows the connection: the fields, or the URL it was pasted as. Absent: `url`. */
  entry?: "fields" | "url";
  /** With a default database: show it alone (true, and the default) or among the server's others. */
  singleDatabase?: boolean;
  /** The databases the tree and the ▾ list show, by name, ignoring case. Empty: every one the user can see. */
  allowedDatabases?: string[];
  /** Also required to match, ignoring case. */
  allowedDatabasesRegex?: string;
  /** The transaction Save runs in. Absent: the server's default. */
  isolationLevel?: IsolationLevel;
  /** Whole seconds one statement of a Query tab run may take before it is cancelled. Absent: no limit. */
  queryTimeoutSec?: number;
  /** Absent: no tunnel, as for every connection saved before the tab existed. */
  ssh?: SshTunnelSettings;
  ssl?: SslFileSettings;
};

export type StoredConnectionConfig =
  | { type: "sqlite"; path: string }
  | ({ type: ServerDbType; connectionString: string } & ServerConnectionSettings);

/** What the edit form is sent: the saved config with every password taken out. */
export type EditableConnectionConfig =
  | { type: "sqlite"; path: string }
  | ({
    type: ServerDbType;
    /** The URL without its password; null when PPM cannot read the saved one (it is kept unless replaced). */
    connectionString: string | null;
    /** A password is saved, so an empty Password field keeps it. */
    hasPassword: boolean;
    ssh?: EditableSshTunnelSettings;
    ssl?: EditableSslFileSettings;
  } & Omit<ServerConnectionSettings, "ssh" | "ssl">);

/** One SSH server a tunnel went through, with the host key it showed. */
export interface SshHop {
  /** `bastion.example.com:22`. */
  host: string;
  /** `SHA256:…`, as `ssh-keygen -l` prints it. */
  fingerprint: string;
  /** PPM had not seen this host before and has now recorded its key. */
  firstSeen: boolean;
}

export interface DbTestSuccess {
  ok: true;
  /** `PostgreSQL 17.2`, `MariaDB 11.8.9`. */
  version: string;
  /**
   * Every database the login can open; empty for SQLite. The form applies the allowed-databases
   * filter itself, so the ▾ list follows a filter still being typed.
   */
  databases: string[];
  /** `localhost:5432`, `socket /run/mysqld/mysqld.sock`, or the file. */
  target: string;
  /** The SSH servers the connection went through, bastion first; absent without a tunnel. */
  ssh?: SshHop[];
  /** The TLS version the connection used (`TLSv1.3`), null in plain text; absent when the server did not say. */
  tls?: string | null;
  elapsedMs: number;
}

export interface DbTestFailure {
  ok: false;
  /** The driver's own words. */
  error: string;
  /** Code, target, login and where it was checked from: what Details shows. */
  details: string;
  elapsedMs: number;
}

export type DbTestResult = DbTestSuccess | DbTestFailure;

/** The longest query timeout a connection takes: a day. */
export const MAX_QUERY_TIMEOUT_SEC = 86_400;

/** Why a query timeout, as typed or sent, cannot be used, or null. Empty is no limit. */
export function queryTimeoutProblem(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const seconds = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  if (typeof seconds === "number" && Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_QUERY_TIMEOUT_SEC) return null;
  return `The query timeout is a whole number of seconds from 1 to ${MAX_QUERY_TIMEOUT_SEC}, or empty for no limit`;
}

/** Why a regex cannot be used, or null. */
export function allowedDatabasesRegexProblem(pattern: string | undefined): string | null {
  if (!pattern) return null;
  try {
    new RegExp(pattern, "i");
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * The databases a connection shows: in the list when there is one, matching the regex when there
 * is one, both ignoring case as DBGate does. The server also refuses to open a database outside
 * the list (`withDatabase`), but never runs the regex. Not a permission either way — what a login
 * may reach is the database's business.
 *
 * Run in the browser only. A pattern is the user's own text, and one that backtracks
 * catastrophically would stall whatever runs it: a tab can take that, the server that every
 * chat session lives in cannot.
 */
export function filterAllowedDatabases(
  names: readonly string[],
  settings: Pick<ServerConnectionSettings, "allowedDatabases" | "allowedDatabasesRegex">,
): string[] {
  const only = new Set((settings.allowedDatabases ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean));
  let re: RegExp | null = null;
  if (settings.allowedDatabasesRegex && !allowedDatabasesRegexProblem(settings.allowedDatabasesRegex)) {
    re = new RegExp(settings.allowedDatabasesRegex, "i");
  }
  return names.filter((name) => (only.size === 0 || only.has(name.toLowerCase())) && (!re || re.test(name)));
}

export const DB_LOGIN_REQUIRED = "DB_LOGIN_REQUIRED";

/** What Database Log In needs to ask for a login. */
export interface DbLoginPrompt {
  /** Null for a connection the form has not saved yet. */
  connectionId: number | null;
  name: string;
  type: DbType;
  /** The saved user, shown locked; empty when the connection asks for it too. */
  user: string;
  askUser: boolean;
}

/**
 * The 428 body for a connection that asks for its password and has no login held for it. Not a
 * 401: the browser reads a 401 as PPM's own session having ended, and signs out.
 */
export interface DbLoginRequiredBody {
  ok: false;
  error: string;
  code: typeof DB_LOGIN_REQUIRED;
  login: DbLoginPrompt;
}
