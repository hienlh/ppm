/**
 * The pure half of the composer's task chip (`composer-task-chip.ts`): reading it from tab
 * metadata, its label, and which tab of a session takes it. No store import, so `bun:test` can
 * load it.
 */
import { tabSessionId } from "@/lib/tab-session-id";
import { MAX_TASK_REFS, TASK_ID_RE, type TaskReference } from "../../../shared/chat-task-ref";

/** The least of a tab this needs; the panel store's `Tab` fits it. */
interface TabLike { id: string; type: string; metadata?: Record<string, unknown> }

/** The tab metadata key the chip is kept under. */
export const TASK_CHIP_META_KEY = "pendingTaskRefs";

export interface ComposerTaskChip {
  taskId: string;
  /** The task's number in its project: the chip reads "Task #12". */
  number: number;
  /** `ppm/12`. */
  ref: string;
  title: string;
  project: string;
}

const isChip = (v: unknown): v is ComposerTaskChip => {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return typeof c.taskId === "string" && TASK_ID_RE.test(c.taskId) && typeof c.number === "number" && Number.isInteger(c.number)
    && typeof c.ref === "string" && typeof c.title === "string" && typeof c.project === "string";
};

/** The chips a tab's metadata holds, checked; tab metadata is restored from storage. */
export function readTaskChips(metadata: Record<string, unknown> | undefined): ComposerTaskChip[] {
  const raw = metadata?.[TASK_CHIP_META_KEY];
  return Array.isArray(raw) ? raw.filter(isChip).slice(0, MAX_TASK_REFS) : [];
}

/** The chip a task shows as. */
export function taskChipOf(task: { id: string; number: number; ref: string; title: string; project: string }): ComposerTaskChip {
  return { taskId: task.id, number: task.number, ref: task.ref, title: task.title, project: task.project };
}

/** The chips a sent message's task block stands for: an edit or a fork brings them back. */
export function taskChipsFromRefs(refs: readonly TaskReference[] | null | undefined): ComposerTaskChip[] {
  return (refs ?? []).map((r) => ({ taskId: r.taskId, number: r.number, ref: r.ref, title: r.title, project: r.projectName }));
}

/** "Task #12 · Fix login". */
export function taskChipLabel(chip: Pick<ComposerTaskChip, "number" | "title">): string {
  return `Task #${chip.number} · ${chip.title}`;
}

/** The chip list once `chip` is added: the newest task first, each task once, at most the cap. */
export function withTaskChip(chips: readonly ComposerTaskChip[], chip: ComposerTaskChip): ComposerTaskChip[] {
  return [chip, ...chips.filter((c) => c.taskId !== chip.taskId)].slice(0, MAX_TASK_REFS);
}

/** Which tab shows `sessionId` and should take the chip: the one in view, else the newest one used. */
export function pickChatTabForSession(tabs: readonly { tab: TabLike; selected: boolean; focused: boolean }[], sessionId: string): string | null {
  const pool = tabs.filter((t) => tabSessionId(t.tab) === sessionId && t.tab.type === "chat");
  if (!pool.length) return null;
  const stamp = (t: TabLike) => (typeof t.metadata?.lastActiveAt === "number" ? (t.metadata.lastActiveAt as number) : -1);
  const rank = (t: (typeof pool)[number]) => (t.selected ? (t.focused ? 2 : 1) : 0);
  return pool.reduce((a, b) => (rank(b) > rank(a) || (rank(b) === rank(a) && stamp(b.tab) > stamp(a.tab)) ? b : a)).tab.id;
}

