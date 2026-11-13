/**
 * A saved secret belongs to the place it was typed for. An edit that points a connection somewhere
 * else — another host, port, socket or login, another SSH server, bastion or SSH login — and types
 * no new secret must not carry the old one along, or the next Test or open sends the saved
 * password to wherever the edit pointed. So the URL's password, the SSH password and key
 * passphrase and the SSL key's password are dropped then, for every caller (the connection form
 * asks for them again, which is the point).
 *
 * The comparison is of where a login goes, not of the URL's text: a different database on the
 * same server, a changed `sslmode` or an extra parameter keep the secrets.
 */
import type { SshTunnelSettings, StoredConnectionConfig } from "../../shared/db-connection-config.ts";
import { DEFAULT_SSH_PORT } from "../../shared/db-connection-config.ts";
import { buildDbUrl, dbUrlTarget, parseDbUrl } from "../../shared/db-connection-url.ts";
import { hasPassword, withoutPasswords } from "../../shared/db-url-secret.ts";

type ServerConfig = Extract<StoredConnectionConfig, { connectionString: string }>;

const isServer = (config: StoredConnectionConfig): config is ServerConfig => config.type !== "sqlite";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Where a URL sends its login: the server (or socket) and the user. Null for no URL. */
export function urlEndpoint(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  const parsed = parseDbUrl(url);
  if (parsed.kind === "url") return `${dbUrlTarget(parsed.parts)}|${parsed.parts.user}`;
  // A string PPM cannot read: any change to it counts as a new place.
  return `unread:${url.trim()}`;
}

/** Where a tunnel sends its login; empty for none, since a tunnel that is off sends nothing. */
export function sshEndpoint(ssh: Pick<SshTunnelSettings, "enabled" | "host" | "port" | "user" | "bastionHost"> | undefined): string {
  if (!ssh?.enabled) return "";
  return `${ssh.host}:${ssh.port ?? DEFAULT_SSH_PORT}|${ssh.user}|${ssh.bastionHost ?? ""}`;
}

/** Whether `after` sends a login anywhere `before` did not. */
export function endpointChanged(before: StoredConnectionConfig, after: StoredConnectionConfig): boolean {
  if (before.type === "sqlite" || after.type === "sqlite") return before.type !== after.type;
  if (!isServer(before) || !isServer(after)) return true;
  return urlEndpoint(before.connectionString) !== urlEndpoint(after.connectionString) || sshEndpoint(before.ssh) !== sshEndpoint(after.ssh);
}

const typed = (record: unknown, key: string): boolean => isRecord(record) && typeof record[key] === "string" && record[key] !== "";

/** The secrets the request itself typed, as opposed to ones kept from what was saved. */
function sentSecrets(input: unknown) {
  const body = isRecord(input) ? input : {};
  return {
    url: typeof body.connectionString === "string" && hasPassword(body.connectionString),
    sshPassword: typed(body.ssh, "password"),
    sshPassphrase: typed(body.ssh, "passphrase"),
    sslKeyPassword: typed(body.ssl, "keyPassword"),
  };
}

/**
 * `after` with every secret it kept from `before` taken out when the endpoint changed. `input` is
 * the request's `connectionConfig`, which says what was typed now. `cleared` names what went.
 */
export function dropCarriedSecrets(
  before: StoredConnectionConfig, after: StoredConnectionConfig, input: unknown,
): { config: StoredConnectionConfig; cleared: string[] } {
  if (!isServer(after) || !endpointChanged(before, after)) return { config: after, cleared: [] };
  const sent = sentSecrets(input);
  const cleared: string[] = [];
  const config: ServerConfig = { ...after };

  const parsed = parseDbUrl(after.connectionString);
  if (!sent.url && hasPassword(after.connectionString) && parsed.kind === "url") {
    config.connectionString = buildDbUrl(withoutPasswords(parsed.parts));
    cleared.push("password");
  }
  if (config.ssh) {
    const ssh = { ...config.ssh };
    if (ssh.password && !sent.sshPassword) { delete ssh.password; cleared.push("SSH password"); }
    if (ssh.passphrase && !sent.sshPassphrase) { delete ssh.passphrase; cleared.push("SSH key passphrase"); }
    config.ssh = ssh;
  }
  if (config.ssl?.keyPassword && !sent.sslKeyPassword) {
    const ssl = { ...config.ssl };
    delete ssl.keyPassword;
    config.ssl = ssl;
    cleared.push("SSL key password");
  }
  return { config, cleared };
}
