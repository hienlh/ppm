/** Shared by the `ppm schedule` commands: output helpers, and the running server's REST API. */
import type { ScheduleStatusView } from "../../types/scheduler.ts";

export const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

export const fail = (msg: string): never => {
  console.error(`${C.red}✗${C.reset} ${msg}`);
  process.exit(1);
};

/** No PPM server answered: the command can only go to the database, or not run at all. */
export class ServerDownError extends Error {}

/**
 * `/api<path>` on the PPM server of this CLI's config, signed in. Script schedules are changed
 * through it, because only the server can start or stop their processes. Call after
 * `configService.load()`.
 */
export async function serverApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { configService } = await import("../../services/config.service.ts");
  const auth = configService.get("auth");
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${configService.get("port")}/api${path}`, {
      method,
      headers: {
        ...(auth.enabled && { Authorization: `Bearer ${auth.token}` }),
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A delete waits for the schedule's process to stop.
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ServerDownError("PPM server not running — start with 'ppm start'");
  }
  const json = await res.json().catch(() => null) as { ok?: boolean; data?: T; error?: string } | null;
  if (!json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json.data as T;
}

/** `serverApi`, failing the command on any error. */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await serverApi<T>(method, path, body);
  } catch (e) {
    return fail((e as Error).message);
  }
}

/** What a script schedule's process is doing, in a few words; empty when there is nothing to say. */
export function statusText(s: ScheduleStatusView): string {
  switch (s.state) {
    case "running": return `${C.green}running${C.reset}${s.pid ? ` (pid ${s.pid})` : ""}`;
    case "restarting": return `${C.yellow}restarting${s.restartAt ? ` at ${new Date(s.restartAt).toLocaleTimeString()}` : ""}${C.reset}`;
    case "failed": return `${C.red}failed${C.reset}${s.lastError ? `: ${s.lastError.split("\n")[0]!.slice(0, 80)}` : ""}`;
    case "blocked": return `${C.red}blocked${C.reset}: previous process (pid ${s.pid}) is still running`;
    case "starting":
    case "stopping": return `${C.yellow}${s.state}${C.reset}`;
    default: return "";
  }
}
