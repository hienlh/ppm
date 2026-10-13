/** One run of a prompt schedule: its session, its turn, and the row that records them. */
import type { Schedule, SchedulerRunner } from "../types/scheduler.ts";
import { createLogger } from "./logger.ts";
import { updateScheduleRun } from "./scheduler-db.service.ts";

const log = createLogger("scheduler");

export async function executePromptRun(runner: Pick<SchedulerRunner, "ensureScheduleSession" | "runScheduleOnce">, schedule: Schedule, runId: number): Promise<void> {
  const startedAt = Date.now();
  try {
    const sessionId = await runner.ensureScheduleSession(schedule);
    if (sessionId !== schedule.session_id) {
      updateScheduleRun(runId, { session_id: sessionId });
      schedule = { ...schedule, session_id: sessionId };
    }
    const result = await runner.runScheduleOnce(schedule, sessionId);
    updateScheduleRun(runId, {
      status: result.status,
      output_truncated: result.output || null,
      context_window_pct: result.contextWindowPct ?? null,
      cost_usd: result.costUsd ?? null,
      error: result.error ?? null,
      rotated_to_session_id: result.rotatedToSessionId ?? null,
      ended_at: new Date().toISOString(),
    });
    const summary = `Schedule ${schedule.id} run ${runId} ${result.status} in ${Date.now() - startedAt}ms`
      + (result.costUsd != null ? ` cost=$${result.costUsd.toFixed(4)}` : "")
      + (result.contextWindowPct != null ? ` ctx=${result.contextWindowPct}%` : "");
    if (result.status === "error") log.error(`${summary}: ${(result.error ?? "unknown error").slice(0, 300)}`);
    else log.info(summary);
  } catch (e) {
    log.error(`Schedule ${schedule.id} (${schedule.name}) run ${runId} failed after ${Date.now() - startedAt}ms:`, e);
    updateScheduleRun(runId, {
      status: "error",
      error: (e as Error).message,
      ended_at: new Date().toISOString(),
    });
  }
}
