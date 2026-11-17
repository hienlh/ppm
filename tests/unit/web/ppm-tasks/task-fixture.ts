/** A `TaskDto` with sensible defaults, for the task UI tests. */
import type { TaskDto } from "../../../../src/shared/ppm-tasks-api.ts";

let n = 0;

export function taskDto(over: Partial<TaskDto> = {}): TaskDto {
  n++;
  const id = over.id ?? `0000000${n}-0000-4000-8000-000000000000`.slice(-36);
  return {
    id, projectKey: "k-demo", project: "demo", number: n, ref: `demo/${n}`, title: `Task ${n}`, type: "task",
    statusId: "todo", statusName: "To do", baseGroup: "not_started", closedAs: null,
    urgency: "week", importance: "should", effectiveUrgency: "week", urgencyRaised: false, rank: n,
    why: null, nextStep: null, notes: null, dueDate: null, tags: [], assigneeMemberId: null, waitingOnMemberId: null,
    waitingSince: null, parentId: null, workingSessionId: null, decision: null, fields: {}, links: [], result: null,
    handedOffAt: null, snoozedUntil: null, snoozeUntilChange: false, snoozedAt: null, resurfacedAt: null, snoozed: false, resurfacedToday: false,
    revision: 1, createdAt: 1, updatedAt: 1, closedAt: null, deletedAt: null,
    workingSession: { kind: "start_chat" }, check: null,
    ...over,
    ...(over.urgency && !over.effectiveUrgency ? { effectiveUrgency: over.urgency } : {}),
  };
}
