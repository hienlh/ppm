/**
 * Codex side of the running-agents feed: which threads the session has spawned,
 * and what each was last doing — read from bounded tails, not full parses.
 *
 * A direct child's spawn/completion is recorded as a `SubAgentActivity` item
 * in the ROOT session's own rollout (not in the child's file), so discovering
 * "what has this session spawned" means reading a slice of the root rollout
 * itself. A grandchild's spawn is recorded the same way, but inside the
 * child's own rollout — so once a child is known, its tail is read the same
 * way to find further descendants, bounded in both count and depth so a
 * runaway spawn loop cannot make this unbounded work.
 */
import { statSync } from "node:fs";
import { agentTranscriptFsIo, statSizeSafe } from "./agent-transcript-fs-io.ts";
import { completeLines, parseLine } from "../../providers/codex-app-server/codex-rollout-header.ts";
import { parseSubagentActivity } from "../../providers/codex-app-server/codex-subagent-thread.ts";
import { mapRolloutItem } from "../../providers/codex-app-server/codex-rollout-items.ts";
import { findRolloutByThreadId, isCodexRolloutPath } from "../../providers/codex-app-server/codex-history.ts";

const TAIL_BYTES = 256 * 1024;
/** How many spawn levels deep the descendant scan follows before giving up. */
const MAX_DESCENDANT_DEPTH = 8;
/** Hard cap so a runaway spawn loop cannot make this scan unbounded. */
const MAX_DESCENDANTS = 64;

export interface CodexDescendant {
  threadId: string;
  path: string;
  done: boolean;
  lastWriteAt: number;
  lastStep?: string;
}

/** Read the tail of a file as text, dropping a possibly-partial first line. */
function readTailText(path: string): { text: string; size: number } | null {
  const size = statSizeSafe(path);
  if (size === null) return null;
  const start = Math.max(0, size - TAIL_BYTES);
  const buf = agentTranscriptFsIo.readRange(path, start, size - start);
  const text = buf.toString("utf8");
  // A mid-file read almost always starts inside a record; `completeLines`
  // already drops an unterminated trailing line, this drops the stray
  // leading one the same way a truncated head would.
  return { text: start > 0 ? text.slice(text.indexOf("\n") + 1) : text, size };
}

/** A short, one-line label for the most recent tool call in a tail of rollout records. */
function lastStepFromLines(lines: string[]): string | undefined {
  let label: string | undefined;
  for (const line of lines) {
    const rec = parseLine(line);
    if (!rec || rec.type !== "event_msg") continue;
    const p = rec.payload ?? {};
    if (p.type !== "item_completed") continue;
    const mapped = mapRolloutItem(p.item);
    if (mapped.kind !== "events") continue;
    for (const ev of mapped.events) {
      if (ev.type === "tool_use") label = ev.tool;
      else if (ev.type === "text" && ev.content.trim()) label = ev.content.trim().split("\n")[0]!.slice(0, 160);
    }
  }
  return label;
}

/** `SubAgentActivity` items in a tail of rollout records, most-recent state per thread. */
function subagentActivityFromLines(lines: string[]): Map<string, boolean> {
  const byThread = new Map<string, boolean>();
  for (const line of lines) {
    const rec = parseLine(line);
    if (!rec || rec.type !== "event_msg") continue;
    const p = rec.payload ?? {};
    if (p.type !== "item_completed") continue;
    const activity = parseSubagentActivity(p.item);
    if (activity) byThread.set(activity.threadId, activity.done);
  }
  return byThread;
}

/**
 * Descendant threads of one rollout file (direct children when `rolloutPath`
 * is the session's own root, grandchildren when it is an already-known
 * child), each resolved to its own file and last-write time.
 */
function directDescendants(rolloutPath: string, dirs: string[], projectPath: string): CodexDescendant[] {
  const tail = readTailText(rolloutPath);
  if (!tail) return [];
  const lines = completeLines(tail.text);
  const activity = subagentActivityFromLines(lines);
  const out: CodexDescendant[] = [];
  for (const [threadId, done] of activity) {
    let file: string | null = null;
    for (const dir of dirs) {
      const found = findRolloutByThreadId(dir, threadId, projectPath);
      if (found && isCodexRolloutPath(found)) { file = found; break; }
    }
    if (!file) continue;
    const childTail = readTailText(file);
    out.push({
      threadId,
      path: file,
      done,
      lastWriteAt: mtimeOf(file),
      lastStep: childTail ? lastStepFromLines(completeLines(childTail.text)) : undefined,
    });
  }
  return out;
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Every descendant of `rootRolloutPath`, discovered breadth-first up to
 * `MAX_DESCENDANT_DEPTH` levels and `MAX_DESCENDANTS` total threads.
 */
export function scanCodexDescendants(rootRolloutPath: string, dirs: string[], projectPath: string): CodexDescendant[] {
  const seen = new Map<string, CodexDescendant>();
  let frontier = [rootRolloutPath];
  for (let depth = 0; depth < MAX_DESCENDANT_DEPTH && frontier.length > 0 && seen.size < MAX_DESCENDANTS; depth++) {
    const next: string[] = [];
    for (const path of frontier) {
      for (const d of directDescendants(path, dirs, projectPath)) {
        if (seen.has(d.threadId) || seen.size >= MAX_DESCENDANTS) continue;
        seen.set(d.threadId, d);
        next.push(d.path);
      }
    }
    frontier = next;
  }
  return [...seen.values()];
}
