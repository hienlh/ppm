import type { RestartEntry } from "../../shared/restart-news.ts";
import { cleanDetail, type StartReason } from "./start-reason.ts";

/**
 * Every server run, start to clean stop, so the next start can say what came before it. Kept in a
 * config row of the database the server runs on (not a file in the PPM folder): a dev server on
 * `ppm.dev.db` shares that folder with the live one, and must never read the live one's runs as
 * its own.
 *
 * A run that never wrote its stop was killed — by the supervisor (which then leaves a note saying
 * why: `ordered-stop-note.ts`), an OOM killer, a power cut, a crash Bun could not report. When
 * nobody named the start and no note explains the stop (a server started some other way, or an
 * older supervisor), a missing stop is reported as a crash of unknown cause.
 */

export const SERVER_RUN_LOG_ROW = "server_run_log";
const MAX_RUNS = 20;

export interface ServerRun {
  pid: number;
  version: string;
  startedAt: number;
  startReason?: string;
  stoppedAt?: number;
  stopTrigger?: string;
}

export interface RunLogStore {
  load(): string | null;
  save(json: string): void;
}

export interface ServerStart {
  /** This run as recorded. */
  run: ServerRun;
  /** The run before it, as it was left; null on the first recorded start. */
  previous: ServerRun | null;
  /** What the Assistant is told about this start. */
  restart: RestartEntry;
}

function readRuns(store: RunLogStore): ServerRun[] {
  try {
    const raw = JSON.parse(store.load() ?? "null") as { version?: number; runs?: unknown } | null;
    if (raw?.version !== 1 || !Array.isArray(raw.runs)) return [];
    return raw.runs.filter((r): r is ServerRun => !!r && typeof r === "object"
      && typeof (r as ServerRun).pid === "number" && typeof (r as ServerRun).version === "string"
      && typeof (r as ServerRun).startedAt === "number");
  } catch {
    return [];
  }
}

const writeRuns = (store: RunLogStore, runs: ServerRun[]) =>
  store.save(JSON.stringify({ version: 1, runs: runs.slice(-MAX_RUNS) }));

/**
 * The restart this start amounts to, from what the supervisor said and what the last run left.
 * `orderedStop` is the supervisor's note that it stopped the previous run on purpose (a restart, a
 * stop, an upgrade, the health check): on Windows it ends the server without letting it write its
 * own stop, so only that note tells a deliberate restart from a crash there.
 */
export function describeStart(
  now: number, version: string, given: StartReason | null, previous: ServerRun | null, orderedStop: string | null = null,
): RestartEntry {
  const wroteStop = previous ? previous.stoppedAt !== undefined : undefined;
  // "Not clean" is only said of a stop nothing explains: no stop written and none ordered.
  const cleanStop = previous ? (wroteStop || orderedStop ? true : false) : undefined;
  let kind = given?.kind ?? "unknown";
  let detail = given?.detail;
  // Nobody said why, and the last run left no stop behind: it died.
  if (!given && previous && !cleanStop) {
    kind = "crash";
    detail = "the previous run stopped without shutting down (crash, kill or power loss; cause unknown)";
  }
  return {
    at: now, kind, toVersion: version,
    ...(detail ? { detail } : {}),
    ...(previous && previous.version !== version ? { fromVersion: previous.version } : {}),
    ...(cleanStop !== undefined ? { cleanStop } : {}),
    ...(previous && !wroteStop && orderedStop ? { stopOrderedBy: orderedStop.slice(0, 100) } : {}),
    ...(previous?.stoppedAt !== undefined ? { stoppedAt: previous.stoppedAt } : {}),
    ...(previous?.stopTrigger ? { stopTrigger: previous.stopTrigger } : {}),
  };
}

/** Records this run's start. Never throws: a log that cannot be written must not stop the server. */
export function recordServerStart(
  store: RunLogStore,
  opts: { now: number; pid: number; version: string; given: StartReason | null; orderedStopOf?: (previous: ServerRun) => string | null },
): ServerStart {
  const runs = readRuns(store);
  const previous = runs.at(-1) ?? null;
  let orderedStop: string | null = null;
  try { orderedStop = previous && opts.orderedStopOf ? opts.orderedStopOf(previous) : null; } catch { /* unexplained, as before */ }
  const restart = describeStart(opts.now, opts.version, opts.given, previous, orderedStop);
  const run: ServerRun = { pid: opts.pid, version: opts.version, startedAt: opts.now, startReason: restart.kind };
  try { writeRuns(store, [...runs, run]); } catch { /* the news still goes out; only the next start knows less */ }
  return { run, previous, restart };
}

/** Records a clean stop of the run that started at `startedAt`. Never throws. */
export function recordServerStop(store: RunLogStore, startedAt: number, opts: { now: number; trigger: string }): void {
  try {
    const runs = readRuns(store);
    const run = runs.findLast((r) => r.startedAt === startedAt);
    if (!run) return;
    run.stoppedAt = opts.now;
    const trigger = cleanDetail(opts.trigger);
    if (trigger) run.stopTrigger = trigger.slice(0, 100);
    writeRuns(store, runs);
  } catch { /* nothing to do on the way out */ }
}
