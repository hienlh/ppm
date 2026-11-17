/**
 * Small words the task views share: how long someone has been waited on ("2d"), when a history
 * row happened ("Today 09:02"), and a member's name from a project's member list.
 */
import { ME_MEMBER_ID, type TaskMember } from "../../../shared/ppm-tasks";
import { ageShort, waitingDetail, type WaitingDetail, type WaitingFacts } from "../../../shared/ppm-tasks-waiting";

const DAY = 86_400_000;

export { ageShort };

const pad = (n: number) => String(n).padStart(2, "0");

/** "Today 09:02", "Yesterday 17:52", "Mon 09:02" within a week, else "12 Nov 09:02". */
export function whenShort(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date(now)) - startOf(d)) / DAY);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${d.getDate()} ${d.toLocaleDateString(undefined, { month: "short" })} ${time}`;
}

/** "You" for the user, the member's name, or null when the id names nobody (left as the raw id). */
export function memberName(id: string | null, members: readonly TaskMember[] | undefined): string | null {
  if (!id) return null;
  if (id === ME_MEMBER_ID) return "You";
  return members?.find((m) => m.id === id)?.name ?? id;
}

/** "PSR Ireland export…": a short label for menus and toasts. */
export const clip = (s: string, n = 48): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The wait of a task as its rows word it ("Waiting on you", "Waiting on Việt", "Waiting"), with
 * its due date or how long it has waited; null when it does not wait. A member list names people
 * where the view has one; the Tasks chip has none and takes the name the server sent.
 */
export function taskWaiting(task: WaitingFacts & { waitingOnName?: string | null }, members?: readonly TaskMember[]): WaitingDetail | null {
  return waitingDetail(task, (id) => members?.find((m) => m.id === id)?.name ?? task.waitingOnName);
}
