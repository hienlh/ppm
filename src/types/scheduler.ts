/** Scheduled-agent types — rows in `schedules` / `schedule_runs` (snake_case mirrors SQLite). */

export type RunStatus = "running" | "done" | "error" | "skipped";

/** `prompt`: a message sent to the schedule's own chat. `script`: JavaScript run in a child process. */
export type ScheduleKind = "prompt" | "script";
/** `tick`: one short run per cron fire. `always-on`: a daemon PPM keeps alive. A prompt is always `tick`. */
export type ScheduleMode = "tick" | "always-on";
export type ScheduleInputType = "text" | "number" | "boolean" | "secret";
export type ScheduleInputValue = string | number | boolean;

/** An input a script schedule declares. Its value is stored apart from the declaration. */
export interface ScheduleInputDecl {
  key: string;
  label: string;
  type: ScheduleInputType;
  required?: boolean;
  /** Never on a secret: a template carrying one would be sharing it. */
  default?: ScheduleInputValue;
  description?: string;
}

export interface Schedule {
  id: number;
  name: string;
  cron_expr: string;
  provider_id: string;
  project_path: string;
  prompt: string;
  permission_mode: string;
  max_turns: number | null;
  timeout_ms: number;
  enabled: number;
  session_id: string | null;
  last_run_at: string | null;
  next_fire_at: string | null;
  created_at: string;
  updated_at: string;
  kind: ScheduleKind;
  mode: ScheduleMode;
  description: string;
  /** Script source; null for a prompt schedule. */
  script: string | null;
  /** JSON array of {@link ScheduleInputDecl}. */
  inputs_json: string;
  /** JSON object of the non-secret input values. */
  input_values_json: string;
  /** The secret input values, encrypted. Never leaves the server. */
  secrets_enc: string | null;
  /** The script's `ctx.state`, as JSON. */
  state_json: string | null;
}

/**
 * What a script schedule's process is doing. `starting`: on, and not started yet (the server is
 * still settling what the previous one left). `blocked`: a previous process could not be stopped,
 * so this one is not started at all.
 */
export type ScheduleRunState = "idle" | "running" | "starting" | "stopping" | "restarting" | "failed" | "blocked" | "stopped";

export interface ScheduleStatusView {
  state: ScheduleRunState;
  pid: number | null;
  /** When the running process started. */
  since: string | null;
  /** When a crashed always-on process starts again. */
  restartAt: string | null;
  restarts: number;
  lastError: string | null;
}

/** A schedule as the API answers it: never the secrets, not even encrypted, and not the state. */
export interface ScheduleView extends Omit<Schedule, "secrets_enc" | "state_json" | "inputs_json" | "input_values_json"> {
  inputs: ScheduleInputDecl[];
  /** The non-secret input values. */
  inputValues: Record<string, ScheduleInputValue>;
  /** Which secret inputs have a value saved. */
  secretsSet: string[];
  status: ScheduleStatusView;
}

export interface ScheduleRun {
  id: number;
  schedule_id: number;
  session_id: string | null;
  rotated_to_session_id: string | null;
  status: RunStatus;
  output_truncated: string | null;
  context_window_pct: number | null;
  cost_usd: number | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface NewSchedule {
  name: string;
  cron_expr: string;
  provider_id: string;
  project_path: string;
  prompt: string;
  permission_mode?: string;
  max_turns?: number | null;
  timeout_ms?: number;
  enabled?: boolean;
  next_fire_at?: string | null;
  kind?: ScheduleKind;
  mode?: ScheduleMode;
  description?: string;
  script?: string | null;
  inputs_json?: string;
  input_values_json?: string;
  secrets_enc?: string | null;
}

/** Result of one schedule execution (returned by scheduler-runner). */
export interface RunResult {
  status: Extract<RunStatus, "done" | "error">;
  output: string;
  contextWindowPct?: number;
  costUsd?: number;
  error?: string;
  rotatedToSessionId?: string;
}

/** What the scheduler runs schedules with; constructor-injected (`scheduler.service.ts`). */
export interface SchedulerRunner {
  ensureScheduleSession(schedule: Schedule): Promise<string>;
  runScheduleOnce(schedule: Schedule, sessionId: string): Promise<RunResult>;
  /** One tick of a script schedule, to the end of its process. */
  runScriptTick(schedule: Schedule): Promise<void>;
}

/** The processes of always-on script schedules (`schedule-script/always-on-supervisor.ts`). */
export interface AlwaysOnScripts {
  /** Settles what a previous server left behind; no script starts before it is done. */
  prepare(): Promise<void>;
  sync(): void;
  restart(id: number): Promise<void>;
  isRunning(id: number): boolean;
  stopAll(reason: string): void;
}
