/**
 * The one shape a schedule leaves the server in. A raw row carries `secrets_enc` (the secrets,
 * encrypted but still not for a browser) and `state_json` (whatever a script kept, a token
 * included): every route answers through `toScheduleView`, never with the row.
 */
import type { Schedule, ScheduleInputDecl, ScheduleInputValue, ScheduleStatusView, ScheduleView } from "../types/scheduler.ts";
import { blockedBy, liveScript } from "./schedule-script/instance-guard.ts";
import { readSecrets } from "./schedule-script/schedule-secrets.ts";
import { getRuntime } from "./schedule-script/script-runtime-db.ts";
import { alwaysOnSupervisor, schedulerService } from "./scheduler.service.ts";

export function toScheduleView(s: Schedule): ScheduleView {
  const { secrets_enc, state_json, inputs_json, input_values_json, ...rest } = s;
  return {
    ...rest,
    inputs: parseOr<ScheduleInputDecl[]>(inputs_json, []),
    inputValues: parseOr<Record<string, ScheduleInputValue>>(input_values_json, {}),
    secretsSet: secretKeys(s),
    status: scheduleStatus(s),
  };
}

export function scheduleStatus(s: Schedule): ScheduleStatusView {
  const idle: ScheduleStatusView = { state: "idle", pid: null, since: null, restartAt: null, restarts: 0, lastError: null };
  if (s.kind === "prompt") return { ...idle, state: schedulerService.isRunning(s.id) ? "running" : "idle" };
  const blocker = blockedBy(s.id);
  if (blocker !== null) {
    return { ...idle, state: "blocked", pid: blocker, lastError: `Its previous process (pid ${blocker}) is still running and could not be stopped` };
  }
  if (s.mode === "always-on") {
    const live = alwaysOnSupervisor.status(s.id);
    if (live) return live;
    return { ...idle, state: s.enabled ? "starting" : "stopped", lastError: getRuntime(s.id)?.last_error ?? null };
  }
  const child = liveScript(s.id);
  return child ? { ...idle, state: "running", pid: child.pid } : idle;
}

/** Keys of the secrets saved; none when they cannot be read with this PPM's key. */
export function secretKeys(s: Pick<Schedule, "secrets_enc">): string[] {
  try {
    return Object.keys(readSecrets(s));
  } catch {
    return [];
  }
}

function parseOr<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
