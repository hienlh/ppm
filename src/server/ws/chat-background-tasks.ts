/**
 * Which SDK background tasks are running in a session's subprocess, keyed by the SDK's own task id.
 *
 * The CLI reports every task it runs past a tool call (a backgrounded Agent, a background Bash, an
 * agent woken again by `SendMessage`) with `task_started`, and its end with a terminal status on
 * `task_updated` / `task_notification`. Reading liveness from those, rather than from the text of
 * the tool result that launched the task, is what covers an agent resumed by `SendMessage`: its
 * result says "Resuming agent …", not the launch acknowledgement, and the task id is one that
 * already ended once. Missing it let the token rotation close the CLI under a reviewer still at
 * work, which killed the reviewer and left the chat waiting for a notification that never came.
 *
 * Kept free of the chat layer so the bookkeeping can be tested on its own; `chat.ts` owns the
 * state on each session entry.
 */

/** Statuses after which a task is no longer running. */
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "stopped", "killed"]);

/**
 * How long after the subprocess last showed signs of background work (a subagent's own events, a
 * task progress tick) the token rotation still leaves it alone. A safety net under the task
 * tracking, for work the CLI runs without reporting a task: closing the subprocess kills that
 * work silently, while waiting costs nothing, since an early renewal has two hours of slack.
 */
export const BACKGROUND_EVENT_QUIET_MS = 3 * 60_000;

export interface BackgroundTaskState {
  /** SDK task ids that have started and not yet reported a terminal status. */
  runningTaskIds?: Set<string>;
  /** When the subprocess last emitted a subagent event or a task progress tick (ms epoch). */
  lastBackgroundEventAt?: number;
}

export function isTerminalTaskStatus(status: string | undefined): boolean {
  return !!status && TERMINAL_TASK_STATUSES.has(status);
}

/**
 * Fold one `task_*` system event into the state. A `task_started` marks the task running even if
 * it already ended once, which is what an agent resumed by `SendMessage` looks like; a terminal
 * status on any of the three ends it. Returns whether the set of running tasks changed.
 */
export function noteTaskEvent(
  state: BackgroundTaskState,
  subtype: string,
  taskId: string | undefined,
  status: string | undefined,
): boolean {
  if (!taskId) return false;
  if (isTerminalTaskStatus(status)) return state.runningTaskIds?.delete(taskId) ?? false;
  if (subtype !== "task_started") return false;
  const running = (state.runningTaskIds ??= new Set());
  if (running.has(taskId)) return false;
  running.add(taskId);
  return true;
}

export function hasRunningTasks(state: BackgroundTaskState): boolean {
  return (state.runningTaskIds?.size ?? 0) > 0;
}

/** Record that the subprocess just showed background activity. */
export function noteBackgroundEvent(state: BackgroundTaskState, now = Date.now()): void {
  state.lastBackgroundEventAt = now;
}

/** Whether background activity was seen within the quiet window. */
export function backgroundEventRecent(
  state: BackgroundTaskState,
  now = Date.now(),
  quietMs = BACKGROUND_EVENT_QUIET_MS,
): boolean {
  return state.lastBackgroundEventAt != null && now - state.lastBackgroundEventAt < quietMs;
}

/**
 * Forget every task: the subprocess that ran them is gone, so nothing it started is still
 * running. Without this, a task whose end was never reported would keep the session busy forever.
 */
export function clearBackgroundTasks(state: BackgroundTaskState): void {
  state.runningTaskIds?.clear();
  state.lastBackgroundEventAt = undefined;
}
