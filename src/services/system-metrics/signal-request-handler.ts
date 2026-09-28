/**
 * The signal decision chain, transport-free like the kill one and deliberately
 * built from the SAME parts: parse → live re-query → identity check → guard on
 * the FRESH name → execute.
 *
 * The guard is `checkKillAllowed` unchanged. A SIGSTOP on systemd wedges the
 * machine as thoroughly as a SIGKILL would, and SIGSTOP on PPM's own supervisor
 * hangs every session — "can this process be signalled" and "can this process be
 * ended" are the same question, so they must not be two lists that can drift.
 */
import type {
  MetricsPlatform, ProcessSignal, SignalProcessRequest, SignalProcessResult,
} from "../../types/system-metrics.ts";
import { PROCESS_SIGNALS } from "../../types/system-metrics.ts";
import { ok, err, type ApiResponse } from "../../types/api.ts";
import type { ProcessCollector } from "./process-collector-types.ts";
import { identityMatches, resolveLiveProcess } from "./kill-identity-resolver.ts";
import { checkKillAllowed } from "./kill-guard.ts";
import type { ProtectedPids } from "./ppm-protected-pids.ts";

export interface SignalHandlerDeps {
  platform: MetricsPlatform;
  collector: ProcessCollector;
  resolveProtected: (isAlive: (pid: number) => boolean, nameOf: (pid: number) => string | undefined) => ProtectedPids;
  execute: (pid: number, signal: ProcessSignal, tree: boolean) => Promise<SignalProcessResult>;
  /** Signals this host can deliver; anything else is a 400 before any re-query. */
  supported: readonly ProcessSignal[];
  /** Audit line: pid + name + signal + result ONLY. `~/.ppm/ppm.log`'s tail is
   *  served unauthenticated by `/api/logs/recent`, so no command line here. */
  log: (line: string) => void;
}

export type SignalStatus = 200 | 400 | 403 | 404 | 409 | 500;

export interface SignalOutcome {
  status: SignalStatus;
  body: ApiResponse<SignalProcessResult>;
}

export function parseSignalRequest(body: unknown): SignalProcessRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.pid !== "number" || !Number.isInteger(b.pid) || b.pid <= 0) return null;
  if (typeof b.startedAt !== "number" || !Number.isFinite(b.startedAt) || b.startedAt < 0) return null;
  if (b.tree !== undefined && typeof b.tree !== "boolean") return null;
  if (typeof b.signal !== "string" || !PROCESS_SIGNALS.includes(b.signal as ProcessSignal)) return null;
  return { pid: b.pid, startedAt: b.startedAt, signal: b.signal as ProcessSignal, tree: b.tree === true };
}

export async function handleSignalRequest(body: unknown, deps: SignalHandlerDeps): Promise<SignalOutcome> {
  const req = parseSignalRequest(body);
  if (!req) {
    return { status: 400, body: err(`Body must be {pid, startedAt, signal: one of ${PROCESS_SIGNALS.join("|")}, tree?}`) };
  }
  if (!deps.supported.includes(req.signal)) {
    return { status: 400, body: err(`This host cannot deliver SIG${req.signal}`) };
  }
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
  const prefix = `[SystemMetrics] signal=${req.signal} pid=${live.pid} name=${live.name} tree=${tree}`;
  if (!verdict.allowed) {
    deps.log(`${prefix} → refused: ${verdict.reason}`);
    return { status: 403, body: err(verdict.reason ?? "Refused") };
  }

  deps.log(`${prefix} → allowed`);
  try {
    const result = await deps.execute(live.pid, req.signal, tree);
    deps.log(`${prefix} → done (${result.signalled.length} signalled)`);
    return { status: 200, body: ok(result) };
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    deps.log(`${prefix} → failed: ${message}`);
    return { status: 500, body: err(`Failed to signal PID ${live.pid}: ${message}`) };
  }
}
