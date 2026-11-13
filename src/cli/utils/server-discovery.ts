import { basename } from "node:path";
import { connect } from "node:net";
import { unlinkSync } from "node:fs";
import { readServerEndpoints, type ServerEndpoint } from "../../services/server-endpoint-file.ts";
import { helloProofMatches, newHelloNonce } from "../../services/cli-hello-proof.ts";
import { pidAlive } from "../../services/share-host/share-host-status.ts";

/**
 * Which running PPM server, if any, holds a database — and whether it can be trusted with the token.
 *
 * - One live endpoint file for the database: that server. Several: the one `--instance` or
 *   `PPM_INSTANCE_ID` names, else a refusal listing them (guessing would write to the wrong one).
 * - None: the database is free only if no supervisor of this profile is alive and nothing answers
 *   on the configured port. Anything that might be a PPM but never said so is a refusal, never a
 *   direct write over it.
 * - Before the token is sent anywhere, the server proves it holds it (`cli-hello-proof.ts`), and
 *   its URL must be plain http on a loopback address.
 */
export type Discovery =
  | { kind: "server"; endpoint: ServerEndpoint }
  | { kind: "none" }
  | { kind: "refused"; reason: string };

export interface DiscoveryInput {
  dbFile: string;
  profile: string | null;
  token: string;
  configPort: number;
  /** `--instance`: must match. */
  strictInstance?: string;
  /** `PPM_INSTANCE_ID`: preferred when it names a live server on this database. */
  preferredInstance?: string;
  dir?: string;
  /** The supervisor's status.json, as read now. */
  supervisorStatus?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  portAnswers?: (port: number) => Promise<boolean>;
  /** Whether anything accepts a connection on an endpoint's identity-check port (defaults to `portAnswers`'s probe). */
  endpointAnswers?: (port: number) => Promise<boolean>;
}

const matches = (e: ServerEndpoint, id: string) => e.instanceId === id || String(e.pid) === id;

/**
 * A pid can be reused (Windows hands a dead server's pid to the next process quickly), so a file
 * whose process "is alive" may still name a server that is gone. One whose identity-check port
 * refuses the connection is stale: it is removed and the choice is made again without it, which
 * lets the "nothing holds this database" check below run as if the file had never been there.
 */
export async function discoverServer(input: DiscoveryInput): Promise<Discovery> {
  const stale = new Set<string>();
  for (;;) {
    const found = await discoverOnce(input, stale);
    if (found !== "stale") return found;
  }
}

async function discoverOnce(input: DiscoveryInput, stale: Set<string>): Promise<Discovery | "stale"> {
  const db = basename(input.dbFile);
  const files = readServerEndpoints(input.dbFile, input.dir).filter((f) => f.alive && !stale.has(f.file));
  const live = files.map((f) => f.endpoint);
  let pick: ServerEndpoint | undefined;
  if (input.strictInstance) {
    pick = live.find((e) => matches(e, input.strictInstance!));
    if (!pick) return { kind: "refused", reason: `No running PPM on ${db} is instance ${input.strictInstance}${pidList(live)}` };
  } else if (input.preferredInstance) {
    pick = live.find((e) => matches(e, input.preferredInstance!));
  }
  if (!pick && live.length > 1) {
    for (const f of files) {
      if (await endpointUnreachable(f.endpoint, input)) return dropStale(f.file, stale);
    }
    return { kind: "refused", reason: `${live.length} PPM servers share ${db}${pidList(live)}. Pick one with \`ppm --instance <pid> …\`.` };
  }
  pick ??= live[0];
  if (!pick) return provablyFree(input, db);
  const url = loopbackUrl(pick.baseUrl);
  if (!url) return { kind: "refused", reason: `The PPM on ${db} (pid ${pick.pid}) is not on a loopback address (${pick.baseUrl})` };
  const proven = await proveIdentity(url, pick, input);
  if (proven === "unreachable") return dropStale(files.find((f) => f.endpoint === pick)!.file, stale);
  return proven === "proven" ? { kind: "server", endpoint: { ...pick, baseUrl: url } } : {
    kind: "refused",
    reason: `The server at ${url} (pid ${pick.pid}) did not prove it holds ${db}'s token, so nothing was sent to it`,
  };
}

const pidList = (live: ServerEndpoint[]) => (live.length ? ` (running: pids ${live.map((e) => e.pid).join(", ")})` : "");

async function provablyFree(input: DiscoveryInput, db: string): Promise<Discovery> {
  const status = input.supervisorStatus ?? {};
  const statusProfile = typeof status.profile === "string" && status.profile ? status.profile : null;
  if (pidAlive(status.supervisorPid) && statusProfile === input.profile) {
    return { kind: "refused", reason: `A supervised PPM (pid ${status.supervisorPid}) is running on ${db} but has not published where to reach it — it may be restarting, or an older version. Try again, or restart it.` };
  }
  const answers = await (input.portAnswers ?? portAnswers)(input.configPort);
  if (answers) {
    return { kind: "refused", reason: `Something is listening on port ${input.configPort} (${db}'s configured port) but no PPM there said it holds ${db}. Stop it, or restart PPM, then try again.` };
  }
  return { kind: "none" };
}

/** `baseUrl` normalized, if it is plain http on a loopback host with no credentials; else null. */
export function loopbackUrl(baseUrl: string): string | null {
  let u: URL;
  try { u = new URL(baseUrl); } catch { return null; }
  if (u.protocol !== "http:" || u.username || u.password || !u.port) return null;
  if (u.pathname !== "/" || u.search || u.hash) return null;
  const h = u.hostname;
  const loopback = h === "localhost" || h === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
  return loopback ? `http://${h}:${u.port}` : null;
}

function dropStale(file: string, stale: Set<string>): "stale" {
  stale.add(file);
  try { unlinkSync(file); } catch { /* already gone, or not ours to remove: skipped either way */ }
  return "stale";
}

/** Where an endpoint answers the identity check: its own port unless it names another. */
function helloTarget(e: ServerEndpoint, url: string): { host: string; port: number; url: string } {
  const u = new URL(url);
  const port = e.helloPort ?? Number(u.port);
  return { host: u.hostname.replace(/^\[|\]$/g, ""), port, url: `${u.protocol}//${u.hostname}:${port}` };
}

/** True when nothing at all accepts a connection on the endpoint's identity-check port. */
async function endpointUnreachable(e: ServerEndpoint, input: DiscoveryInput): Promise<boolean> {
  const url = loopbackUrl(e.baseUrl);
  if (!url) return false;
  const t = helloTarget(e, url);
  const answers = await (input.endpointAnswers ?? ((p: number) => portAnswers(p, t.host)))(t.port).catch(() => true);
  return !answers;
}

/**
 * Asks the server to prove it holds the token, on its identity-check port (the server's own unless
 * the endpoint names another), for the port `url` names: the one the token would then go to.
 * "unreachable" only when the request failed and nothing listens on that port at all.
 */
async function proveIdentity(url: string, e: ServerEndpoint, input: DiscoveryInput): Promise<"proven" | "unproven" | "unreachable"> {
  const nonce = newHelloNonce();
  const mainPort = Number(new URL(url).port);
  try {
    const res = await (input.fetchImpl ?? fetch)(`${helloTarget(e, url).url}/api/cli/hello?nonce=${nonce}`, {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return "unproven";
    const json = await res.json() as { ok?: boolean; data?: { instanceId?: string; dbFile?: string; proof?: string } };
    const d = json?.data;
    if (!json?.ok || !d || d.instanceId !== e.instanceId || d.dbFile !== basename(input.dbFile)) return "unproven";
    return helloProofMatches(input.token, nonce, e.instanceId, mainPort, d.proof) ? "proven" : "unproven";
  } catch {
    return await endpointUnreachable(e, input) ? "unreachable" : "unproven";
  }
}

/** True when something accepts a TCP connection on `host`:`port`. A timeout counts as an answer. */
export function portAnswers(port: number, host = "127.0.0.1"): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (v: boolean) => { sock.destroy(); resolve(v); };
    sock.setTimeout(1_000, () => done(true));
    sock.once("connect", () => done(true));
    sock.once("error", (err: NodeJS.ErrnoException) => done(err.code !== "ECONNREFUSED"));
  });
}
