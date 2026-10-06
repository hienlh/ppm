/**
 * What postgres.js is given for a connection string: the URL, plus the options it cannot read from one.
 *
 * Two things it gets wrong on its own. It has no libpq-style socket: `?host=/var/run/postgresql`
 * is sent to the server as a run-time setting (which the server refuses), and the URL that
 * carries it has a login with no host, which postgres.js's own `new URL()` throws on. The socket
 * goes in as the `host` option instead, which postgres.js reads as a directory when it holds a `/`.
 *
 * And TLS: postgres.js only knows `require`, `allow` and `prefer`, and any other `sslmode` it
 * passes to Node as-is — so `verify-ca` checked the host name as well, and PPM, which used to
 * compute this option itself, handed it `ssl: undefined` for both verify modes. An explicit
 * `undefined` wins over the URL there, so `verify-full` connected in plain text to a server with
 * TLS off. Every mode is now spelled out, and one this does not know is refused rather than
 * guessed at.
 */
import type { Duplex } from "node:stream";
import { checkServerIdentity, type ConnectionOptions } from "node:tls";
import { buildDbUrl, parseDbUrl } from "../../shared/db-connection-url.ts";
import { readCertificateFiles, takeEndpoint } from "./connection-endpoint.ts";
import { openSshChannel } from "./ssh-tunnel.ts";

export type PostgresSsl = false | "require" | "prefer" | ConnectionOptions;

export interface PostgresConnectTarget {
  url: string;
  /** Absent: the URL has no TLS parameter, and postgres.js connects in plain text as it always has. */
  ssl?: PostgresSsl;
  /** The socket directory, when the URL names one. */
  host?: string;
  /** Each connection's socket: a channel through the SSH tunnel, when the connection has one. */
  socket?: () => Promise<Duplex>;
}

/** libpq's `sslmode` values, plus the spellings other clients write in the same place. */
export function postgresSsl(mode: string): PostgresSsl {
  switch (mode.toLowerCase()) {
    case "disable": case "false": case "0":
      return false;
    // TLS when the server offers it, plain text when it does not.
    case "allow": case "prefer":
      return "prefer";
    // Encrypted; the certificate is not checked.
    case "require": case "no-verify": case "true": case "1":
      return "require";
    // The chain must lead to a trusted CA; the name on the certificate is not checked.
    case "verify-ca":
      return { rejectUnauthorized: true, checkServerIdentity: () => undefined };
    // The chain and the host name.
    case "verify-full":
      return { rejectUnauthorized: true };
    default:
      throw new Error(`Unknown sslmode "${mode}" — use disable, prefer, require, verify-ca or verify-full`);
  }
}

/**
 * The SSL tab's files on top of what the URL's `sslmode` asks for. `prefer` never gets them: its
 * fallback to plain text is a postgres.js string mode, and the tab only offers files with SSL on.
 */
function withCertificateFiles(ssl: PostgresSsl, files: ReturnType<typeof readCertificateFiles>): PostgresSsl {
  if (ssl === false || ssl === "prefer") return ssl;
  return ssl === "require" ? { rejectUnauthorized: false, ...files } : { ...ssl, ...files };
}

export function postgresConnectTarget(connectionString: string): PostgresConnectTarget {
  const { url, endpoint } = takeEndpoint(connectionString);
  const parsed = parseDbUrl(url);
  // postgres.js says what is wrong with a string this cannot read.
  if (parsed.kind !== "url") return { url };
  const { parts } = parsed;
  const target: PostgresConnectTarget = { url };
  if (parts.ssl) target.ssl = postgresSsl(parts.ssl.value);
  if (parts.socket) {
    // Any host will do for the URL: the option below replaces it.
    target.url = buildDbUrl({ ...parts, socket: "", host: "localhost" });
    target.host = parts.socket;
  }
  if (endpoint?.profile.ssl && target.ssl) target.ssl = withCertificateFiles(target.ssl, readCertificateFiles(endpoint.profile.ssl));
  const ssh = endpoint?.profile.ssh;
  if (endpoint && ssh) {
    target.socket = () => openSshChannel(endpoint.id, ssh, endpoint.target);
    // verify-full checks the name on the certificate against the database's own host, which is
    // not where the socket goes. Named outright, rather than left to TLS finding it on a socket
    // that is not a net.Socket.
    const ssl = target.ssl;
    if (typeof ssl === "object" && ssl.rejectUnauthorized && !ssl.checkServerIdentity) {
      const host = endpoint.target.host;
      target.ssl = { ...ssl, checkServerIdentity: (_name, cert) => checkServerIdentity(host, cert) };
    }
  }
  return target;
}
