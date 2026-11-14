import { VERSION } from "../../version.ts";
import { createLogger } from "../logger.ts";
import { getConfigValue, setConfigValue } from "../db.service.ts";
import { readStartReasonEnv, START_DETAIL_ENV, START_REASON_ENV } from "./start-reason.ts";
import { getPpmDir } from "../ppm-dir.ts";
import { takeOrderedStop } from "./ordered-stop-note.ts";
import { recordServerStart, recordServerStop, SERVER_RUN_LOG_ROW, type ServerStart } from "./server-run-log.ts";

/**
 * This server process's run, recorded at boot and at a clean stop. Kept apart from the news
 * itself so the boot path loads nothing of the PPM Assistant: it only needs the database.
 */

const log = createLogger("restart-news");
const runLog = { load: () => getConfigValue(SERVER_RUN_LOG_ROW), save: (json: string) => setConfigValue(SERVER_RUN_LOG_ROW, json) };

let current: ServerStart | null = null;

/** This process's start, once {@link noteServerStart} recorded it. */
export const currentServerStart = (): ServerStart | null => current;

/**
 * Records this server run. Called once at boot, after the database opens; the supervisor's reason
 * is read and then removed from the environment, so no child the server spawns carries it on.
 */
export function noteServerStart(now = Date.now()): ServerStart | null {
  if (current) return current;
  try {
    const given = readStartReasonEnv(process.env);
    delete process.env[START_REASON_ENV];
    delete process.env[START_DETAIL_ENV];
    current = recordServerStart(runLog, {
      now, pid: process.pid, version: VERSION, given,
      orderedStopOf: (previous) => takeOrderedStop(getPpmDir(), previous, now),
    });
    const r = current.restart;
    log.info(`Server run started: ${r.kind}${r.detail ? ` (${r.detail})` : ""}`
      + `${r.fromVersion ? `, ${r.fromVersion} → ${r.toVersion}` : ""}`
      + `${r.stopOrderedBy ? `, previous run stopped by the supervisor (${r.stopOrderedBy})` : r.cleanStop === false ? ", previous run did not stop cleanly" : ""}`);
  } catch (e) {
    log.warn(`could not record this server run: ${(e as Error).message}`);
  }
  return current;
}

/** Records a clean stop. Synchronous: `process.exit` follows. */
export function noteServerStop(trigger: string): void {
  if (!current) return;
  recordServerStop(runLog, current.run.startedAt, { now: Date.now(), trigger });
}

/** For tests: forget this process's start. */
export function _resetServerRun(): void {
  current = null;
}
