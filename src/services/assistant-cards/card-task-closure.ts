/**
 * Cards about a task, when the task closes or opens again (card withdrawal on only). A manager
 * names the task a card is about with `report_to_assistant`'s `task`; then:
 *
 * - a `done` or `failed` card about it is cleared when the task closes: it only carried news, and
 *   the task's own state now says it;
 * - a card that waits on the user (`needs_decision`, `urgent`) is NOT closed — a closed task does
 *   not mean the question was answered (a merge waiting on the user's OK, say) — it only says the
 *   task was closed, so the user can dismiss it, and the manager's task-close answer lists it;
 * - the task opening again takes that line away.
 *
 * Driven by the task store's change events (every door: the page, the AI's task tools, Telegram),
 * as `task-reminder-cleanup.ts` is.
 */
import { createLogger } from "../logger.ts";
import { ppmTasksEvents } from "../ppm-tasks/ppm-tasks-events.ts";
import { getTask } from "../ppm-tasks/ppm-tasks-read.ts";
import { WAITING_CARD_KINDS } from "../../shared/assistant-cards.ts";
import { assistantCards, type AssistantCards } from "./assistant-cards.service.ts";
import { listOpenCardsForTasks, type CardRow } from "./assistant-cards-db.ts";
import { assistantClock } from "../assistant-wake/assistant-clock.ts";
import { cardWithdrawOn } from "./card-withdraw-env.ts";

const log = createLogger("assistant-cards");

export interface TaskClosureDeps {
  cards: Pick<AssistantCards, "transition" | "patchPayload">;
  now(): number;
  on(): boolean;
  /** A task's state: closed (and how), open, or gone. */
  task(id: string): { closed: boolean; closedAs: "done" | "dropped" | null } | null;
  openCards(taskIds: readonly string[]): CardRow[];
}

const liveDeps: TaskClosureDeps = {
  cards: assistantCards,
  now: () => assistantClock.now(),
  on: cardWithdrawOn,
  task: (id) => {
    const t = getTask(id);
    if (!t || t.deletedAt !== null) return null;
    return { closed: t.baseGroup === "closed", closedAs: t.closedAs };
  },
  openCards: listOpenCardsForTasks,
};

/** Settles the open cards about these tasks after a change to them; answers how many changed. */
export function settleTaskCards(taskIds: readonly string[], deps: TaskClosureDeps = liveDeps): number {
  if (!deps.on() || taskIds.length === 0) return 0;
  let changed = 0;
  for (const row of deps.openCards(taskIds)) {
    const about = row.payload.aboutTask;
    if (!about) continue;
    const task = deps.task(about.taskId);
    // A deleted task says nothing about the question; the card is left as it was.
    if (!task) continue;
    const waits = WAITING_CARD_KINDS.includes(row.kind);
    if (task.closed && !waits) {
      const moved = deps.cards.transition(row.id, "dismissed", {
        by: "ppm", channel: "ppm", at: deps.now(), note: `Task ${about.ref} was closed`,
      });
      if (moved.ok) { changed++; log.info(`card ${row.id} cleared: task ${about.ref} was closed`); }
    } else if (task.closed && waits && !row.payload.taskClosed) {
      if (deps.cards.patchPayload(row.id, { taskClosed: { closedAs: task.closedAs, at: deps.now() } }, "changed")) changed++;
    } else if (!task.closed && row.payload.taskClosed) {
      if (deps.cards.patchPayload(row.id, { taskClosed: undefined }, "changed")) changed++;
    }
  }
  return changed;
}

/** Starts listening; answers the function that stops it. */
export function startCardTaskClosure(): () => void {
  return ppmTasksEvents.on((e) => {
    if (e.type !== "task") return;
    // After the writer's listeners: the change is committed, and this writes.
    queueMicrotask(() => {
      try {
        settleTaskCards(e.taskIds);
      } catch (err) {
        log.warn(`could not settle the cards of changed tasks: ${(err as Error).message}`);
      }
    });
  });
}

/**
 * Told to whoever just closed a task (its manager, or the PPM Assistant) when cards about it still
 * wait on the user: those it may withdraw if closing the task settled them. Null when none, or
 * when card withdrawal is off.
 */
export function waitingCardsAboutClosedTask(taskId: string, tool: "report_withdraw" | "card_withdraw", deps: Pick<TaskClosureDeps, "on" | "openCards"> = liveDeps): string | null {
  if (!deps.on()) return null;
  const rows = deps.openCards([taskId]).filter((r) => WAITING_CARD_KINDS.includes(r.kind));
  if (rows.length === 0) return null;
  const list = rows.slice(0, 10).map((r) => `- ${r.id} [${r.kind}] "${r.title.slice(0, 100)}"`).join("\n");
  return `Cards about this task still wait on the user:\n${list}\nIf closing the task settled them, withdraw them with ${tool} `
    + "and a reason; keep any the user still has to answer.";
}
