/**
 * One tick of a script schedule: its process runs to the end (or to the schedule's timeout),
 * then the state it left is kept — after a failed tick too, so a half-done batch is not done
 * twice. A tick keeps a run row only when it has something to show, a log line or an error: a
 * 15-second schedule that is quiet would otherwise bury its history under empty rows.
 */
import type { Schedule } from "../../types/scheduler.ts";
import { createLogger } from "../logger.ts";
import { getSchedule, insertFinishedRun } from "../scheduler-db.service.ts";
import { saveState } from "./ctx-state.ts";
import { launchScript, type Launch } from "./script-launch.ts";

const log = createLogger("scheduler");

export async function runScriptTick(schedule: Schedule, launch: Launch = launchScript): Promise<void> {
  const startedAt = Date.now();
  const launched = launch(schedule);
  if ("error" in launched) {
    log.warn(`Schedule ${schedule.id} (${schedule.name}) could not run: ${launched.error}`);
    insertFinishedRun(schedule.id, { status: "error", startedAt, output: "", error: launched.error });
    return;
  }
  const { child, log: runLog, mask } = launched;
  const timer = setTimeout(() => {
    void child.stop(`it ran past its timeout of ${Math.round(schedule.timeout_ms / 1000)} s`);
  }, schedule.timeout_ms);
  const exit = await child.exited.finally(() => clearTimeout(timer));
  // Deleted while it ran: there is no schedule left to keep anything for.
  if (!getSchedule(schedule.id)) return;

  const errors = exit.error ? [mask(exit.error)] : [];
  if (exit.state !== null) {
    try {
      saveState(schedule.id, exit.state);
    } catch (e) {
      errors.push(`ctx.state was not saved: ${(e as Error).message}`);
    }
  }
  const error = errors.length ? errors.join("\n") : null;
  if (error) log.warn(`Schedule ${schedule.id} (${schedule.name}) tick failed after ${Date.now() - startedAt} ms: ${error.split("\n")[0]}`);
  if (!error && runLog.lines === 0) return;
  insertFinishedRun(schedule.id, {
    status: error ? "error" : "done", startedAt, output: runLog.output.toString(), error,
    ...(launched.costUsd() > 0 && { costUsd: launched.costUsd() }),
  });
}
