/**
 * The kill decision chain, transport-free so it is testable without Hono:
 *   parse → live re-query → identity check → guard on the FRESH name → execute.
 * Authorising against the snapshot would authorise against data up to one tick
 * old, and Windows recycles pids fast enough for that to matter.
 */
import type { KillProcessRequest, KillProcessResult, MetricsPlatform } from "../../types/system-metrics.ts";
import { ok, err, type ApiResponse } from "../../types/api.ts";
import type { ProcessCollector } from "./process-collector-types.ts";
import { identityMatches, resolveLiveProcess } from "./kill-identity-resolver.ts";
import { checkKillAllowed } from "./kill-guard.ts";
import type { ProtectedPids } from "./ppm-protected-pids.ts";

export interface KillHandlerDeps {
  platform: MetricsPlatform;
  collector: ProcessCollector;
  resolveProtected: (isAlive: (pid: number) => boolean, nameOf: (pid: number) => string | undefined) => ProtectedPids;
  execute: (pid: number, tree: boolean) => Promise<KillProcessResult>;
  /** Audit line: pid + name + result ONLY. `~/.ppm/ppm.log`'s tail is served
   *  unauthenticated by `/api/logs/recent`, so a command line must never land here. */
  log: (line: string) => void;
}

export type KillStatus = 200 | 400 | 403 | 404 | 409 | 500;

export interface KillOutcome {
  status: KillStatus;
  body: ApiResponse<KillProcessResult>;
}

export function parseKillRequest(body: unknown): KillProcessRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const pid = b.pid;
  const startedAt = b.startedAt;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt < 0) return null;
  if (b.tree !== undefined && typeof b.tree !== "boolean") return null;
  return { pid, startedAt, tree: b.tree === true };
}

export async function handleKillRequest(body: unknown, deps: KillHandlerDeps): Promise<KillOutcome> {
  const req = parseKillRequest(body);
  if (!req) return { status: 400, body: err("Body must be {pid: positive integer, startedAt: epoch ms, tree?: boolean}") };
  const tree = req.tree === true;

  const { live, maps } = await resolveLiveProcess(req.pid, deps.collector);
  if (!live) return { status: 404, body: err(`PID ${req.pid} is no longer running`) };
  if (!identityMatches(req.startedAt, live.startedAt)) {
    return { status: 409, body: err(`PID ${req.pid} was recycled — refresh and try again`) };
  }

  const protectedPids = deps.resolveProtected(
    (pid) => maps.byPid.has(pid),
    (pid) => maps.byPid.get(pid)?.name.toLowerCase(),
  );
  const verdict = checkKillAllowed({ pid: live.pid, name: live.name }, tree, {
    platform: deps.platform,
    protectedPids: protectedPids.pids,
    ppidOf: maps.ppidOf,
    startedAtOf: maps.startedAtOf,
  });
  const prefix = `[SystemMetrics] kill pid=${live.pid} name=${live.name} tree=${tree}`;
  if (!verdict.allowed) {
    deps.log(`${prefix} → refused: ${verdict.reason}`);
    return { status: 403, body: err(verdict.reason ?? "Refused") };
  }

  deps.log(`${prefix} → allowed`);
  try {
    const result = await deps.execute(live.pid, tree);
    deps.log(`${prefix} → done (${result.method}, ${result.killed.length} signalled)`);
    return { status: 200, body: ok(result) };
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    deps.log(`${prefix} → failed: ${message}`);
    return { status: 500, body: err(`Failed to end PID ${live.pid}: ${message}`) };
  }
}
