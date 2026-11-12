/** Shared by the `ppm schedule` commands: output helpers, and the running server's REST API. */
import type { ScheduleStatusView } from "../../types/scheduler.ts";
import { serverRequest } from "../utils/ppm-server-client.ts";

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

/**
 * `/api<path>` on the running PPM that holds this command's database, signed in once it has proven
 * who it is. Script schedules are changed through it, because only the server can start or stop
 * their processes. A delete waits for the schedule's process to stop, within the client's 30 s.
 */
export { serverRequest as serverApi, ServerDownError } from "../utils/ppm-server-client.ts";

/** `serverApi`, failing the command on any error. */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await serverRequest<T>(method, path, body);
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
