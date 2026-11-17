/**
 * What an ordinary chat — neither the project's manager chat nor the PPM Assistant — may do with
 * the `ppm_task_*` tools. The manager checks the chats it hands tasks to by their status, due date
 * and urgency, so the chat doing a task must not be able to switch those checks off: it records
 * its result, next step, notes and links, says whom it waits on and moves the status between the
 * In progress and Waiting groups, and that is all. Closing is the manager's: the chat proposes it
 * (`propose_close` on `ppm_task_update`).
 *
 * One ceiling for every ordinary chat, whether or not it works on the task: a chat that could do
 * more on a task it does not work on, or on the project's settings (the check interval), could do
 * by a side door what it may not do on its own task.
 *
 * Pure decisions: each answers why a call is refused, or null. The write tools apply them.
 */
import type { BaseGroup, HistoryEntry, TaskPatch, TaskView } from "../../../shared/ppm-tasks.ts";

/** Patch fields an ordinary chat may change; `statusId` only within `CHAT_STATUS_GROUPS`. */
export const CHAT_EDITABLE_FIELDS: ReadonlyArray<keyof TaskPatch> = ["result", "nextStep", "notes", "links", "statusId", "waitingOnMemberId"];

/** The status groups an ordinary chat may move a task between: In progress and Waiting. */
export const CHAT_STATUS_GROUPS: readonly BaseGroup[] = ["active", "waiting"];

/** A patch field as the tool's caller named it. */
const ARG_NAME: Record<keyof TaskPatch, string> = {
  title: "title", type: "type", statusId: "status", urgency: "urgency", importance: "importance", why: "why",
  nextStep: "next_step", notes: "notes", dueDate: "due_date", tags: "tags", assigneeMemberId: "assignee",
  waitingOnMemberId: "waiting_on", parentId: "parent", workingSessionId: "working_session", fields: "fields",
  links: "links", result: "result", snoozedUntil: "snoozed_until", snoozeUntilChange: "snooze_until_change",
};

/** A status group as a sentence names it. */
const GROUP_WORDS: Record<BaseGroup, string> = { not_started: "Not started", active: "In progress", waiting: "Waiting", closed: "Closed" };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Whether `field` = `value` would leave the task as it is (a model often repeats what it read). */
function unchanged(task: TaskView, field: keyof TaskPatch, value: unknown): boolean {
  if (field === "fields") {
    const fields = (value ?? {}) as Record<string, unknown>;
    return Object.entries(fields).every(([k, v]) => same(task.fields[k], v));
  }
  if (field === "snoozeUntilChange") return !!value === task.snoozeUntilChange;
  return same((task as unknown as Record<string, unknown>)[field], value);
}

/** Who a chat asks for what it may not do itself. */
export function askWhom(hasManager: boolean): string {
  return hasManager
    ? "Ask the project's manager chat to do it (send_to_session to the chat that handed you this task)."
    : "This project has no manager chat: tell the user, who can do it in PPM.";
}

const RULE = "A chat other than the project's manager chat may change only result, next_step, notes, links and waiting_on, and move the status between the In progress and Waiting groups.";

/** Why an ordinary chat may not apply `patch` to `task` (ref `ref`), or null when it may. */
export function chatUpdateRefusal(
  task: TaskView, patch: TaskPatch, ref: string, groupOf: (statusId: string) => BaseGroup | undefined, hasManager: boolean,
): string | null {
  const blocked = (Object.keys(patch) as Array<keyof TaskPatch>)
    .filter((f) => !CHAT_EDITABLE_FIELDS.includes(f) && !unchanged(task, f, patch[f]))
    .map((f) => ARG_NAME[f] ?? f);
  if (blocked.length) return `This chat may not change ${blocked.join(", ")} of ${ref}. ${RULE} ${askWhom(hasManager)}`;
  if (patch.statusId !== undefined && patch.statusId !== task.statusId) {
    const to = groupOf(patch.statusId);
    if (!CHAT_STATUS_GROUPS.includes(task.baseGroup) || !to || !CHAT_STATUS_GROUPS.includes(to)) {
      const closing = to === "closed";
      return `This chat may not move ${ref} ${closing ? "to a closed status" : `from the ${GROUP_WORDS[task.baseGroup]} group to the ${to ? GROUP_WORDS[to] : "unknown"} group`}. ${RULE} `
        + (closing ? closeHint(hasManager) : askWhom(hasManager));
    }
  }
  return null;
}

/** What a refused close tells the chat to do instead. */
export function closeHint(hasManager: boolean): string {
  return hasManager
    ? "To have it closed, propose it: ppm_task_update with propose_close (done or dropped) and your reason. The manager chat is told, checks the work and closes it."
    : "To have it closed, propose it: ppm_task_update with propose_close (done or dropped) and your reason, and tell the user, who closes it in PPM (this project has no manager chat).";
}

/** Why an ordinary chat may not close a task: always — it proposes instead. */
export function chatCloseRefusal(ref: string, hasManager: boolean): string {
  return `Only the project's manager chat, the PPM Assistant or the user closes a task; this chat cannot close ${ref}. ${closeHint(hasManager)}`;
}

/**
 * Why an ordinary chat may not create a task with `patch`, or null. It may create tasks, but not
 * hand one to another chat (a manager's call) nor create one already closed.
 */
export function chatCreateRefusal(patch: TaskPatch, selfId: string, groupOf: (statusId: string) => BaseGroup | undefined, hasManager: boolean): string | null {
  const w = patch.workingSessionId;
  if (w !== undefined && w !== null && w !== selfId) return `This chat may not hand a task to another chat (working_session): only the project's manager chat does. ${askWhom(hasManager)}`;
  if (patch.statusId !== undefined && groupOf(patch.statusId) === "closed") return `This chat may not create a task already closed. ${askWhom(hasManager)}`;
  return null;
}

/** Why an ordinary chat may not move a task in the list: the order is the manager's priority. */
export function chatReorderRefusal(hasManager: boolean): string {
  return `This chat may not reorder tasks: the order is the priority the manager sets. ${askWhom(hasManager)}`;
}

/** Why an ordinary chat may not change the project's set-up (members, statuses, fields, check interval). */
export function chatProjectUpdateRefusal(hasManager: boolean): string {
  return `This chat may not change the project's set-up (members, statuses, fields, how often handed-off work is checked). ${askWhom(hasManager)}`;
}

/**
 * Why an ordinary chat may not undo `entry`, or null. Only its own changes, and only those within
 * what it may change now (a creation of its own included), so an undo cannot reach a field it
 * could not set.
 */
export function chatUndoRefusal(entry: HistoryEntry, selfId: string, hasManager: boolean): string | null {
  if (entry.actor.sessionId !== selfId) return `This chat may undo only its own changes; #${entry.id} was made by ${entry.actor.label}. ${askWhom(hasManager)}`;
  if (entry.kind === "created") return null;
  const blocked = entry.changes.map((c) => c.field).filter((f) => !CHAT_EDITABLE_FIELDS.includes(f as keyof TaskPatch));
  return blocked.length ? `This chat may not undo #${entry.id}: it changed ${blocked.join(", ")}, which only the manager chat changes. ${askWhom(hasManager)}` : null;
}
