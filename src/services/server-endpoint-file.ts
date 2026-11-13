import { basename, join } from "node:path";
import { chmodSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { getPpmDir } from "./ppm-dir.ts";
import { pidAlive } from "./share-host/share-host-status.ts";

/**
 * Where a running server can be reached, one file per server process:
 * `<ppm dir>/server-endpoint.<database file>.<pid>.json`.
 *
 * Per process because several servers on one database is ordinary (a dev server and a worktree's
 * beside it), and a single shared file would name whichever wrote last. The `ppm` CLI lists the
 * files for its database, keeps the live pids, and proves the server's identity (`cli-hello.ts`)
 * before it sends the token, so a stale file whose pid was reused gains nothing.
 */
export interface ServerEndpoint {
  pid: number;
  baseUrl: string;
  instanceId: string;
  /** The database file's name, e.g. `ppm.dev.db`. */
  dbFile: string;
  version: string;
  startedAt: string;
  /**
   * The loopback port that answers the CLI's identity check, when it is not the server's own: a
   * supervised server's own port is the one the edge relays the network to (`cli-hello-listener.ts`).
   */
  helloPort?: number;
}

const PREFIX = "server-endpoint.";
const SUFFIX = ".json";

export function endpointFilePath(dbFile: string, pid: number = process.pid, dir: string = getPpmDir()): string {
  return join(dir, `${PREFIX}${basename(dbFile)}.${pid}${SUFFIX}`);
}

/**
 * The URL a CLI on this machine reaches a server bound to `host` on. A wildcard or loopback bind is
 * reached on 127.0.0.1; a server bound to one specific address only on that address, which the
 * CLI then refuses unless it is a loopback one.
 */
export function endpointBaseUrl(port: number, host: string): string {
  const h = host.trim().toLowerCase();
  if (!h || h === "0.0.0.0" || h === "::" || h === "localhost" || h === "::ffff:0.0.0.0") return `http://127.0.0.1:${port}`;
  const addr = h.startsWith("::ffff:") && h.slice(7).includes(".") ? h.slice(7) : h;
  return `http://${addr.includes(":") ? `[${addr}]` : addr}:${port}`;
}

const STATE = Symbol.for("ppm.server-endpoint-file");
type State = { file: string | null; exitHook: boolean };
function state(): State {
  const g = globalThis as Record<symbol, unknown>;
  return (g[STATE] ??= { file: null, exitHook: false }) as State;
}

/** Write this server's endpoint file (tmp + rename, owner-only), and remove it on exit. */
export function publishServerEndpoint(info: { port: number; host: string; dbFile: string; version: string; instanceId: string; helloPort?: number }): string {
  const dir = getPpmDir();
  removeStaleEndpoints(info.dbFile, dir);
  const file = endpointFilePath(info.dbFile, process.pid, dir);
  const body: ServerEndpoint = {
    pid: process.pid,
    baseUrl: endpointBaseUrl(info.port, info.host),
    instanceId: info.instanceId,
    dbFile: basename(info.dbFile),
    version: info.version,
    startedAt: new Date().toISOString(),
    ...(validPort(info.helloPort) ? { helloPort: info.helloPort } : {}),
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  const s = state();
  s.file = file;
  if (!s.exitHook) {
    s.exitHook = true;
    process.on("exit", removeServerEndpoint);
  }
  return file;
}

export function removeServerEndpoint(): void {
  const s = state();
  if (!s.file) return;
  try { unlinkSync(s.file); } catch { /* already gone */ }
  s.file = null;
}

/** Every endpoint file for `dbFile`, with whether its process is still alive. */
export function readServerEndpoints(dbFile: string, dir: string = getPpmDir()): { endpoint: ServerEndpoint; file: string; alive: boolean }[] {
  const db = basename(dbFile);
  const out: { endpoint: ServerEndpoint; file: string; alive: boolean }[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!name.startsWith(`${PREFIX}${db}.`) || !name.endsWith(SUFFIX)) continue;
    const pid = Number(name.slice(PREFIX.length + db.length + 1, -SUFFIX.length));
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const file = join(dir, name);
    const endpoint = parseEndpoint(file);
    // The file must describe the process its name says, for the database its name says.
    if (!endpoint || endpoint.pid !== pid || endpoint.dbFile !== db) continue;
    out.push({ endpoint, file, alive: pidAlive(pid) });
  }
  return out;
}

const validPort = (p: unknown): p is number => typeof p === "number" && Number.isInteger(p) && p > 0 && p <= 65535;

function parseEndpoint(file: string): ServerEndpoint | null {
  try {
    const v = JSON.parse(readFileSync(file, "utf-8")) as Partial<ServerEndpoint>;
    if (typeof v.pid !== "number" || typeof v.baseUrl !== "string" || typeof v.instanceId !== "string"
      || typeof v.dbFile !== "string") return null;
    return { pid: v.pid, baseUrl: v.baseUrl, instanceId: v.instanceId, dbFile: v.dbFile,
      version: typeof v.version === "string" ? v.version : "", startedAt: typeof v.startedAt === "string" ? v.startedAt : "",
      ...(validPort(v.helloPort) ? { helloPort: v.helloPort } : {}) };
  } catch {
    return null;
  }
}

/** Files left by servers that died without removing theirs (a crash, a kill). */
function removeStaleEndpoints(dbFile: string, dir: string): void {
  for (const { file, alive, endpoint } of readServerEndpoints(dbFile, dir)) {
    if (!alive && endpoint.pid !== process.pid) {
      try { unlinkSync(file); } catch { /* another server removed it */ }
    }
  }
}
