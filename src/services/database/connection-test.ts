/**
 * The connection form's Test, run from the PPM host.
 *
 * Success says what the form needs next: the server's version for the result line and the
 * databases for the ▾ list. Failure keeps the driver's own words as the message and puts what a
 * person needs to act on it into the details: the error's code, the address and login that were
 * tried, the TLS setting, and which machine the attempt came from — the PPM host, not the
 * browser, which is the part people get wrong when a server is only reachable from their laptop.
 *
 * Through an SSH tunnel the test logs in to the SSH server itself rather than borrow a session a
 * pool already has open, so a changed password or key is what gets tested, and the host keys it
 * saw — first-seen ones included — come back with the result.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { getAdapter } from "./adapter-registry.ts";
import { closeEndpoint, endpointSshHops, type EndpointConfig } from "./connection-endpoint.ts";
import { localSshUser, sshTunnelOpenBudgetMs, SshTunnelError } from "./ssh-tunnel.ts";
import { mysqlErrorMessage } from "../mysql.service.ts";
import { DEFAULT_USER, dbUrlTarget, parseDbUrl, type ServerDbType } from "../../shared/db-connection-url.ts";
import { DEFAULT_SSH_PORT, parseSshAddress, type DbTestResult, type StoredConnectionConfig } from "../../shared/db-connection-config.ts";
import type { DbConnectionConfig } from "../../types/database.ts";

/** Longer than either driver's own connect timeout (15 s), so the driver's error is what gets shown. */
export const CONNECTION_TEST_TIMEOUT_MS = 20_000;

/** The test's budget: the drivers', plus what the tunnel may take to open. */
export function connectionTestTimeoutMs(config: StoredConnectionConfig): number {
  return CONNECTION_TEST_TIMEOUT_MS + (config.type === "sqlite" ? 0 : sshTunnelOpenBudgetMs(config.ssh));
}

const ENGINE: Record<ServerDbType, string> = { postgres: "PostgreSQL", mysql: "MySQL", mariadb: "MariaDB" };

/** The SQLSTATEs a failed login or connect usually ends in, by the name Postgres gives them. */
const SQLSTATE_NAMES: Record<string, string> = {
  "28P01": "invalid_password",
  "28000": "invalid_authorization_specification",
  "3D000": "invalid_catalog_name",
  "42501": "insufficient_privilege",
  "53300": "too_many_connections",
  "57P03": "cannot_connect_now",
  "08001": "sqlclient_unable_to_establish_sqlconnection",
  "08006": "connection_failure",
};

interface DriverError {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  errno?: unknown;
  sqlState?: unknown;
}

function asDriverError(e: unknown): DriverError {
  return e && typeof e === "object" ? (e as DriverError) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** `SQLSTATE 28P01 (invalid_password)`, `ER_ACCESS_DENIED_ERROR · errno 1045 · SQLSTATE 28000`, `Code: ECONNREFUSED`. */
export function errorCodeLine(e: unknown): string | null {
  const err = asDriverError(e);
  const code = text(err.code);
  // postgres.js raises a server's error as a PostgresError whose code is the SQLSTATE.
  if (err.name === "PostgresError" && code) {
    const name = SQLSTATE_NAMES[code];
    return `SQLSTATE ${code}${name ? ` (${name})` : ""}`;
  }
  const sqlState = text(err.sqlState);
  if (code && sqlState) {
    return [code, typeof err.errno === "number" ? `errno ${err.errno}` : null, `SQLSTATE ${sqlState}`].filter(Boolean).join(" · ");
  }
  return code ? `Code: ${code}` : null;
}

/** What to try, for the failures whose message does not say it. */
export function errorHint(e: unknown): string | null {
  if (e instanceof SshTunnelError) return e.hint ?? null;
  const err = asDriverError(e);
  const message = text(err.message) ?? "";
  if (err.code === "HANDSHAKE_NO_SSL_SUPPORT" || /before secure TLS connection was established/i.test(message)) {
    return "The server does not accept an encrypted connection. Turn off SSL for this connection, or enable SSL on the server.";
  }
  if (/self[- ]signed certificate|unable to verify the first certificate|unable to get local issuer certificate|certificate has expired|does not match certificate's altnames/i.test(message)) {
    return "The server's certificate was not accepted. Connect without verifying it, or give PPM the certificate of the authority that signed it.";
  }
  return null;
}

/**
 * Drivers do not repeat a password, but a URL they cannot parse comes back in the message whole
 * (`"postgres://app:secret@…" cannot be parsed as a URL`), so the login is taken out of anything
 * the browser is sent.
 */
export function redactLogin(message: string, config: StoredConnectionConfig): string {
  if (config.type === "sqlite") return message;
  let out = message.split(config.connectionString).join("<connection URL>");
  const parsed = parseDbUrl(config.connectionString);
  if (parsed.kind === "url" && parsed.parts.password) {
    for (const secret of new Set([parsed.parts.password, encodeURIComponent(parsed.parts.password)])) {
      out = out.split(`:${secret}@`).join(":•••@");
    }
  }
  // Neither ssh2 nor TLS repeats these; taken out anyway, where they are long enough not to be a word.
  for (const secret of [config.ssh?.password, config.ssh?.passphrase, config.ssl?.keyPassword]) {
    if (secret && secret.length >= 4) out = out.split(secret).join("•••");
  }
  return out;
}

function errorMessage(config: StoredConnectionConfig, e: unknown): string {
  const message = config.type === "mysql" || config.type === "mariadb"
    ? mysqlErrorMessage(e)
    : text(asDriverError(e).message) ?? String(e);
  return redactLogin(message, config);
}

/** Where the test went: `db.example.com:5432`, `socket /run/mysqld/mysqld.sock`, or the file. */
export function connectionTarget(config: StoredConnectionConfig): string {
  if (config.type === "sqlite") return config.path;
  const parsed = parseDbUrl(config.connectionString);
  return parsed.kind === "url" ? dbUrlTarget(parsed.parts) : "";
}

const SSH_AUTH_LABELS = { password: "password", agent: "SSH agent", keyFile: "key file" } as const;

/** The tunnel's lines under Details: who logs in where, and how. */
function sshDetailLines(config: Extract<StoredConnectionConfig, { connectionString: string }>): string[] {
  const ssh = config.ssh;
  if (!ssh?.enabled) return [];
  const user = ssh.user || `${localSshUser() || "?"} (the user PPM runs as)`;
  const how = ssh.auth === "keyFile" ? `key file ${ssh.keyFile ?? "(none)"}` : SSH_AUTH_LABELS[ssh.auth];
  const lines = [`SSH: ${user}@${ssh.host}:${ssh.port ?? DEFAULT_SSH_PORT} with ${how}`];
  if (ssh.bastionHost) {
    const bastion = parseSshAddress(ssh.bastionHost);
    lines.push(`Bastion: ${"error" in bastion ? ssh.bastionHost : `${bastion.user || ssh.user || localSshUser()}@${bastion.host}:${bastion.port}`}`);
  }
  return lines;
}

/** The lines under Details. Never the password. */
export function testFailureDetails(config: StoredConnectionConfig, e: unknown): string {
  const lines: (string | null)[] = [errorHint(e), errorCodeLine(e)];
  if (config.type === "sqlite") {
    lines.push(`File: ${config.path}`);
  } else {
    const parsed = parseDbUrl(config.connectionString);
    if (parsed.kind === "url") {
      const { parts } = parsed;
      const tunnelled = !!config.ssh?.enabled;
      const files = config.ssl ? [["CA certificate", config.ssl.ca], ["certificate", config.ssl.cert], ["key file", config.ssl.key]].filter(([, f]) => f) : [];
      lines.push(
        `Server: ${dbUrlTarget(parts)} (${ENGINE[config.type]})${tunnelled ? ", as the SSH server sees it" : ""}`,
        `User: ${parts.user || `${DEFAULT_USER[config.type]} (default)`}`,
        `SSL: ${parts.ssl ? `${parts.ssl.name}=${parts.ssl.value}` : "not set in the URL"}`,
        files.length ? `SSL files: ${files.map(([what, f]) => `${what} ${f}`).join(", ")}` : null,
        ...sshDetailLines(config),
      );
    }
  }
  lines.push(`Checked from the PPM host (${hostname()}).`);
  return lines.filter(Boolean).join("\n");
}

/** Test `config` on a connection of its own, which is closed again whatever happens — its tunnel too. */
export async function runConnectionTest(config: StoredConnectionConfig): Promise<DbTestResult> {
  const started = performance.now();
  const elapsedMs = () => Math.round(performance.now() - started);
  const probeConfig: EndpointConfig = config.type === "sqlite" ? config : { ...config, endpointScope: randomUUID() };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = await Promise.race([
      getAdapter(config.type).probe(probeConfig as DbConnectionConfig),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The server did not answer in time")), connectionTestTimeoutMs(config));
      }),
    ]);
    const ssh = endpointSshHops(probeConfig);
    return {
      ok: true, version: probe.version, databases: probe.databases, target: connectionTarget(config),
      ...(ssh ? { ssh } : {}), ...(probe.tls !== undefined ? { tls: probe.tls } : {}), elapsedMs: elapsedMs(),
    };
  } catch (e) {
    return { ok: false, error: errorMessage(config, e), details: redactLogin(testFailureDetails(config, e), config), elapsedMs: elapsedMs() };
  } finally {
    clearTimeout(timer);
    closeEndpoint(probeConfig);
  }
}
