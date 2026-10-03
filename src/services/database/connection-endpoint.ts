/**
 * How a connection's SSH tunnel and certificate files reach the services, which take a URL.
 *
 * Every service method takes a connection string, and pools are keyed by it. A saved connection,
 * and any connection with a tunnel or certificate files, is given one more query parameter,
 * `ppm-endpoint=<id>`, naming a profile held in this process: the tunnel settings and the file
 * paths. The id is an HMAC of the profile and of whose it is under a key made at start-up, so the
 * same settings always reach the same pools and the same SSH session, a changed SSH password gets
 * new ones, and the id means nothing outside this process. Whose: two saved connections can have
 * the same settings — Duplicate makes exactly that — and closing one (Disconnect, an edit, a
 * deletion) must not close the other's pools or tunnel. The services take the parameter out
 * (`takeEndpoint`) before a driver sees the URL, and a connection that is not a saved one and has
 * neither — the CLI's, the form's Test — keeps its URL byte for byte.
 */
import { createHmac, randomBytes } from "node:crypto";
import { buildDbUrl, DEFAULT_PORT, parseDbUrl, sslFlags } from "../../shared/db-connection-url.ts";
import type { SshTunnelSettings, SslFileSettings, StoredConnectionConfig } from "../../shared/db-connection-config.ts";
import type { SshHop } from "../../shared/db-connection-config.ts";
import { ConnectionConfigError, readSshTunnelSettings, readSslFileSettings } from "./connection-config.ts";
import { readHostFile } from "./host-files.ts";
import { closeSshTunnels, sshTunnelHops, type SshTarget } from "./ssh-tunnel.ts";

export const ENDPOINT_PARAM = "ppm-endpoint";

export interface EndpointProfile {
  ssh?: SshTunnelSettings;
  /** Only when the URL turns TLS on: the files mean nothing to a plain-text connection. */
  ssl?: SslFileSettings;
}

export interface Endpoint {
  id: string;
  profile: EndpointProfile;
  /** The database's address as the URL names it — as the SSH server sees it, through a tunnel. */
  target: SshTarget;
}

/**
 * A config, plus whose it is: the saved connection it opens (`effectiveConfig` adds the id), or
 * the scope `runConnectionTest` adds to give its probe a tunnel of its own.
 */
export type EndpointConfig = StoredConnectionConfig & { endpointScope?: string; connectionId?: number };

const secret = randomBytes(32);
const profiles = new Map<string, EndpointProfile>();

/** What `config` needs beside its URL; null for one with neither a tunnel nor certificate files. */
export function endpointProfile(config: StoredConnectionConfig): EndpointProfile | null {
  if (config.type === "sqlite") return null;
  const parsed = parseDbUrl(config.connectionString);
  if (parsed.kind !== "url") return null;
  const profile: EndpointProfile = {};
  try {
    // Read again as the form's input is: an imported connection, or a row written by hand, has
    // never been through it.
    const ssh = readSshTunnelSettings(config.ssh);
    if (ssh?.enabled) {
      // The form refuses this; a tunnel asked for must never quietly become a local connection.
      if (parsed.parts.socket) throw new Error("An SSH tunnel reaches the database by host and port, not through a socket.");
      profile.ssh = ssh;
    }
    const tlsOn = sslFlags(parsed.parts).useSsl;
    const files = readSslFileSettings(config.ssl, undefined, false, tlsOn);
    if (files && (files.ca || files.cert || files.key) && tlsOn) profile.ssl = files;
  } catch (e) {
    if (!(e instanceof ConnectionConfigError)) throw e;
    const tab = e.field.startsWith("ssl") ? "SSL" : "SSH tunnel";
    throw new Error(`This connection's ${tab} settings cannot be used: ${e.message} Edit the connection to fix them.`);
  }
  return profile.ssh || profile.ssl ? profile : null;
}

function endpointId(profile: EndpointProfile, config: EndpointConfig): string {
  const whose = [config.endpointScope ?? "", config.connectionId ?? null];
  return createHmac("sha256", secret).update(JSON.stringify([...whose, profile])).digest("base64url").slice(0, 22);
}

/** The connection string the services are given for `config`. */
export function serviceConnectionString(config: EndpointConfig): string {
  if (config.type === "sqlite") throw new Error("A SQLite connection has no connection string");
  const profile = endpointProfile(config);
  // A saved connection gets the parameter with neither: its pools are its own all the same.
  if (!profile && config.connectionId === undefined) return config.connectionString;
  const parsed = parseDbUrl(config.connectionString);
  if (parsed.kind !== "url") return config.connectionString; // nothing to add it to; the driver says what is wrong
  const id = endpointId(profile ?? {}, config);
  profiles.set(id, profile ?? {});
  return buildDbUrl({ ...parsed.parts, params: [...parsed.parts.params, [ENDPOINT_PARAM, id]] });
}

/** The URL a driver may see, and the endpoint the parameter named. */
export function takeEndpoint(connectionString: string): { url: string; endpoint: Endpoint | null } {
  const parsed = parseDbUrl(connectionString);
  if (parsed.kind !== "url") return { url: connectionString, endpoint: null };
  const { parts } = parsed;
  const index = parts.params.findIndex(([name]) => name === ENDPOINT_PARAM);
  if (index < 0) return { url: connectionString, endpoint: null };
  const id = parts.params[index]![1];
  const profile = profiles.get(id);
  if (!profile) throw new Error("PPM no longer holds this connection's tunnel settings. Open the connection again.");
  const bare = { ...parts, params: parts.params.filter((_, i) => i !== index) };
  return {
    url: buildDbUrl(bare),
    endpoint: { id, profile, target: { host: bare.host || "localhost", port: bare.port ?? DEFAULT_PORT[bare.type] } },
  };
}

/** What Node's TLS takes from the SSL tab, read now: a certificate replaced on disk is used by the next pool. */
export interface CertificateFiles {
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  passphrase?: string;
}

export function readCertificateFiles(files: SslFileSettings): CertificateFiles {
  return {
    ...(files.ca ? { ca: readHostFile(files.ca, "CA certificate") } : {}),
    ...(files.cert ? { cert: readHostFile(files.cert, "certificate") } : {}),
    ...(files.key ? { key: readHostFile(files.key, "key file") } : {}),
    ...(files.keyPassword ? { passphrase: files.keyPassword } : {}),
  };
}

function endpointOf(config: EndpointConfig): Endpoint | null {
  if (config.type === "sqlite") return null;
  return takeEndpoint(serviceConnectionString(config)).endpoint;
}

/** The SSH servers `config`'s live tunnel went through, bastion first; null without one. */
export function endpointSshHops(config: EndpointConfig): SshHop[] | null {
  const endpoint = endpointOf(config);
  return endpoint?.profile.ssh ? sshTunnelHops(endpoint.id, endpoint.target) : null;
}

/** Close the SSH sessions `config` opened. Its pools are the services' to close. */
export function closeEndpoint(config: EndpointConfig): void {
  let endpoint: Endpoint | null;
  try {
    endpoint = endpointOf(config);
  } catch {
    return; // a config that cannot be read opened nothing
  }
  if (!endpoint) return;
  closeSshTunnels(endpoint.id);
  // A scope is one test's: nothing will ask for its profile again.
  if (config.endpointScope) profiles.delete(endpoint.id);
}
