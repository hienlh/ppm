/**
 * A connection's config on its way in and out of `ppm.db`.
 *
 * In: what the connection form sends is checked and reduced to what is stored — the engine the
 * URL names must be the connection's, a password the form left empty on a saved connection is
 * the one already saved (`keepPassword`), and a connection that asks for its password stores none.
 *
 * Out: the edit form gets the URL rebuilt without its password, and a flag saying one is saved.
 * The password itself never goes back to the browser, and neither do the SSH password, the key
 * file's passphrase or the SSL key's password.
 *
 * A saved URL PPM cannot read (one written by hand before the form existed) is kept exactly as
 * it is for as long as nothing requires changing it.
 */
import path from "node:path";
import { buildDbUrl, dbUrlProblem, parseDbUrl, sslFlags, type DbUrlParts, type ServerDbType } from "../../shared/db-connection-url.ts";
import {
  DEFAULT_SSH_PORT, ISOLATION_LEVELS, PASSWORD_MODES, SSH_AUTH_METHODS, allowedDatabasesRegexProblem, asksForPassword,
  parseSshAddress, queryTimeoutProblem,
  type EditableConnectionConfig, type IsolationLevel, type PasswordMode, type ServerConnectionSettings, type SshAuthMethod,
  type SshTunnelSettings, type SslFileSettings, type StoredConnectionConfig,
} from "../../shared/db-connection-config.ts";
import { isDbType, type DbType } from "../../shared/db-types.ts";

/** A form field a config error belongs to, so the form can open its tab and focus it. */
export type ConnectionConfigField =
  | "type" | "path" | "connectionString" | "passwordMode" | "entry" | "singleDatabase"
  | "allowedDatabases" | "allowedDatabasesRegex" | "isolationLevel" | "queryTimeoutSec"
  | "sshEnabled" | "sshHost" | "sshPort" | "sshBastionHost" | "sshAuth" | "sshUser" | "sshPassword" | "sshKeyFile"
  | "sshPassphrase" | "sslCa" | "sslCert" | "sslKey" | "sslKeyPassword";

export class ConnectionConfigError extends Error {
  constructor(message: string, readonly field: ConnectionConfigField) {
    super(message);
    this.name = "ConnectionConfigError";
  }
}

const ENGINE: Record<ServerDbType, string> = { postgres: "PostgreSQL", mysql: "MySQL", mariadb: "MariaDB" };

/** MySQL and MariaDB read each other's URLs; Postgres reads neither. */
function sameFamily(a: ServerDbType, b: ServerDbType): boolean {
  return (a === "postgres") === (b === "postgres");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isServerConfig(config: StoredConnectionConfig | null | undefined): config is Extract<StoredConnectionConfig, { connectionString: string }> {
  return !!config && config.type !== "sqlite" && typeof (config as { connectionString?: unknown }).connectionString === "string";
}

/** The settings beside the URL, each checked; defaults are left out of what is stored. */
function readSettings(input: Record<string, unknown>): ServerConnectionSettings {
  const settings: ServerConnectionSettings = {};

  const mode = input.passwordMode;
  if (mode !== undefined && mode !== null) {
    if (!PASSWORD_MODES.includes(mode as PasswordMode)) {
      throw new ConnectionConfigError(`Password mode must be one of ${PASSWORD_MODES.join(", ")}`, "passwordMode");
    }
    if (mode !== "save") settings.passwordMode = mode as PasswordMode;
  }

  const entry = input.entry;
  if (entry !== undefined && entry !== null) {
    if (entry !== "fields" && entry !== "url") throw new ConnectionConfigError('entry must be "fields" or "url"', "entry");
    settings.entry = entry;
  }

  const single = input.singleDatabase;
  if (single !== undefined && single !== null) {
    if (typeof single !== "boolean") throw new ConnectionConfigError("singleDatabase must be true or false", "singleDatabase");
    settings.singleDatabase = single;
  }

  const allowed = input.allowedDatabases;
  if (allowed !== undefined && allowed !== null) {
    if (!Array.isArray(allowed) || allowed.some((d) => typeof d !== "string")) {
      throw new ConnectionConfigError("Allowed databases must be a list of names", "allowedDatabases");
    }
    const names = [...new Set((allowed as string[]).map((d) => d.trim()).filter(Boolean))];
    if (names.length) settings.allowedDatabases = names;
  }

  const regex = input.allowedDatabasesRegex;
  if (regex !== undefined && regex !== null) {
    if (typeof regex !== "string") throw new ConnectionConfigError("The allowed databases regular expression must be text", "allowedDatabasesRegex");
    const pattern = regex.trim();
    const problem = allowedDatabasesRegexProblem(pattern);
    if (problem) throw new ConnectionConfigError(`Allowed databases regular expression: ${problem}`, "allowedDatabasesRegex");
    if (pattern) settings.allowedDatabasesRegex = pattern;
  }

  const isolation = input.isolationLevel;
  if (isolation !== undefined && isolation !== null && isolation !== "") {
    const level = typeof isolation === "string" ? isolation.toUpperCase() : "";
    if (!ISOLATION_LEVELS.includes(level as IsolationLevel)) {
      throw new ConnectionConfigError(`Isolation level must be one of ${ISOLATION_LEVELS.join(", ")}`, "isolationLevel");
    }
    settings.isolationLevel = level as IsolationLevel;
  }

  const timeout = input.queryTimeoutSec;
  const timeoutProblem = queryTimeoutProblem(timeout);
  if (timeoutProblem) throw new ConnectionConfigError(timeoutProblem, "queryTimeoutSec");
  if (timeout !== undefined && timeout !== null && timeout !== "") settings.queryTimeoutSec = Number(timeout);

  return settings;
}

/** A path the PPM host can read without guessing: absolute, or under `~`. */
function isFullPath(file: string): boolean {
  return path.isAbsolute(file) || file === "~" || /^~[\\/]/.test(file);
}

function textField(record: Record<string, unknown>, key: string, field: ConnectionConfigField, label: string): string {
  const value = record[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ConnectionConfigError(`${label} must be text`, field);
  return value;
}

/** `check`: the path is used, so it must be one the PPM host can read without guessing. */
function pathField(record: Record<string, unknown>, key: string, field: ConnectionConfigField, label: string, check: boolean): string {
  const file = textField(record, key, field, `The ${label}`).trim();
  if (check && file && !isFullPath(file)) throw new ConnectionConfigError(`Give the ${label} as a full path on the PPM host, not ${file}.`, field);
  return file;
}

/**
 * The SSH Tunnel tab, checked. Settings typed with the box unticked are kept, as DBGate keeps
 * them, and only the secret the chosen method uses is stored. `previous` is the saved tunnel:
 * with `keep`, a secret left empty is the saved one — for the same method only.
 */
export function readSshTunnelSettings(value: unknown, previous?: SshTunnelSettings, keep = false): SshTunnelSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new ConnectionConfigError("The SSH tunnel settings must be an object", "sshEnabled");
  const enabled = value.enabled ?? false;
  if (typeof enabled !== "boolean") throw new ConnectionConfigError("Use SSH tunnel must be on or off", "sshEnabled");
  const host = textField(value, "host", "sshHost", "The SSH host").trim();
  const user = textField(value, "user", "sshUser", "The SSH login").trim();
  const bastionHost = textField(value, "bastionHost", "sshBastionHost", "The bastion host").trim();
  const password = textField(value, "password", "sshPassword", "The SSH password");
  const passphrase = textField(value, "passphrase", "sshPassphrase", "The key file passphrase");
  const keyFile = textField(value, "keyFile", "sshKeyFile", "The key file").trim();
  const auth = (value.auth ?? "password") as SshAuthMethod;
  if (!SSH_AUTH_METHODS.includes(auth)) {
    throw new ConnectionConfigError(`SSH authentication must be one of ${SSH_AUTH_METHODS.join(", ")}`, "sshAuth");
  }
  let port: number | undefined;
  const rawPort = value.port;
  if (rawPort !== undefined && rawPort !== null && rawPort !== "") {
    const n = typeof rawPort === "number" ? rawPort : typeof rawPort === "string" && /^\d{1,5}$/.test(rawPort.trim()) ? Number(rawPort) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= 65535) port = n;
    // Unticked, a port that cannot be one is dropped rather than refused: its field cannot be edited then.
    else if (enabled) throw new ConnectionConfigError("The SSH port must be a number from 1 to 65535.", "sshPort");
  }
  if (enabled) {
    if (!host) throw new ConnectionConfigError("Enter the SSH host.", "sshHost");
    if (/[\s/@]/.test(host)) throw new ConnectionConfigError("Enter the SSH host's name or address, like ssh.example.com. The login goes in its own field.", "sshHost");
    if (bastionHost) {
      const bastion = parseSshAddress(bastionHost);
      if ("error" in bastion) throw new ConnectionConfigError(bastion.error, "sshBastionHost");
    }
    if (auth === "keyFile") {
      if (!keyFile) throw new ConnectionConfigError("Pick the private key file.", "sshKeyFile");
      if (!isFullPath(keyFile)) throw new ConnectionConfigError(`Give the key file as a full path on the PPM host, not ${keyFile}.`, "sshKeyFile");
    }
  }

  const settings: SshTunnelSettings = { enabled, host, auth, user };
  if (port !== undefined && port !== DEFAULT_SSH_PORT) settings.port = port;
  if (bastionHost) settings.bastionHost = bastionHost;
  if (keyFile) settings.keyFile = keyFile;
  const sameMethod = keep && previous?.auth === auth;
  if (auth === "password") {
    const secret = password || (sameMethod ? previous?.password : undefined);
    if (secret) settings.password = secret;
  }
  if (auth === "keyFile") {
    const secret = passphrase || (sameMethod ? previous?.passphrase : undefined);
    if (secret) settings.passphrase = secret;
  }
  // Unticked with nothing typed: stored as no tunnel at all, like a connection from before the tab.
  const blank = !host && !user && !bastionHost && !keyFile && !settings.password && !settings.passphrase && port === undefined && auth === "password";
  return !enabled && blank ? undefined : settings;
}

/**
 * The SSL tab's files. Whether TLS is used, and verified, is the URL's own parameter, which the
 * tab's checkboxes write; the files are kept either way and used only with it on — `used` —
 * which is when a path is checked, as the tab's fields are only editable then.
 */
export function readSslFileSettings(value: unknown, previous?: SslFileSettings, keep = false, used = true): SslFileSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new ConnectionConfigError("The SSL settings must be an object", "sslCa");
  const ca = pathField(value, "ca", "sslCa", "CA certificate", used);
  const cert = pathField(value, "cert", "sslCert", "certificate", used);
  const key = pathField(value, "key", "sslKey", "key file", used);
  const keyPassword = textField(value, "keyPassword", "sslKeyPassword", "The certificate key file password");
  const settings: SslFileSettings = {};
  if (ca) settings.ca = ca;
  if (cert) settings.cert = cert;
  if (key) {
    settings.key = key;
    const secret = keyPassword || (keep ? previous?.keyPassword : undefined);
    if (secret) settings.keyPassword = secret;
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * What is stored for `input` on a connection of `type`. `previous` is the saved config when
 * editing: a URL left out keeps the saved URL, and `keepPassword` its password.
 */
export function normalizeConnectionConfig(
  type: DbType,
  input: unknown,
  previous?: StoredConnectionConfig | null,
): StoredConnectionConfig {
  if (!isRecord(input)) throw new ConnectionConfigError("connectionConfig must be an object", "type");
  if (input.type !== undefined && input.type !== type) {
    const named = isDbType(input.type) ? input.type : String(input.type);
    throw new ConnectionConfigError(`connectionConfig.type is "${named}" but the connection is "${type}"`, "type");
  }

  if (type === "sqlite") {
    const path = input.path;
    if (typeof path !== "string" || !path.trim()) throw new ConnectionConfigError("Choose the database file", "path");
    return { type: "sqlite", path };
  }

  const settings = readSettings(input);
  const given = input.connectionString;
  const saved = isServerConfig(previous) ? previous.connectionString : undefined;
  const keep = input.keepPassword === true;
  const savedServer = isServerConfig(previous) ? previous : undefined;
  // Left out, the saved tunnel and files stand, as a URL left out does: a client that does not
  // know the tabs must not quietly turn a tunnelled connection into a direct one.
  const ssh = "ssh" in input ? readSshTunnelSettings(input.ssh, savedServer?.ssh, keep) : savedServer?.ssh;
  if (ssh) settings.ssh = ssh;
  if (given !== undefined && given !== null && typeof given !== "string") {
    throw new ConnectionConfigError("connectionString must be text", "connectionString");
  }
  const raw = typeof given === "string" ? given : saved;
  if (raw === undefined) throw new ConnectionConfigError("Enter the server, or a database URL", "connectionString");
  const fromSaved = typeof given !== "string";

  const parsed = parseDbUrl(raw);
  if (parsed.kind === "empty") throw new ConnectionConfigError("Enter the server, or a database URL", "connectionString");
  if (parsed.kind === "file") {
    throw new ConnectionConfigError("This is a file path. Choose SQLite to open a database file.", "connectionString");
  }
  const tlsOn = parsed.kind !== "url" || sslFlags(parsed.parts).useSsl;
  const ssl = "ssl" in input ? readSslFileSettings(input.ssl, savedServer?.ssl, keep, tlsOn) : savedServer?.ssl;
  if (ssl) settings.ssl = ssl;

  const mode = settings.passwordMode;
  const keepPassword = keep;

  if (parsed.kind === "error") {
    // A string only a driver reads: kept as it is while nothing needs rewriting in it.
    if (!fromSaved) throw new ConnectionConfigError(parsed.error, "connectionString");
    if (ssh?.enabled) {
      throw new ConnectionConfigError(`PPM cannot read the saved URL (${parsed.error}) to send it through the SSH tunnel. Enter the URL again.`, "connectionString");
    }
    if (asksForPassword(mode)) {
      throw new ConnectionConfigError(`PPM cannot read the saved URL (${parsed.error}) to take its password out. Enter the URL again.`, "connectionString");
    }
    return { type, connectionString: raw, ...settings };
  }

  const parts: DbUrlParts = { ...parsed.parts };
  if (!sameFamily(parts.type, type)) {
    throw new ConnectionConfigError(`This is a ${ENGINE[parts.type]} URL, and the connection is ${ENGINE[type]}.`, "connectionString");
  }
  if (!fromSaved) {
    const problem = dbUrlProblem(parts);
    if (problem) throw new ConnectionConfigError(problem, "connectionString");
    const own = parts.params.find(([name]) => name.toLowerCase().startsWith("ppm-"));
    if (own) throw new ConnectionConfigError(`${own[0]} is a parameter PPM adds itself. Take it out of the URL.`, "connectionString");
  }
  if (ssh?.enabled && parts.socket) {
    throw new ConnectionConfigError(
      "An SSH tunnel reaches the database by host and port. Enter the host as the SSH server sees it (often localhost), or turn the tunnel off.",
      "connectionString",
    );
  }

  let changed = false;
  // A saved URL PPM cannot read has no password to take out of it: a new URL replaces it whole,
  // as the form says it will. `keepPassword` still keeps the tunnel's and the key's secrets.
  if (keepPassword && !fromSaved && !parts.password && !asksForPassword(mode) && saved !== undefined) {
    const before = parseDbUrl(saved);
    if (before.kind === "url" && before.parts.password) {
      parts.password = before.parts.password;
      changed = true;
    }
  }
  if (asksForPassword(mode) && parts.password) {
    parts.password = "";
    changed = true;
  }
  if (mode === "askUser" && parts.user) {
    parts.user = "";
    changed = true;
  }

  return { type, connectionString: changed ? buildDbUrl(parts) : raw.trim(), ...settings };
}

/** The settings of a stored server config, without its URL. */
export function connectionSettings(config: StoredConnectionConfig): ServerConnectionSettings {
  if (config.type === "sqlite") return {};
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { type: _t, connectionString: _c, ...settings } = config as Extract<StoredConnectionConfig, { connectionString: string }>;
  return settings;
}

/** A stored config as the edit form may see it: no password or passphrase anywhere in it. */
export function editableConfig(config: StoredConnectionConfig): EditableConnectionConfig {
  if (config.type === "sqlite") return { type: "sqlite", path: (config as { path: string }).path };
  const parsed = parseDbUrl(config.connectionString);
  const { ssh, ssl, ...settings } = connectionSettings(config);
  const extras: Pick<Extract<EditableConnectionConfig, { hasPassword: boolean }>, "ssh" | "ssl"> = {};
  if (ssh) {
    const { password, passphrase, ...rest } = ssh;
    extras.ssh = { ...rest, hasPassword: !!password, hasPassphrase: !!passphrase };
  }
  if (ssl) {
    const { keyPassword, ...rest } = ssl;
    extras.ssl = { ...rest, hasKeyPassword: !!keyPassword };
  }
  if (parsed.kind !== "url") return { type: config.type, connectionString: null, hasPassword: false, ...settings, ...extras };
  return {
    type: config.type,
    connectionString: buildDbUrl(parsed.parts, { password: false }),
    hasPassword: !!parsed.parts.password,
    ...settings,
    ...extras,
  };
}

/** The login typed into Database Log In, for a connection that asks for it. */
export interface DbLogin {
  user?: string;
  password?: string;
}

/**
 * `config` with a typed login in it. A connection that asks for its password only takes the
 * password: its user is part of what was saved, and the dialog shows it locked.
 */
export function withLogin(config: StoredConnectionConfig, login: DbLogin): StoredConnectionConfig {
  if (config.type === "sqlite") return config;
  const parsed = parseDbUrl(config.connectionString);
  if (parsed.kind !== "url") throw new ConnectionConfigError("PPM cannot read the saved URL to log in with it.", "connectionString");
  const parts = { ...parsed.parts, password: login.password ?? "" };
  if (config.passwordMode === "askUser") parts.user = login.user?.trim() ?? "";
  return { ...config, connectionString: buildDbUrl(parts) };
}

/** Who a connection logs in as, as far as the saved config says: shown by Database Log In. */
export function savedLoginUser(config: StoredConnectionConfig): string {
  if (config.type === "sqlite") return "";
  const parsed = parseDbUrl(config.connectionString);
  return parsed.kind === "url" ? parsed.parts.user : "";
}
