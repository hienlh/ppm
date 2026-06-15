/** Scheduled-agent types — rows in `schedules` / `schedule_runs` (snake_case mirrors SQLite). */

export type RunStatus = "running" | "done" | "error" | "skipped";

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
