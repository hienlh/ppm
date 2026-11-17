/**
 * What a snooze from the list says once it landed: "ppm/12 snoozed until Thu 20 Nov" with an
 * Unsnooze action (the row has just left the list, so the way back is on the toast), or
 * "ppm/12 is back in the list".
 */
import { toast } from "sonner";
import { localYmd } from "@/lib/ppm-tasks/ppm-tasks-kit-logic";
import { UNSNOOZE_PATCH } from "@/lib/ppm-tasks/task-snooze-choices";
import { snoozeText } from "../../../shared/ppm-tasks";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import type { SnoozePatch } from "./task-snooze-options";

export function snoozeToast(task: TaskDto, write: (patch: SnoozePatch) => void): void {
  const text = task.snoozed ? snoozeText(task, localYmd()) : null;
  if (text) toast.success(`${task.ref} snoozed ${text}`, { action: { label: "Unsnooze", onClick: () => write(UNSNOOZE_PATCH) } });
  else toast.success(`${task.ref} is back in the list`);
}
