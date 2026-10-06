/**
 * The connection form's model, apart from React so it can be tested on its own.
 *
 * The form holds what the person typed, field by field, and turns it into what the server takes
 * only when it is sent: a URL for a server, a path for SQLite, and the settings beside them. The
 * two ways of entering a server — the fields, or one URL — are two views of the same connection,
 * so switching between them builds one from the other and loses nothing; what a URL says that no
 * field shows (its scheme as written, its TLS parameter, the rest of its query) is carried along.
 *
 * Nothing here imports a store: the stores read `localStorage` when they load, which a test
 * process does not have.
 */
import {
  DEFAULT_PORT, DEFAULT_USER, URL_SCHEME, buildDbUrl, dbUrlProblem, dbUrlTarget, describeDbUrl, parseDbUrl, sslFlags,
  withSslFlags, type DbUrlParse, type DbUrlParts, type ServerDbType,
} from "../../../../shared/db-connection-url";
import {
  allowedDatabasesRegexProblem, asksForPassword, filterAllowedDatabases, parseSshAddress, queryTimeoutProblem,
  type DbTestSuccess, type EditableConnectionConfig, type IsolationLevel, type PasswordMode, type SshAuthMethod,
} from "../../../../shared/db-connection-config";
import { DB_TYPE_LABELS, type DbType } from "../../../../shared/db-types";
import type { Connection } from "../use-connections";

/** DBGate's sub-tabs, in its order. */
export type FormTab = "general" | "ssh" | "ssl" | "advanced";
export const FORM_TABS: readonly FormTab[] = ["general", "ssh", "ssl", "advanced"];
export const FORM_TAB_LABELS: Record<FormTab, string> = { general: "General", ssh: "SSH Tunnel", ssl: "SSL", advanced: "Advanced" };

/** SQLite has nothing but a file to set. */
export function tabsFor(type: DbType): readonly FormTab[] {
  return type === "sqlite" ? ["general"] : FORM_TABS;
}

export interface ConnectionFormValues {
  type: DbType;
  entry: "fields" | "url";
  url: string;
  connMode: "host" | "socket";
  host: string;
  port: string;
  socket: string;
  user: string;
  password: string;
  passwordMode: PasswordMode;
  database: string;
  singleDatabase: boolean;
  /** SQLite's file. */
  path: string;
  readonly: boolean;
  aiAccess: boolean;
  name: string;
  folder: string;
  color: string | null;
  /** One name per line, as the textarea holds it. */
  allowedDatabases: string;
  allowedDatabasesRegex: string;
  /** Empty: the server's default. */
  isolationLevel: IsolationLevel | "";
  /** Whole seconds, as typed. Empty: no limit. */
  queryTimeoutSec: string;
  /** What the last URL read into the fields said that no field shows, so the fields keep it. */
  urlExtras: Pick<DbUrlParts, "scheme" | "ssl" | "params"> | null;
  /** SSH Tunnel. Unticked, what was typed is kept and not used. */
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshBastionHost: string;
  sshAuth: SshAuthMethod;
  sshUser: string;
  sshPassword: string;
  sshKeyFile: string;
  sshPassphrase: string;
  /**
   * SSL's files. Its two checkboxes are not here: they are the URL's TLS parameter, which the URL
   * box holds, or `urlExtras.ssl` for the fields (see `sslChecks`).
   */
  sslCa: string;
  sslCert: string;
  sslKey: string;
  sslKeyPassword: string;
}

/** What the form knows about the connection it edits, beyond the values it shows. */
export interface EditingInfo {
  id: number;
  /** A password is saved: an empty Password field keeps it. */
  passwordSaved: boolean;
  /** PPM cannot read the saved URL, so none is shown; an empty URL box keeps it. */
  savedUrlUnreadable: boolean;
  /** The SSH password is saved: an empty field keeps it while the method stays Username & password. */
  sshPasswordSaved: boolean;
  /** The key file's passphrase is saved: an empty field keeps it while the method stays Key file. */
  sshPassphraseSaved: boolean;
  /** The SSL key file's password is saved: an empty field keeps it while there is a key file. */
  sslKeyPasswordSaved: boolean;
}

export interface FormContext {
  /** Null for a new connection. */
  editing: EditingInfo | null;
  /** The names of every other saved connection. */
  takenNames: ReadonlySet<string>;
}

/** A field the form can point at when something is wrong with it. */
export type FormField =
  | "type" | "url" | "host" | "port" | "socket" | "user" | "password" | "passwordMode" | "database"
  | "path" | "name" | "allowedDatabases" | "allowedDatabasesRegex" | "isolationLevel" | "queryTimeoutSec"
  | "sshEnabled" | "sshHost" | "sshPort" | "sshBastionHost" | "sshAuth" | "sshUser" | "sshPassword" | "sshKeyFile"
  | "sshPassphrase" | "sslCa" | "sslCert" | "sslKey" | "sslKeyPassword";

const SSH_FIELDS: readonly FormField[] = [
  "sshEnabled", "sshHost", "sshPort", "sshBastionHost", "sshAuth", "sshUser", "sshPassword", "sshKeyFile", "sshPassphrase",
];
const SSL_FIELDS: readonly FormField[] = ["sslCa", "sslCert", "sslKey", "sslKeyPassword"];
const ADVANCED_FIELDS: readonly FormField[] = ["allowedDatabases", "allowedDatabasesRegex", "isolationLevel", "queryTimeoutSec"];

/** The sub-tab a field is on, so a problem with it can open that tab first. */
export function tabOfField(field: FormField): FormTab {
  if (SSH_FIELDS.includes(field)) return "ssh";
  if (SSL_FIELDS.includes(field)) return "ssl";
  return ADVANCED_FIELDS.includes(field) ? "advanced" : "general";
}

export interface FormProblem {
  field: FormField;
  message: string;
}

const isServer = (type: DbType): type is ServerDbType => type !== "sqlite";
/** MySQL and MariaDB read each other's URLs; Postgres reads neither — the server's own rule. */
const sameFamily = (a: ServerDbType, b: ServerDbType) => (a === "postgres") === (b === "postgres");

/** The password mode that applies. It is one of the fields: a URL carries its own login, as in DBGate. */
export function effectivePasswordMode(values: ConnectionFormValues): PasswordMode {
  return isServer(values.type) && values.entry === "fields" ? values.passwordMode : "save";
}

/** PPM is to ask for the password when the connection opens, so Test and Connect ask for it first. */
export function formAsksForLogin(values: ConnectionFormValues): boolean {
  return asksForPassword(effectivePasswordMode(values));
}

export function emptyForm(type: DbType = "postgres"): ConnectionFormValues {
  return {
    type,
    entry: "fields",
    url: "",
    connMode: "host",
    host: "",
    port: "",
    socket: "",
    user: "",
    password: "",
    passwordMode: "save",
    database: "",
    singleDatabase: true,
    path: "",
    readonly: true,
    aiAccess: true,
    name: "",
    folder: "",
    color: null,
    allowedDatabases: "",
    allowedDatabasesRegex: "",
    isolationLevel: "",
    queryTimeoutSec: "",
    urlExtras: null,
    sshEnabled: false,
    sshHost: "",
    sshPort: "",
    sshBastionHost: "",
    sshAuth: "password",
    sshUser: "",
    sshPassword: "",
    sshKeyFile: "",
    sshPassphrase: "",
    sslCa: "",
    sslCert: "",
    sslKey: "",
    sslKeyPassword: "",
  };
}

/** The fields filled from a URL the form could read. */
export function applyUrlParts(values: ConnectionFormValues, parts: DbUrlParts): ConnectionFormValues {
  return {
    ...values,
    connMode: parts.socket ? "socket" : "host",
    host: parts.host,
    port: parts.port == null ? "" : String(parts.port),
    socket: parts.socket,
    user: parts.user,
    password: parts.password,
    database: parts.database,
    urlExtras: { scheme: parts.scheme, ssl: parts.ssl, params: parts.params },
  };
}

type SavedConnection = Pick<Connection, "type" | "name" | "group_name" | "color" | "readonly" | "ai_access">;

/** The form for a saved connection, from its listing and the config `/config` sent (no secret in it). */
export function formFromSaved(conn: SavedConnection, config: EditableConnectionConfig): { values: ConnectionFormValues } & Omit<EditingInfo, "id"> {
  const base: ConnectionFormValues = {
    ...emptyForm(conn.type),
    name: conn.name,
    folder: conn.group_name ?? "",
    color: conn.color,
    readonly: conn.readonly === 1,
    aiAccess: conn.ai_access !== 0,
  };
  const nothingSaved = { passwordSaved: false, savedUrlUnreadable: false, sshPasswordSaved: false, sshPassphraseSaved: false, sslKeyPasswordSaved: false };
  if (config.type === "sqlite") return { values: { ...base, path: config.path }, ...nothingSaved };

  const { ssh, ssl } = config;
  const withSettings: ConnectionFormValues = {
    ...base,
    passwordMode: config.passwordMode ?? "save",
    singleDatabase: config.singleDatabase ?? true,
    allowedDatabases: (config.allowedDatabases ?? []).join("\n"),
    allowedDatabasesRegex: config.allowedDatabasesRegex ?? "",
    isolationLevel: config.isolationLevel ?? "",
    queryTimeoutSec: config.queryTimeoutSec === undefined ? "" : String(config.queryTimeoutSec),
    sshEnabled: ssh?.enabled ?? false,
    sshHost: ssh?.host ?? "",
    sshPort: ssh?.port === undefined ? "" : String(ssh.port),
    sshBastionHost: ssh?.bastionHost ?? "",
    sshAuth: ssh?.auth ?? "password",
    sshUser: ssh?.user ?? "",
    sshKeyFile: ssh?.keyFile ?? "",
    sslCa: ssl?.ca ?? "",
    sslCert: ssl?.cert ?? "",
    sslKey: ssl?.key ?? "",
  };
  const saved = {
    ...nothingSaved,
    sshPasswordSaved: !!ssh?.hasPassword,
    sshPassphraseSaved: !!ssh?.hasPassphrase,
    sslKeyPasswordSaved: !!ssl?.hasKeyPassword,
  };
  if (config.connectionString === null) {
    return { values: { ...withSettings, entry: "url", url: "" }, ...saved, savedUrlUnreadable: true };
  }
  // A connection saved before the form existed was a URL. One that asks for its password shows
  // the fields, since only they have Password mode.
  const entry = asksForPassword(config.passwordMode) ? "fields" : config.entry ?? "url";
  const values: ConnectionFormValues = { ...withSettings, entry, url: config.connectionString };
  const parsed = parseDbUrl(config.connectionString);
  return {
    values: parsed.kind === "url" ? applyUrlParts(values, parsed.parts) : values,
    ...saved,
    passwordSaved: config.hasPassword,
  };
}

/** A port the Port field may hold: empty, or 1 to 65535. */
export function portProblem(port: string): string | null {
  const text = port.trim();
  if (!text) return null;
  const n = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  return n >= 1 && n <= 65535 ? null : "A number from 1 to 65535.";
}

/**
 * The URL the fields describe. An empty Server is `localhost` and an empty User the engine's
 * default login — what the placeholders promise, and not what the drivers would pick: postgres.js
 * logs in as the operating system's user when a URL names none.
 */
function fieldParts(values: ConnectionFormValues): DbUrlParts {
  const type = values.type as ServerDbType;
  const socket = values.connMode === "socket";
  const port = values.port.trim();
  return {
    type,
    scheme: values.urlExtras?.scheme ?? URL_SCHEME[type],
    host: socket ? "" : values.host.trim() || "localhost",
    port: socket || !port || portProblem(port) ? null : Number(port),
    socket: socket ? values.socket.trim() : "",
    user: values.user.trim() || DEFAULT_USER[type],
    password: values.password,
    database: values.database.trim(),
    ssl: values.urlExtras?.ssl ?? null,
    params: values.urlExtras?.params ?? [],
  };
}

/** What is sent: no password when PPM is to ask for it, and no login either when it asks for both. */
function sentParts(values: ConnectionFormValues): DbUrlParts {
  const parts = fieldParts(values);
  const mode = effectivePasswordMode(values);
  if (asksForPassword(mode)) parts.password = "";
  if (mode === "askUser") parts.user = "";
  return parts;
}

/** Whether a URL of `parts.type` can be this connection's: its own engine, or one it reads when editing. */
function urlFits(values: ConnectionFormValues, ctx: FormContext, parts: DbUrlParts): boolean {
  if (!isServer(values.type)) return false;
  return parts.type === values.type || (!!ctx.editing && sameFamily(parts.type, values.type));
}

export interface HelpLine {
  tone: "plain" | "ok" | "bad";
  text: string;
}

/** The line under the URL box. `required`: an empty box is a problem, not just empty. */
export function urlHelp(values: ConnectionFormValues, ctx: FormContext, required: boolean): HelpLine {
  const type = values.type as ServerDbType;
  const parsed = parseDbUrl(values.url);
  const example = `Example: ${URL_SCHEME[type]}://user@localhost:${DEFAULT_PORT[type]}/shop`;
  switch (parsed.kind) {
    case "empty":
      if (ctx.editing?.savedUrlUnreadable) return { tone: "plain", text: "PPM cannot read the saved URL, so it is not shown. It is kept until you enter a new one." };
      return required
        ? { tone: "bad", text: "Enter the database URL." }
        : { tone: "plain", text: "Server, port, login, database and SSL are all read from the URL." };
    case "file":
      return { tone: "bad", text: "That is a file path: pick SQLite above to open a file." };
    case "error":
      return { tone: "bad", text: `${parsed.error} ${example}` };
    case "url": {
      if (!urlFits(values, ctx, parsed.parts)) {
        return { tone: "bad", text: `This connection is ${DB_TYPE_LABELS[type]}; the URL is for ${DB_TYPE_LABELS[parsed.parts.type]}.` };
      }
      const problem = dbUrlProblem(parsed.parts);
      if (problem) return { tone: "bad", text: `${problem} ${example}` };
      return { tone: "ok", text: describeDbUrl(parsed.parts) };
    }
  }
}

/**
 * A URL typed into the box. On a new connection a URL for another server engine moves the engine
 * tiles to it; a saved connection keeps its type, and the box says the URL does not fit.
 */
export function typeUrl(values: ConnectionFormValues, ctx: FormContext, url: string): ConnectionFormValues {
  const next = { ...values, url };
  if (ctx.editing) return next;
  const parsed = parseDbUrl(url);
  if (parsed.kind === "url" && parsed.parts.type !== values.type) return { ...next, type: parsed.parts.type };
  return next;
}

/**
 * An engine tile picked by hand, which wins over a URL typed for another engine. The SSL tab's
 * boxes stay as they were, written in the new engine's own parameter.
 */
export function pickEngine(values: ConnectionFormValues, type: DbType): ConnectionFormValues {
  if (type === values.type) return values;
  const parsed = parseDbUrl(values.url);
  const url = parsed.kind === "url" && parsed.parts.type !== type ? "" : values.url;
  const next: ConnectionFormValues = { ...values, type, url, urlExtras: null };
  const { useSsl, rejectUnauthorized } = sslFlags({ ssl: values.urlExtras?.ssl ?? null });
  return values.entry === "fields" && useSsl && isServer(type) ? withFieldSsl(next, true, rejectUnauthorized) : next;
}

const hasText = (s: string) => s.trim() !== "";

/**
 * The other way of entering the same connection. Going to the URL builds it from the fields, when
 * any were filled; going back reads it into them — or, for a URL the fields cannot hold, says why
 * and stays, so nothing typed is thrown away.
 */
export function switchEntry(
  values: ConnectionFormValues,
  ctx: FormContext,
  entry: "fields" | "url",
): { values: ConnectionFormValues } | { problem: FormProblem } {
  if (entry === values.entry || !isServer(values.type)) return { values: { ...values, entry } };
  if (entry === "url") {
    const touched = [values.host, values.port, values.socket, values.user, values.password, values.database].some(hasText)
      || !!values.urlExtras?.ssl || !!values.urlExtras?.params.length;
    return { values: { ...values, entry, url: touched ? buildDbUrl(fieldParts(values)) : "" } };
  }
  const parsed = parseDbUrl(values.url);
  if (parsed.kind === "empty") return { values: { ...values, entry } };
  const help = urlHelp(values, ctx, true);
  if (parsed.kind !== "url" || help.tone === "bad") return { problem: { field: "url", message: help.text } };
  return { values: { ...applyUrlParts(values, parsed.parts), entry } };
}

/** The URL box read as a URL this connection can take, or null. */
function fittingUrl(values: ConnectionFormValues, ctx: FormContext): DbUrlParts | null {
  const parsed: DbUrlParse = parseDbUrl(values.url);
  return parsed.kind === "url" && urlFits(values, ctx, parsed.parts) && !dbUrlProblem(parsed.parts) ? parsed.parts : null;
}

/** The fields' TLS parameter as the SSL tab's boxes say, the rest of what the fields carry left alone. */
function withFieldSsl(values: ConnectionFormValues, useSsl: boolean, rejectUnauthorized: boolean): ConnectionFormValues {
  const parts = fieldParts(values);
  const next = withSslFlags(parts, useSsl, rejectUnauthorized);
  return next === parts ? values : { ...values, urlExtras: { scheme: parts.scheme, ssl: next.ssl, params: parts.params } };
}

/**
 * What the SSL tab's two boxes show: the TLS parameter of the URL the form sends. Null when there
 * is no URL to read one from — an empty or unreadable box — so there is nothing to tick either.
 */
export function sslChecks(values: ConnectionFormValues, ctx: FormContext): { useSsl: boolean; rejectUnauthorized: boolean } | null {
  if (!isServer(values.type)) return null;
  if (values.entry === "fields") return sslFlags({ ssl: values.urlExtras?.ssl ?? null });
  const parts = fittingUrl(values, ctx);
  return parts ? sslFlags(parts) : null;
}

/** The SSL tab's boxes ticked or unticked: the URL's TLS parameter rewritten, and nothing else in it. */
export function setSslChecks(values: ConnectionFormValues, ctx: FormContext, useSsl: boolean, rejectUnauthorized: boolean): ConnectionFormValues {
  if (!isServer(values.type)) return values;
  if (values.entry === "fields") return withFieldSsl(values, useSsl, rejectUnauthorized);
  const parts = fittingUrl(values, ctx);
  if (!parts) return values;
  const next = withSslFlags(parts, useSsl, rejectUnauthorized);
  return next === parts ? values : { ...values, url: buildDbUrl(next) };
}

/** The database the connection opens: the field, or the URL's path. */
export function currentDatabase(values: ConnectionFormValues, ctx: FormContext): string {
  if (!isServer(values.type)) return "";
  if (values.entry === "url") return fittingUrl(values, ctx)?.database ?? "";
  return values.database.trim();
}

/** Where the connection goes, as the result line and Database Log In name it. */
export function targetOf(values: ConnectionFormValues, ctx: FormContext): string {
  if (!isServer(values.type)) return values.path.trim();
  if (values.entry === "url") {
    const parts = fittingUrl(values, ctx);
    return parts ? dbUrlTarget(parts) : "";
  }
  return dbUrlTarget(fieldParts(values));
}

function baseName(path: string): string {
  return path.trim().split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/** The name a connection gets when Display name is left empty: `db@host`, `user@host`, or the file's name. */
export function defaultName(values: ConnectionFormValues, ctx: FormContext): string {
  if (!isServer(values.type)) return baseName(values.path) || "database.db";
  let { host, user, database } = { host: values.host.trim(), user: values.user.trim(), database: values.database.trim() };
  let socket = values.connMode === "socket";
  if (values.entry === "url") {
    const parts = fittingUrl(values, ctx);
    ({ host, user, database } = parts ?? { host: "", user: "", database: "" });
    socket = !!parts?.socket;
  }
  // A login PPM asks for is not part of the connection, so it does not name it either.
  if (effectivePasswordMode(values) === "askUser") user = "";
  const where = socket ? "localhost" : host || "localhost";
  return `${database || user || DEFAULT_USER[values.type]}@${where}`;
}

export function effectiveName(values: ConnectionFormValues, ctx: FormContext): string {
  return values.name.trim() || defaultName(values, ctx);
}

export function nameTaken(values: ConnectionFormValues, ctx: FormContext): boolean {
  return ctx.takenNames.has(effectiveName(values, ctx));
}

/** The AI chat cannot use a connection that asks for its password: nobody is there to answer. */
export function aiAccessAllowed(values: ConnectionFormValues): boolean {
  return !formAsksForLogin(values);
}

/**
 * A path the PPM host can read without guessing, on whichever system it runs: absolute, or under
 * `~`. The server checks it again against its own.
 */
function isFullPath(file: string): boolean {
  return /^(\/|~$|~[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(file);
}

/** What is wrong on the SSH Tunnel tab, in the server's words; nothing while the tunnel is off. */
function sshProblem(values: ConnectionFormValues, ctx: FormContext): FormProblem | null {
  if (!values.sshEnabled) return null;
  if (values.entry === "url" ? !!fittingUrl(values, ctx)?.socket : values.connMode === "socket") {
    return values.entry === "url"
      ? { field: "url", message: "An SSH tunnel reaches the database by host and port. Put the host in the URL as the SSH server sees it (often localhost), or turn the tunnel off." }
      : { field: "socket", message: "An SSH tunnel reaches the database by host and port. Pick Host and port above, or turn the tunnel off." };
  }
  const host = values.sshHost.trim();
  if (!host) return { field: "sshHost", message: "Enter the SSH host." };
  if (/[\s/@]/.test(host)) return { field: "sshHost", message: "Enter the SSH host's name or address, like ssh.example.com. The login goes in its own field." };
  const port = portProblem(values.sshPort);
  if (port) return { field: "sshPort", message: port };
  const bastion = values.sshBastionHost.trim();
  if (bastion) {
    const parsed = parseSshAddress(bastion);
    if ("error" in parsed) return { field: "sshBastionHost", message: parsed.error };
  }
  if (values.sshAuth === "keyFile") {
    const key = values.sshKeyFile.trim();
    if (!key) return { field: "sshKeyFile", message: "Pick the private key file." };
    if (!isFullPath(key)) return { field: "sshKeyFile", message: `Give the key file as a full path on the PPM host, not ${key}.` };
  }
  return null;
}

const SSL_FILES = [["sslCa", "CA certificate"], ["sslCert", "certificate"], ["sslKey", "key file"]] as const;

/** A certificate path the PPM host could not find; only checked with SSL on, as the fields are only editable then. */
function sslProblem(values: ConnectionFormValues, ctx: FormContext): FormProblem | null {
  if (!sslChecks(values, ctx)?.useSsl) return null;
  for (const [field, label] of SSL_FILES) {
    const file = values[field].trim();
    if (file && !isFullPath(file)) return { field, message: `Give the ${label} as a full path on the PPM host, not ${file}.` };
  }
  return null;
}

/**
 * The first problem with what the form holds, in the order the fields appear, or null.
 * `forSave` adds the checks only saving needs: a Test runs whatever the name is.
 */
export function validate(values: ConnectionFormValues, ctx: FormContext, forSave: boolean): FormProblem | null {
  if (!isServer(values.type)) {
    if (!hasText(values.path)) return { field: "path", message: "Enter the path of the database file." };
  } else if (values.entry === "url") {
    const help = urlHelp(values, ctx, true);
    if (help.tone === "bad") return { field: "url", message: help.text };
  } else if (values.connMode === "socket") {
    if (!hasText(values.socket)) return { field: "socket", message: "Enter the path of the socket." };
  } else {
    const problem = portProblem(values.port);
    if (problem) return { field: "port", message: problem };
  }
  const tunnel = isServer(values.type) ? sshProblem(values, ctx) ?? sslProblem(values, ctx) : null;
  if (tunnel) return tunnel;
  if (isServer(values.type) && allowedDatabasesRegexProblem(values.allowedDatabasesRegex.trim())) {
    return { field: "allowedDatabasesRegex", message: "Not a valid regular expression." };
  }
  if (isServer(values.type) && queryTimeoutProblem(values.queryTimeoutSec.trim())) {
    return { field: "queryTimeoutSec", message: "A whole number of seconds, or empty for no limit." };
  }
  if (forSave && nameTaken(values, ctx)) return { field: "name", message: "Another connection already has this name." };
  return null;
}

export function allowedDatabaseList(values: ConnectionFormValues): string[] {
  return values.allowedDatabases.split("\n").map((d) => d.trim()).filter(Boolean);
}

/** The SSH Tunnel tab as the server takes it: the secret the chosen method uses, and no other. */
function sshConfigOf(values: ConnectionFormValues): Record<string, unknown> {
  const ssh: Record<string, unknown> = {
    enabled: values.sshEnabled,
    host: values.sshHost.trim(),
    port: values.sshPort.trim(),
    bastionHost: values.sshBastionHost.trim(),
    auth: values.sshAuth,
    user: values.sshUser.trim(),
    keyFile: values.sshKeyFile.trim(),
  };
  if (values.sshAuth === "password" && values.sshPassword) ssh.password = values.sshPassword;
  if (values.sshAuth === "keyFile" && values.sshPassphrase) ssh.passphrase = values.sshPassphrase;
  return ssh;
}

function sslConfigOf(values: ConnectionFormValues): Record<string, unknown> {
  const ssl: Record<string, unknown> = { ca: values.sslCa.trim(), cert: values.sslCert.trim(), key: values.sslKey.trim() };
  if (values.sslKeyPassword) ssl.keyPassword = values.sslKeyPassword;
  return ssl;
}

/** The `connectionConfig` `/test` and the save routes take. */
export function connectionConfigOf(values: ConnectionFormValues, ctx: FormContext): Record<string, unknown> {
  if (!isServer(values.type)) return { type: "sqlite", path: values.path.trim() };
  const config: Record<string, unknown> = {
    type: values.type,
    entry: values.entry,
    passwordMode: effectivePasswordMode(values),
    allowedDatabases: allowedDatabaseList(values),
    allowedDatabasesRegex: values.allowedDatabasesRegex.trim(),
  };
  if (values.isolationLevel) config.isolationLevel = values.isolationLevel;
  if (values.queryTimeoutSec.trim()) config.queryTimeoutSec = Number(values.queryTimeoutSec.trim());
  if (currentDatabase(values, ctx)) config.singleDatabase = values.singleDatabase;
  // Always sent, so an emptied tab clears what was saved: left out, the server keeps it.
  config.ssh = sshConfigOf(values);
  config.ssl = sslConfigOf(values);
  if (values.entry === "url") {
    // An empty box on a URL PPM cannot read keeps that URL: leaving it out is how the server knows.
    if (!(ctx.editing?.savedUrlUnreadable && !hasText(values.url))) config.connectionString = values.url.trim();
  } else {
    config.connectionString = buildDbUrl(sentParts(values));
  }
  // A saved secret stands in for an empty field; the server ignores this for one that was typed.
  const e = ctx.editing;
  if (e && (e.passwordSaved || e.sshPasswordSaved || e.sshPassphraseSaved || e.sslKeyPasswordSaved)) config.keepPassword = true;
  return config;
}

/** The body of `POST /api/db/test`. */
export function testRequestBody(values: ConnectionFormValues, ctx: FormContext): Record<string, unknown> {
  return {
    type: values.type,
    connectionConfig: connectionConfigOf(values, ctx),
    ...(ctx.editing ? { connectionId: ctx.editing.id } : {}),
  };
}

/** The body of `POST /api/db/connections`, or of `PUT /api/db/connections/:id` when editing. */
export function saveRequestBody(values: ConnectionFormValues, ctx: FormContext): Record<string, unknown> {
  const folder = values.folder.trim();
  return {
    type: values.type,
    name: effectiveName(values, ctx),
    connectionConfig: connectionConfigOf(values, ctx),
    // A new connection leaves out what it does not set; an edited one clears it with null.
    groupName: folder || (ctx.editing ? null : undefined),
    color: values.color ?? (ctx.editing ? null : undefined),
    readonly: values.readonly,
    aiAccess: values.aiAccess && aiAccessAllowed(values),
  };
}

/**
 * The part of the form a test result belongs to: change any of it and the result is stale.
 * `withDatabase: false` is the part the ▾ list of databases belongs to, which does not depend on
 * the database picked from it.
 */
export function targetKey(values: ConnectionFormValues, ctx: FormContext, withDatabase = true): string {
  if (!isServer(values.type)) return JSON.stringify(["sqlite", values.path.trim()]);
  let where: string;
  if (values.entry === "url") {
    const parts = fittingUrl(values, ctx);
    where = parts ? buildDbUrl(withDatabase ? parts : { ...parts, database: "" }) : values.url.trim();
  } else {
    const parts = sentParts(values);
    where = buildDbUrl(withDatabase ? parts : { ...parts, database: "" });
  }
  return JSON.stringify([values.type, effectivePasswordMode(values), where, tunnelKey(values), certificateKey(values, ctx)]);
}

/** The SSH Tunnel tab's part of a target: nothing while it is off. */
function tunnelKey(values: ConnectionFormValues): unknown {
  if (!values.sshEnabled) return null;
  const secret = values.sshAuth === "password" ? values.sshPassword : values.sshAuth === "keyFile" ? [values.sshKeyFile.trim(), values.sshPassphrase] : null;
  return [values.sshHost.trim(), values.sshPort.trim(), values.sshBastionHost.trim(), values.sshAuth, values.sshUser.trim(), secret];
}

/** The SSL tab's files, which count only with SSL on. */
function certificateKey(values: ConnectionFormValues, ctx: FormContext): unknown {
  if (!sslChecks(values, ctx)?.useSsl) return null;
  return [values.sslCa.trim(), values.sslCert.trim(), values.sslKey.trim(), values.sslKeyPassword];
}

/** The databases the ▾ list offers: the server's, through the Advanced tab's filter. */
export function listedDatabases(names: readonly string[], values: ConnectionFormValues): string[] {
  return filterAllowedDatabases(names, {
    allowedDatabases: allowedDatabaseList(values),
    allowedDatabasesRegex: values.allowedDatabasesRegex.trim(),
  });
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The small print after "Connected: <version>", with the tunnel it went through. */
export function successDetail(result: DbTestSuccess, values: ConnectionFormValues, ctx: FormContext): string {
  const ms = `${result.elapsedMs} ms`;
  if (!isServer(values.type)) return `${result.target} · ${ms}`;
  const database = currentDatabase(values, ctx);
  const what = database ? `database “${database}”` : count(listedDatabases(result.databases, values).length, "database");
  const hops = result.ssh ?? [];
  const server = hops[hops.length - 1];
  const via = hops.length > 1 ? ` via ${hops.slice(0, -1).map((h) => h.host).join(", ")}` : "";
  return `${what} · ${result.target}${server ? ` through SSH ${server.host}${via}` : ""} · ${ms}`;
}

/** The URL's TLS parameter as written, `sslmode=require`; null when it has none or cannot be read. */
export function sslParamOf(values: ConnectionFormValues, ctx: FormContext): string | null {
  if (!isServer(values.type)) return null;
  const ssl = values.entry === "url" ? fittingUrl(values, ctx)?.ssl : values.urlExtras?.ssl;
  return ssl ? `${ssl.name}=${ssl.value}` : null;
}

/**
 * What Details shows after a Test that connected: each SSH server's host key, bastion first, and
 * whether the connection was encrypted — as the server reports it, since `sslmode=prefer` falls
 * back to plain text without a word. Empty for a SQLite file.
 */
export function successDetails(result: DbTestSuccess, values: ConnectionFormValues, ctx: FormContext): string {
  if (!isServer(values.type)) return "";
  const hops = result.ssh ?? [];
  const lines = hops.map((hop, i) => {
    const role = i < hops.length - 1 ? "Bastion" : "SSH server";
    return `${role} ${hop.host}, host key ${hop.fingerprint}${hop.firstSeen ? " (first connection: PPM trusts this key from now on)" : ""}`;
  });
  const param = sslParamOf(values, ctx) ?? "not set in the URL";
  const state = result.tls === undefined ? "" : result.tls ? `on (${result.tls}) · ` : "off · ";
  lines.push(`SSL: ${state}${param}`);
  if (sslChecks(values, ctx)?.useSsl) {
    const files = SSL_FILES.map(([field, label]) => [label, values[field].trim()] as const).filter(([, file]) => file);
    if (files.length) lines.push(`Certificate files: ${files.map(([label, file]) => `${label} ${file}`).join(", ")}`);
  }
  return lines.join("\n");
}

/** The field a server-side refusal names, in the form's terms. */
export function fieldOfServerError(field: unknown, values: ConnectionFormValues): FormField | null {
  switch (field) {
    case "connectionString":
      return values.entry === "url" ? "url" : values.connMode === "socket" ? "socket" : "host";
    case "path": case "name": case "type": case "passwordMode":
    case "allowedDatabases": case "allowedDatabasesRegex": case "isolationLevel": case "queryTimeoutSec":
      return field;
    default:
      return SSH_FIELDS.includes(field as FormField) || SSL_FIELDS.includes(field as FormField) ? (field as FormField) : null;
  }
}

/** The help under Password mode. */
export function passwordModeHelp(mode: PasswordMode): string {
  if (!asksForPassword(mode)) return "Encrypted on the PPM host and never sent back to the browser.";
  const what = mode === "askUser" ? "the login and password" : "the password";
  return `Not saved. PPM asks for ${what} when the connection opens, and keeps it in the server's memory until you disconnect or PPM restarts.`;
}
