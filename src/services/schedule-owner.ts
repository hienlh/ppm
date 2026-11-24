/**
 * Which chat owns a script or prompt schedule (`created_by_session_id`): the chat whose footer chip
 * lists it. Owning gives a chat nothing else — no right to change or run the schedule — which is why
 * a person may move it in Settings and a chat may take one nobody owns without a card. Both go
 * through `ownerRefusal` here, so the two doors cannot drift on what a valid owner is.
 */
import type { Schedule } from "../types/scheduler.ts";
import { SESSION_ID_RE } from "../shared/session-turn-ids.ts";
import { folderKey } from "./schedule-delivery-chat.ts";
import { setScheduleOwner } from "./scheduler-db.service.ts";
import { liveScheduleTargetDeps, type ScheduleTargetDeps } from "./session-schedules/session-schedule-target.ts";

export type OwnerDeps = Pick<ScheduleTargetDeps, "canonical" | "stored" | "projectPath" | "isAssistant" | "isDesign">;

/** The chat id to store for `sessionId` (its current id), or why it cannot own `schedule`. */
export function ownerRefusal(
  schedule: Pick<Schedule, "kind" | "project_path">, sessionId: string, deps: OwnerDeps = liveScheduleTargetDeps,
): { ok: true; sessionId: string } | { ok: false; reason: string } {
  if (schedule.kind === "session") return { ok: false, reason: "A schedule that sends a prompt into a chat belongs to that chat; it has no other owner." };
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return { ok: false, reason: "That is not a chat id." };
  const id = deps.canonical(sessionId);
  if (deps.isAssistant(id) || deps.isDesign(id)) return { ok: false, reason: "A PPM Assistant or design chat cannot own a project's schedule." };
  const folder = deps.stored(id, deps.projectPath);
  if (!folder) return { ok: false, reason: "PPM has no record of that chat." };
  if (folderKey(folder) !== folderKey(schedule.project_path)) return { ok: false, reason: "That chat belongs to another project than the schedule." };
  return { ok: true, sessionId: id };
}

/** Why a change of owner was refused; `status` is the HTTP status a route answers with. */
export class ScheduleOwnerRefusal extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) { super(message); }
}

/**
 * Set or clear (`null`) the owner of `schedule`. With `onlyIfUnowned` a schedule that has an owner
 * is refused (409) rather than taken over. Throws `ScheduleOwnerRefusal`; answers the stored id.
 */
export function changeScheduleOwner(
  schedule: Pick<Schedule, "id" | "kind" | "project_path" | "created_by_session_id">,
  sessionId: string | null,
  opts: { onlyIfUnowned?: boolean } = {},
  deps: OwnerDeps = liveScheduleTargetDeps,
): string | null {
  if (sessionId === null) {
    if (schedule.kind === "session") throw new ScheduleOwnerRefusal("A schedule that sends a prompt into a chat belongs to that chat; it has no other owner.");
    setScheduleOwner(schedule.id, null);
    return null;
  }
  const checked = ownerRefusal(schedule, sessionId, deps);
  if (!checked.ok) throw new ScheduleOwnerRefusal(checked.reason);
  if (!setScheduleOwner(schedule.id, checked.sessionId, opts)) {
    throw new ScheduleOwnerRefusal(opts.onlyIfUnowned ? "Another chat already owns this schedule." : "Schedule not found", opts.onlyIfUnowned ? 409 : 400);
  }
  return checked.sessionId;
}
