import type { BackgroundTask, BackgroundTaskState, BackgroundWorkChat } from "../../shared/restart-news.ts";
import {
  chatTitleReader, firstLine, INTERRUPTED_LOOKBACK_MS, MAX_INTERRUPTED_LISTED, NEWEST_SQL, NOT_RESUMABLE_ORIGINS,
  withoutSecrets, type InterruptedChatDeps, type InterruptedScan,
} from "./interrupted-chats.ts";
import { scrubCommand } from "./background-command-text.ts";

/**
 * Which chats were between turns when the server went away but had work running in the background
 * — a `run_in_background` shell, a backgrounded agent, a Monitor, an agent woken by `SendMessage` —
 * read from the session trace. PPM tracks that work only in memory (`hasBackgroundWork`), and on
 * Windows the supervisor ends the server without a shutdown, so nothing can be written on the way
 * down: the trace is what is left.
 *
 * The CLI reports every task with `task_started` and its end with a terminal status on
 * `task_updated` / `task_notification`. A task counts when it started during the previous run and
 * nothing ended it before the new run began: no terminal status, and no `run_closed`, `run_failed`
 * or `turn_aborted` after it (each of those means the CLI that ran it was closed). Chats the restart
 * cut off mid-turn are the other list's; the same filters apply otherwise (this database's projects
 * only, no Assistant, design or extension chats, nothing the new run already took up).
 *
 * A task that ended `failed` or `killed` in the last {@link SHUTDOWN_KILL_WINDOW_MS} of the previous
 * run, with no turn ending after it, counts too: a machine shutting down kills the shells before it
 * kills PPM, so the CLI reports them failed seconds before the trace stops, and nothing reacted.
 */

const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "killed"]);
/** Terminal statuses a process killed from outside leaves (`stopped` is the chat's own TaskStop). */
const KILLED_STATUSES = new Set(["failed", "killed"]);
/** How long before the previous run's end a killed task is taken as killed by the shutdown. */
export const SHUTDOWN_KILL_WINDOW_MS = 60_000;
/** Rows that mean the CLI holding the session's tasks was closed. */
const CLI_CLOSED_TYPES = new Set(["run_closed", "run_failed", "turn_aborted"]);
/** Tools whose task runs inside the chat's Claude process, which ends with the server. */
const IN_PROCESS_TOOLS = new Set(["Agent", "Task", "SendMessage", "Skill"]);
/** The CLI's task ids (9 to 17 letters and digits in practice); anything else is not stored, so one odd id cannot void the news. */
const TASK_ID_RE = /^[\w.-]{1,100}$/;
/** Tasks listed per chat; the rest are counted. */
export const MAX_TASKS_LISTED = 5;
export const MAX_BACKGROUND_LISTED = MAX_INTERRUPTED_LISTED;

/** Traces that started a task in the window. */
const CANDIDATES_SQL = `
  SELECT trace_id, MAX(ts) AS last_ts
  FROM session_events
  WHERE ts >= ? AND ts < ? AND type = 'system' AND source <> 'browser'
    AND json_extract(payload_json, '$.subtype') = 'task_started'
  GROUP BY trace_id
  ORDER BY last_ts DESC
  LIMIT 500`;

/** A trace's task lifecycle and the rows that close its CLI, oldest first. */
const TASK_ROWS_SQL = `
  SELECT ts, type, origin, provider_id,
    json_extract(payload_json, '$.subtype') AS subtype,
    json_extract(payload_json, '$.taskId') AS task_id,
    json_extract(payload_json, '$.taskStatus') AS status,
    json_extract(payload_json, '$.taskToolUseId') AS tool_use_id
  FROM session_events
  WHERE trace_id = ? AND ts >= ? AND ts < ? AND source <> 'browser'
    AND (type IN ('run_closed', 'run_failed', 'turn_aborted', 'done')
      OR (type = 'system' AND json_extract(payload_json, '$.subtype') IN ('task_started', 'task_updated', 'task_notification')))
  ORDER BY seq ASC`;

/** The tool call that launched a task: it comes just before the task's `task_started`. */
const TOOL_SQL = `
  SELECT json_extract(payload_json, '$.tool') AS tool,
    substr(json_extract(payload_json, '$.input.description'), 1, 600) AS description,
    substr(json_extract(payload_json, '$.input.command'), 1, 2000) AS command,
    substr(json_extract(payload_json, '$.input.to'), 1, 100) AS recipient
  FROM session_events
  WHERE trace_id = ? AND type = 'tool_use' AND ts >= ? AND ts <= ?
    AND json_extract(payload_json, '$.toolUseId') = ?
  ORDER BY seq DESC
  LIMIT 1`;

/**
 * The previous run's last sign of life in the trace, for a run that wrote no stop. A `ppm chat`
 * process outlives the server and keeps writing, so its rows are left out. Another instance on the
 * same trace file (a dev server) can still move this later, which only misses kills, never adds one.
 */
const RUN_END_SQL = `
  SELECT MAX(ts) AS ts FROM session_events WHERE ts >= ? AND ts < ? AND source <> 'browser' AND origin <> 'cli'`;

interface TaskRow {
  ts: number;
  type: string;
  origin: string;
  provider_id: string | null;
  subtype: string | null;
  task_id: string | null;
  status: string | null;
  tool_use_id: string | null;
}

interface RunningTask {
  taskId: string;
  startedAt: number;
  toolUseId: string | null;
  origin: string;
  providerId: string | null;
  /** It ended `failed`/`killed` inside the shutdown window: the shutdown killed it. */
  killedAtShutdown?: boolean;
}

export interface BackgroundWorkDeps extends InterruptedChatDeps {
  /** Whether the task's output file was written after `since`; absent: never known. */
  taskOutputWrittenSince?(sessionId: string, taskId: string, since: number): boolean;
}

export interface BackgroundScan {
  chats: BackgroundWorkChat[];
  /**
   * For chats in `skip` (listed as cut off), the background work the shutdown killed, by session id:
   * the cut-off entry names it, so the chat is told when it is asked to carry on.
   */
  killedInCutOff?: Record<string, BackgroundTask[]>;
  /** Such chats past {@link MAX_BACKGROUND_LISTED}. */
  more: number;
}

/**
 * The tasks a trace's rows leave running, oldest first: started, and neither ended by a terminal
 * status nor by the CLI being closed. Rows oldest first. With `killedFrom`, a task that ended
 * `failed`/`killed` at or after it counts as still running (the shutdown killed it) unless a turn
 * ended after that, which means the chat already took the failure in.
 */
export function runningTasks(rows: readonly TaskRow[], killedFrom?: number): RunningTask[] {
  const running = new Map<string, RunningTask>();
  const killed = new Map<string, RunningTask>();
  for (const row of rows) {
    if (CLI_CLOSED_TYPES.has(row.type)) { running.clear(); killed.clear(); continue; }
    if (row.type === "done") { killed.clear(); continue; }
    if (!row.task_id || !TASK_ID_RE.test(row.task_id)) continue;
    if (row.status && TERMINAL_STATUSES.has(row.status)) {
      const task = running.get(row.task_id);
      running.delete(row.task_id);
      if (task && killedFrom !== undefined && row.ts >= killedFrom && KILLED_STATUSES.has(row.status)) {
        killed.set(row.task_id, { ...task, killedAtShutdown: true });
      }
      continue;
    }
    // An agent woken again by SendMessage starts the same task id again: it runs from then on.
    if (row.subtype === "task_started") {
      running.delete(row.task_id);
      killed.delete(row.task_id);
      running.set(row.task_id, { taskId: row.task_id, startedAt: row.ts, toolUseId: row.tool_use_id, origin: row.origin, providerId: row.provider_id });
    }
  }
  return [...running.values(), ...killed.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** What a task's state is after the restart, by the evidence there is. */
export function taskState(tool: string, outputWritten: boolean): BackgroundTaskState {
  if (outputWritten) return "alive";
  return IN_PROCESS_TOOLS.has(tool) ? "stopped" : "unknown";
}

/**
 * Every chat that was between turns with background work running when the previous run ended,
 * newest first. `skip` holds the chats listed as cut off mid-turn. `runEnd` is when the previous run
 * stopped, when it wrote its stop; otherwise its last row in the trace stands in. Throws when the
 * trace cannot be read.
 */
export function findBackgroundWorkChats(
  deps: BackgroundWorkDeps, window: { since: number; restartAt: number; runEnd?: number }, skip: ReadonlySet<string> = new Set(),
): BackgroundScan {
  const since = Math.max(window.since, window.restartAt - INTERRUPTED_LOOKBACK_MS);
  const db = deps.traceDb;
  const runEnd = window.runEnd ?? (db.query(RUN_END_SQL).get(since, window.restartAt) as { ts: number | null } | null)?.ts ?? null;
  const killedFrom = runEnd === null ? undefined : runEnd - SHUTDOWN_KILL_WINDOW_MS;
  const candidates = db.query(CANDIDATES_SQL).all(since, window.restartAt) as Array<{ trace_id: string }>;
  const newestQ = db.query(NEWEST_SQL);
  const taskQ = db.query(TASK_ROWS_SQL);
  const toolQ = db.query(TOOL_SQL);
  const titleFor = chatTitleReader(deps);
  const found: BackgroundWorkChat[] = [];
  const killedInCutOff: Record<string, BackgroundTask[]> = {};
  const seen = new Set<string>();
  for (const c of candidates) {
    const newest = newestQ.get(c.trace_id) as { ts: number } | null;
    if (!newest || newest.ts >= window.restartAt) continue; // the new run has taken it up
    const running = runningTasks(taskQ.all(c.trace_id, since, window.restartAt) as TaskRow[], killedFrom)
      .filter((t) => !NOT_RESUMABLE_ORIGINS.has(t.origin));
    if (running.length === 0) continue;
    const sessionId = deps.sessionOf(c.trace_id);
    const describe = (list: RunningTask[]): BackgroundTask[] => list.sort((a, b) => b.startedAt - a.startedAt).map((t) => {
      const call = t.toolUseId
        ? toolQ.get(c.trace_id, since, t.startedAt, t.toolUseId) as { tool: string | null; description: string | null; command: string | null; recipient: string | null } | null
        : null;
      const tool = firstLine(call?.tool ?? null, 60) ?? "unknown tool";
      const description = firstLine(withoutSecrets(call?.description ?? (call?.recipient ? `message to agent ${call.recipient}` : null)), 160);
      // The command only when nothing says what the task was for: it is where credentials sit.
      const command = description ? undefined : firstLine(call?.command ? scrubCommand(call.command) : null, 160);
      let written = false;
      try { written = deps.taskOutputWrittenSince?.(sessionId, t.taskId, window.restartAt) ?? false; } catch { /* not known */ }
      return {
        taskId: t.taskId, tool, startedAt: t.startedAt, state: taskState(tool, written),
        ...(description ? { description } : {}), ...(command ? { command } : {}),
      };
    });
    if (skip.has(sessionId)) {
      // Listed as cut off: only what the shutdown killed is kept, for that entry to name.
      const killed = running.filter((t) => t.killedAtShutdown);
      if (killed.length && !killedInCutOff[sessionId]) killedInCutOff[sessionId] = describe(killed).slice(0, MAX_TASKS_LISTED);
      continue;
    }
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    const projectPath = deps.projectPathOf(sessionId);
    if (!projectPath) continue;
    if (deps.isAssistant(sessionId, projectPath) || deps.isDesign(sessionId)) continue;
    const projectName = deps.projectNameOf(projectPath);
    if (!projectName) continue;
    const tasks = describe(running);
    const parent = deps.parentOf(sessionId);
    const cards = deps.openCardsOf(sessionId);
    found.push({
      sessionId,
      providerId: deps.providerOf(sessionId) ?? running[0]!.providerId ?? "claude",
      projectName,
      title: titleFor(c.trace_id, sessionId),
      lastAt: newest.ts,
      tasks: tasks.slice(0, MAX_TASKS_LISTED),
      ...(tasks.length > MAX_TASKS_LISTED ? { moreTasks: tasks.length - MAX_TASKS_LISTED } : {}),
      ...(cards > 0 ? { openCards: cards } : {}),
      ...(deps.managerOf(projectPath) === sessionId ? { manager: true } : {}),
      ...(parent ? { parentSessionId: parent } : {}),
      restartAt: window.restartAt,
    });
  }
  found.sort((a, b) => b.lastAt - a.lastAt);
  return {
    chats: found.slice(0, MAX_BACKGROUND_LISTED), more: Math.max(0, found.length - MAX_BACKGROUND_LISTED),
    ...(Object.keys(killedInCutOff).length ? { killedInCutOff } : {}),
  };
}

/** The cut-off scan with each chat's background work the shutdown killed (from the background scan) named on it. */
export function withKilledTasks(cutOff: InterruptedScan, background: BackgroundScan): InterruptedScan {
  const killed = background.killedInCutOff ?? {};
  if (Object.keys(killed).length === 0) return cutOff;
  return { ...cutOff, chats: cutOff.chats.map((c) => (killed[c.sessionId] ? { ...c, killedTasks: killed[c.sessionId] } : c)) };
}

/**
 * The chat with any task of unknown state whose output was written after the restart marked
 * `alive`. Run again when the news goes out, which can be hours later: a quiet job may have
 * written by then. Work that ran inside the CLI stays stopped.
 */
export function refreshTaskStates(chat: BackgroundWorkChat, writtenSince: (sessionId: string, taskId: string, since: number) => boolean): BackgroundWorkChat {
  let changed = false;
  const tasks = chat.tasks.map((t) => {
    if (t.state !== "unknown") return t;
    let written = false;
    try { written = writtenSince(chat.sessionId, t.taskId, chat.restartAt); } catch { /* not known */ }
    if (!written) return t;
    changed = true;
    return { ...t, state: "alive" as const };
  });
  return changed ? { ...chat, tasks } : chat;
}
