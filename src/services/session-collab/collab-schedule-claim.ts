/**
 * `session_schedule_claim`: the calling chat (from its token, never an argument) becomes the owner
 * of a script or prompt schedule of its own project that nobody owns, so its footer chip lists it.
 * A schedule of another project reads exactly like one that does not exist, as for the other
 * schedule tools; one another chat owns is refused, whatever the arguments say.
 */
import { createLogger } from "../logger.ts";
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import { projectOfFolder } from "../assistant-mcp/assistant-schedule-shape.ts";
import { changeScheduleOwner, ScheduleOwnerRefusal } from "../schedule-owner.ts";
import { getSchedule } from "../scheduler-db.service.ts";
import type { ScheduleTarget, ScheduleTargetDeps } from "../session-schedules/session-schedule-target.ts";

const log = createLogger("session-collab");

const json = (value: unknown): Json => textResult(JSON.stringify(value, null, 1));
const fail = (message: string): Json => textResult(message, true);

export function claimSchedule(chat: ScheduleTarget, id: number, changed: () => void, deps: ScheduleTargetDeps): Json {
  const schedule = getSchedule(id);
  const project = [{ name: chat.projectName, path: chat.projectPath }];
  if (!schedule || schedule.kind === "session" || !projectOfFolder(schedule.project_path, project)) {
    return fail(`This project has no script or prompt schedule with id ${id}; see projectSchedules in session_schedule_list.`);
  }
  if (schedule.created_by_session_id === chat.sessionId) return json({ claimed: true, id, name: schedule.name, note: "This chat already owns it." });
  if (schedule.created_by_session_id) {
    return fail(`Another chat (${schedule.created_by_session_id}) owns schedule ${id}. Only the user can move it, in Settings → Schedules.`);
  }
  try {
    changeScheduleOwner(schedule, chat.sessionId, { onlyIfUnowned: true }, deps);
  } catch (e) {
    return fail(`Not claimed: ${e instanceof ScheduleOwnerRefusal ? e.message : (e as Error).message}`);
  }
  log.info(`chat ${chat.sessionId} claimed schedule #${id} "${schedule.name}"`);
  changed();
  return json({ claimed: true, id, name: schedule.name, note: "This chat's footer chip lists it now. Nothing else about the schedule changed." });
}
