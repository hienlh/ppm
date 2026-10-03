/**
 * Database URLs, read and written by hand — one reader for the connection form, the server and the CLI.
 *
 * Not `new URL()`. Its parser refuses `postgres://app@/shop?host=/var/run/postgresql`, a login
 * with no host, which is how libpq names a Unix socket; and a browser parses the host of a URL
 * whose scheme is not a web one differently from the next browser. Both drivers PPM uses also
 * trip over the same URL (postgres.js hands it to `new URL()`, and would send `?host=` to the
 * server as a setting), so the services read it here too and give the drivers plain options.
 *
 * Parsing keeps what it does not model: the scheme as written (`postgresql` stays `postgresql`),
 * the TLS parameter as written (`sslmode=prefer` survives an edit that never touched SSL), and
 * every other query parameter in order. `buildDbUrl(parseDbUrl(x))` is therefore the same
 * connection, whether or not it is the same string.
 */
import type { DbType } from "./db-types.ts";

export type ServerDbType = Exclude<DbType, "sqlite">;

export const DEFAULT_PORT: Record<ServerDbType, number> = { postgres: 5432, mysql: 3306, mariadb: 3306 };
/** The login a server connection uses when none is given, shown as the User field's placeholder. */
export const DEFAULT_USER: Record<ServerDbType, string> = { postgres: "postgres", mysql: "root", mariadb: "root" };
export const DEFAULT_SOCKET: Record<ServerDbType, string> = {
  postgres: "/var/run/postgresql",
  mysql: "/run/mysqld/mysqld.sock",
  mariadb: "/run/mysqld/mysqld.sock",
};
/** The scheme a URL built for each engine starts with. */
export const URL_SCHEME: Record<ServerDbType, string> = { postgres: "postgres", mysql: "mysql", mariadb: "mariadb" };

const SCHEMES: Record<string, ServerDbType> = { postgres: "postgres", postgresql: "postgres", mysql: "mysql", mariadb: "mariadb" };

/** The query parameters each engine's URLs name TLS with, in the order they are looked for. */
const SSL_PARAMS: Record<ServerDbType, readonly string[]> = {
  postgres: ["sslmode", "ssl"],
  mysql: ["ssl-mode", "sslmode", "sslMode", "ssl"],
  mariadb: ["ssl-mode", "sslmode", "sslMode", "ssl"],
};

export interface DbUrlParts {
  type: ServerDbType;
  /** As written: `postgres` and `postgresql` are one engine. */
  scheme: string;
  /** Empty when the server is reached through `socket`. */
  host: string;
  /** Null leaves it to the engine's default. */
  port: number | null;
  /** A Unix socket on the PPM host; empty for host and port. */
  socket: string;
  user: string;
  password: string;
  database: string;
  /** The TLS parameter as the URL has it, e.g. `{ name: "sslmode", value: "verify-full" }`; null when there is none. */
  ssl: { name: string; value: string } | null;
  /** Every other query parameter, decoded, in the order given. */
  params: [string, string][];
}

export type DbUrlParse =
  | { kind: "empty" }
  /** Not a URL but a path: the connection is a SQLite file. */
  | { kind: "file"; path: string }
  | { kind: "error"; error: string }
  | { kind: "url"; parts: DbUrlParts };

const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/s;

function looksLikeFilePath(s: string): boolean {
  if (/^file:/i.test(s)) return true;
  if (s.includes("://")) return false;
  return /^(~|\/|\.{1,2}[/\\]|[A-Za-z]:[\\/])/.test(s) || /\.(db|sqlite3?|db3)$/i.test(s);
}

/** `decodeURIComponent`, keeping the text as it is when it holds a lone `%`. */
function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

const invalid = (error = "PPM cannot read this as a URL."): DbUrlParse => ({ kind: "error", error });

export function parseDbUrl(raw: string): DbUrlParse {
  const s = String(raw ?? "").trim();
  if (!s) return { kind: "empty" };
  if (looksLikeFilePath(s)) return { kind: "file", path: s.replace(/^file:(\/\/)?/i, "") };
  const m = SCHEME_RE.exec(s);
  if (!m) return invalid();
  const scheme = m[1]!;
  const type = SCHEMES[scheme.toLowerCase()];
  if (!type) return invalid(`${scheme}:// is not a database PPM supports yet.`);

  let rest = m[2]!;
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  let query = "";
  const q = rest.indexOf("?");
  if (q >= 0) {
    query = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  const slash = rest.indexOf("/");
  const authority = slash >= 0 ? rest.slice(0, slash) : rest;
  const path = slash >= 0 ? rest.slice(slash + 1) : "";

  // The last `@`: an unencoded one inside the password is still part of the login.
  const at = authority.lastIndexOf("@");
  const login = at >= 0 ? authority.slice(0, at) : "";
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  const colon = login.indexOf(":");
  const user = decode(colon >= 0 ? login.slice(0, colon) : login);
  const password = colon >= 0 ? decode(login.slice(colon + 1)) : "";

  let host = hostPort;
  let portText = "";
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) return invalid();
    host = hostPort.slice(1, close);
    const after = hostPort.slice(close + 1);
    if (after && !after.startsWith(":")) return invalid();
    portText = after.slice(1);
  } else if (!hostPort.includes(",")) {
    // A list of hosts (`a:5432,b:5433`) is kept whole; only libpq-style clients read it.
    const c = hostPort.lastIndexOf(":");
    if (c >= 0) {
      host = hostPort.slice(0, c);
      portText = hostPort.slice(c + 1);
    }
    // Only brackets make a colon part of a host: `h:1:2` is not host `h:1` on port 2.
    if (host.includes(":")) return invalid("The server name has a colon in it. An IPv6 address goes in brackets, like [::1]:5432.");
  }
  let port: number | null = null;
  if (portText) {
    const n = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
    if (!(n >= 1 && n <= 65535)) return invalid("The port must be a number from 1 to 65535.");
    port = n;
  }

  host = decode(host);
  let socket = "";
  // libpq also takes the socket's directory as a percent-encoded host.
  if (host.startsWith("/")) {
    socket = host;
    host = "";
  }

  const sslNames = SSL_PARAMS[type];
  let ssl: DbUrlParts["ssl"] = null;
  const params: [string, string][] = [];
  for (const piece of query.split("&")) {
    if (!piece) continue;
    const eq = piece.indexOf("=");
    const name = decode(eq >= 0 ? piece.slice(0, eq) : piece);
    const value = eq >= 0 ? decode(piece.slice(eq + 1)) : "";
    // libpq names a socket directory with ?host=/path; MySQL URLs use ?socket=/path.
    const isSocket = type === "postgres" ? name === "host" && value.startsWith("/") : name === "socket" || name === "socketPath";
    if (isSocket && !socket) socket = value;
    else if (isSocket) continue;
    else if (!ssl && sslNames.includes(name)) ssl = { name, value };
    else params.push([name, value]);
  }
  if (socket) host = "";

  return {
    kind: "url",
    parts: { type, scheme, host, port, socket, user, password, database: decode(path.split("/")[0] ?? ""), ssl, params },
  };
}

/** What the connection form refuses in a URL it could read, or null. */
export function dbUrlProblem(parts: DbUrlParts): string | null {
  if (!parts.host && !parts.socket) return "The URL has no server name.";
  return null;
}

/** A query value with `/` and `:` left readable, as a socket path or a time zone reads best. */
function encodeQuery(text: string): string {
  return encodeURIComponent(text).replace(/%2F/gi, "/").replace(/%3A/gi, ":");
}

/** An IPv6 address in brackets; a list of hosts as it came. */
function hostText(host: string): string {
  return host.includes(":") && !host.includes(",") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * The URL for `parts`. `password: false` leaves the password out, which is what the browser
 * is shown for a saved connection: the server keeps the password and never sends it back.
 */
export function buildDbUrl(parts: DbUrlParts, options: { password?: boolean } = {}): string {
  const password = options.password === false ? "" : parts.password;
  const enc = encodeURIComponent;
  const login = parts.user || password ? `${enc(parts.user)}${password ? `:${enc(password)}` : ""}@` : "";
  const where = parts.socket ? "" : `${hostText(parts.host)}${parts.port == null ? "" : `:${parts.port}`}`;
  const query: [string, string][] = [];
  if (parts.socket) query.push([parts.type === "postgres" ? "host" : "socket", parts.socket]);
  if (parts.ssl) query.push([parts.ssl.name, parts.ssl.value]);
  query.push(...parts.params);
  const qs = query.length ? `?${query.map(([k, v]) => `${encodeQuery(k)}=${encodeQuery(v)}`).join("&")}` : "";
  return `${parts.scheme}://${login}${where}/${enc(parts.database)}${qs}`;
}

/** Parts for an engine with nothing filled in yet. */
export function emptyDbUrlParts(type: ServerDbType): DbUrlParts {
  return { type, scheme: URL_SCHEME[type], host: "", port: null, socket: "", user: "", password: "", database: "", ssl: null, params: [] };
}

const SSL_ON = /^(require|required|verify-ca|verify_ca|verify-full|verify-identity|verify_identity|no-verify|true|1)$/i;

/** What the SSL tab's two checkboxes read from a URL's TLS parameter. */
export function sslFlags(parts: Pick<DbUrlParts, "ssl">): { useSsl: boolean; rejectUnauthorized: boolean } {
  const value = parts.ssl?.value ?? "";
  const useSsl = SSL_ON.test(value);
  return { useSsl, rejectUnauthorized: useSsl && /^verify/i.test(value) };
}

/**
 * `parts` with the TLS parameter the checkboxes ask for. Unchanged when they already say what the
 * URL says, so a URL's own spelling — `sslmode=prefer`, `ssl-mode=VERIFY_CA` — outlives an edit
 * that never touched SSL.
 */
export function withSslFlags(parts: DbUrlParts, useSsl: boolean, rejectUnauthorized: boolean): DbUrlParts {
  const now = sslFlags(parts);
  if (now.useSsl === useSsl && now.rejectUnauthorized === (useSsl && rejectUnauthorized)) return parts;
  if (!useSsl) return { ...parts, ssl: null };
  const pg = parts.type === "postgres";
  const value = pg ? (rejectUnauthorized ? "verify-full" : "require") : rejectUnauthorized ? "VERIFY_IDENTITY" : "REQUIRED";
  return { ...parts, ssl: { name: pg ? "sslmode" : "ssl-mode", value } };
}

const ENGINE_NAMES: Record<ServerDbType, string> = { postgres: "PostgreSQL", mysql: "MySQL", mariadb: "MariaDB" };

/** Where the connection goes: `socket /run/mysqld/mysqld.sock` or `db.example.com:5432`. */
export function dbUrlTarget(parts: DbUrlParts): string {
  if (parts.socket) return `socket ${parts.socket}`;
  return `${parts.host || "localhost"}:${parts.port ?? DEFAULT_PORT[parts.type]}`;
}

/** The line under the URL box: what PPM read from it. */
export function describeDbUrl(parts: DbUrlParts): string {
  const { useSsl, rejectUnauthorized } = sslFlags(parts);
  return [
    ENGINE_NAMES[parts.type],
    dbUrlTarget(parts),
    parts.user ? `user ${parts.user}` : null,
    parts.password ? "password set" : null,
    parts.database ? `database ${parts.database}` : "all databases",
    useSsl ? `SSL${rejectUnauthorized ? ", verified" : ""}` : null,
  ].filter(Boolean).join(" · ");
}
