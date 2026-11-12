import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * agy moves a slow command to the background ("Tool is running as a background task with task
 * id: <conversation>/task-N") and may end the prompt with `end_turn` while it runs. When the task
 * reports back, agy carries on by itself, but it runs no tool until a client sends another
 * prompt: it opens the update stream only for `session/prompt`, and the tool waits for a
 * confirmation nothing gives. The chat sat still until the user wrote again (25 minutes in one
 * case). PPM watches for the report and sends this prompt for the user.
 */
export const AUTO_CONTINUE_PROMPT = "A background task you started has finished. Continue from where you left off.";

const POLL_MS = 2_000;
/** A task that has not reported back by then is not waited for any more. */
const MAX_WATCH_MS = 4 * 60 * 60_000;
const MTIME_SLACK_MS = 2_000;

export interface TaskWatch {
  stop(): void;
}

/** `task-N` of every task agy started in this conversation since `since`. */
function startedTasks(systemDir: string, since: number): Set<string> {
  const out = new Set<string>();
  const dir = join(systemDir, "tasks");
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const m = /^(task-\d+)\.log$/.exec(name);
    if (!m) continue;
    try {
      // A task of an earlier process stopped with it and never reports back. File times come
      // from the kernel's coarse clock, a few ms behind Date.now(), hence the slack.
      if (statSync(join(dir, name)).mtimeMs >= since - MTIME_SLACK_MS) out.add(m[1]!);
    } catch { /* gone */ }
  }
  return out;
}

/** The task a message file reports for, when it is one of this conversation's tasks. */
function reportingTask(messagesDir: string, name: string, conversationId: string): string | null {
  if (!name.endsWith(".json") || name === "read.json") return null;
  try {
    const msg = JSON.parse(readFileSync(join(messagesDir, name), "utf8")) as { sender?: unknown };
    const prefix = `${conversationId}/`;
    if (typeof msg.sender !== "string" || !msg.sender.startsWith(prefix)) return null;
    const task = msg.sender.slice(prefix.length);
    return /^task-\d+$/.test(task) ? task : null;
  } catch { return null; }
}

/**
 * Call `onReport` once, when a task started since `since` that has not reported back yet does.
 * Null when no such task is running, so there is nothing to wait for.
 */
export function watchBackgroundTasks(opts: {
  systemDir: string;
  conversationId: string;
  since: number;
  onReport: () => void;
  pollMs?: number;
}): TaskWatch | null {
  const messagesDir = join(opts.systemDir, "messages");
  const pending = startedTasks(opts.systemDir, opts.since);
  if (!pending.size) return null;
  const seen = new Set<string>();
  const list = (): string[] => { try { return readdirSync(messagesDir); } catch { return []; } };
  for (const name of list()) {
    seen.add(name);
    const task = reportingTask(messagesDir, name, opts.conversationId);
    if (task) pending.delete(task);
  }
  if (!pending.size) return null;

  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - startedAt > MAX_WATCH_MS) { stop(); return; }
    for (const name of list()) {
      if (seen.has(name)) continue;
      seen.add(name);
      const task = reportingTask(messagesDir, name, opts.conversationId);
      if (task && pending.has(task)) {
        stop();
        opts.onReport();
        return;
      }
    }
  }, opts.pollMs ?? POLL_MS);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  return { stop };
}
