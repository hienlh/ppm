/**
 * Everything one run of a script schedule needs before its process starts: the inputs with
 * the secrets decrypted, a log that masks them, the state, the script on disk, the ctx host.
 * Shared by the tick runner and the always-on supervisor. Answers an error instead of a child
 * when the schedule cannot run as saved.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { missingRequiredInputs, resolveInputValues } from "../../shared/schedule-inputs.ts";
import type { Schedule, ScheduleInputDecl, ScheduleInputValue } from "../../types/scheduler.ts";
import { projectService } from "../project.service.ts";
import { ctxHost } from "./ctx-host.ts";
import { loadState } from "./ctx-state.ts";
import { blockedBy, liveScript, startScript } from "./instance-guard.ts";
import { readSecrets } from "./schedule-secrets.ts";
import { logRing, RunLog } from "./script-log.ts";
import { writeScriptFile } from "./script-files.ts";
import { secretMasker } from "./secret-mask.ts";
import type { ScriptProcess } from "./script-process.ts";

export interface Launched {
  child: ScriptProcess;
  log: RunLog;
  /** Hides the secrets in any text, such as the error the script ended with. */
  mask: (text: string) => string;
  /** What the run's `ai.ask` and `ai.chat` calls have cost so far. */
  costUsd: () => number;
}

export type Launch = (schedule: Schedule, opts?: { heartbeatTimeoutMs?: number }) => Launched | { error: string };

export const launchScript: Launch = (schedule, opts = {}) => {
  if (liveScript(schedule.id)) return { error: "It is already running" };
  const blocker = blockedBy(schedule.id);
  if (blocker !== null) return { error: `Its previous process (pid ${blocker}) is still running and could not be stopped` };
  if (!existsSync(schedule.project_path)) return { error: `The project folder ${schedule.project_path} does not exist` };

  let decls: ScheduleInputDecl[];
  let values: Record<string, ScheduleInputValue>;
  let secrets: Record<string, string>;
  try {
    decls = JSON.parse(schedule.inputs_json) as ScheduleInputDecl[];
    values = JSON.parse(schedule.input_values_json) as Record<string, ScheduleInputValue>;
    secrets = readSecrets(schedule);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const missing = missingRequiredInputs(decls, values, Object.keys(secrets));
  if (missing.length) return { error: `Fill in ${missing.join(", ")} before it can run` };

  const mask = secretMasker(Object.values(secrets));
  const log = new RunLog(logRing(schedule.id), mask);
  const host = ctxHost(schedule);
  let cost = 0;
  let child: ScriptProcess | null;
  try {
    child = startScript(schedule.id, {
      init: {
        schedule: { id: schedule.id, name: schedule.name, mode: schedule.mode },
        project: { name: projectName(schedule.project_path), path: schedule.project_path },
        inputs: resolveInputValues(decls, values, secrets),
        state: loadState(schedule),
        scriptPath: writeScriptFile(schedule.id, schedule.script ?? ""),
      },
      cwd: schedule.project_path,
      onCall: async (method, params) => {
        const result = await host(method, params);
        const spent = (result as { costUsd?: unknown } | null)?.costUsd;
        if (typeof spent === "number") cost += spent;
        return result;
      },
      onLine: (line) => log.push(line),
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs,
    });
  } catch (e) {
    return { error: `Could not start its process: ${mask((e as Error).message)}` };
  }
  if (!child) return { error: "It is already running" };
  return { child, log, mask, costUsd: () => cost };
};

function projectName(path: string): string {
  try {
    return projectService.resolve(path).name;
  } catch {
    return basename(path);
  }
}
