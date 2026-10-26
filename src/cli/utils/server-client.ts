import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPpmDir } from "../../services/ppm-dir.ts";

/**
 * How a CLI command talks to the PPM server that is already running, instead of writing to the
 * database behind its back (which the server, holding config in memory, would never see).
 *
 * The address is always 127.0.0.1: the port comes from `<ppm dir>/status.json`, which the
 * supervisor writes, else from the `port` setting (a foreground `__serve__` run writes no
 * status file). The token is sent only when auth is on. Nothing here is taken from a file but a
 * port, validated as one.
 */

export const SERVER_DOWN_MESSAGE = "PPM server not running — start with `ppm start`";
/** How long the server gets to say it is there before the CLI calls it down. */
const PROBE_TIMEOUT_MS = 3_000;

export class ServerDownError extends Error {
  constructor(message = SERVER_DOWN_MESSAGE) {
    super(message);
    this.name = "ServerDownError";
  }
}

/** The server answered, with an error. `code` is the route's own code when it sent one. */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export interface ServerAddress {
  baseUrl: string;
  token: string | null;
}

/** The port in `status.json`, or null when the file is missing, unreadable or not a port. */
export function readStatusPort(ppmDir: string): number | null {
  const file = resolve(ppmDir, "status.json");
  if (!existsSync(file)) return null;
  try {
    const port = (JSON.parse(readFileSync(file, "utf-8")) as { port?: unknown }).port;
    return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

export interface ServerConfig {
  port: number;
  auth: { enabled: boolean; token: string };
}

async function loadServerConfig(): Promise<ServerConfig> {
  const { configService } = await import("../../services/config.service.ts");
  configService.load();
  return { port: configService.get("port"), auth: configService.get("auth") };
}

export async function resolveServer(
  ppmDir: string = getPpmDir(),
  readConfig: () => Promise<ServerConfig> = loadServerConfig,
): Promise<ServerAddress> {
  const config = await readConfig();
  const port = readStatusPort(ppmDir) ?? config.port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token: config.auth?.enabled && config.auth.token ? config.auth.token : null,
  };
}

/**
 * Whether something answers as PPM at that address within 3 s. A port can be held open by a
 * process that never answers (a wedged server), and the real call would then wait out its
 * whole timeout before saying anything.
 */
async function probe(server: ServerAddress): Promise<boolean> {
  try {
    const res = await fetch(`${server.baseUrl}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * One request to the running server. Resolves with the envelope's `data`; throws
 * `ServerDownError` when nothing answers, `HttpError` when the server answers with an error.
 * `timeoutMs` is how long the server itself may take; the CLI gives it 5 s more on top.
 */
export async function callServer<T>(
  method: "GET" | "POST" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number; server?: ServerAddress } = {},
): Promise<T> {
  const server = opts.server ?? await resolveServer();
  if (!(await probe(server))) throw new ServerDownError();

  const headers: Record<string, string> = {};
  if (server.token) headers.Authorization = `Bearer ${server.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${server.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout((opts.timeoutMs ?? 5_000) + 5_000),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new HttpError(0, "PPM server did not answer in time");
    }
    throw new ServerDownError();
  }

  type Envelope = { ok?: boolean; data?: T; error?: string; code?: string };
  let envelope: Envelope | null = null;
  try {
    envelope = await res.json() as Envelope;
  } catch { /* not JSON: reported by status below */ }
  if (res.ok && envelope?.ok) return envelope.data as T;
  throw new HttpError(res.status, envelope?.error || `HTTP ${res.status}`, typeof envelope?.code === "string" ? envelope.code : undefined);
}
