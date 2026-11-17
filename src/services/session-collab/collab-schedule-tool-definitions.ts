/**
 * What the AI is told about scheduling prompts into its own chat. The shape follows Claude Code's
 * own CronCreate (a 5-field cron, `recurring` true by default, one-shots that delete themselves)
 * so a model that knows that tool needs nothing new; what differs is said plainly: the schedule is
 * PPM's, it survives restarts, and it waits for the chat to be idle.
 */
import { SCHEDULE_LIMITS } from "../../shared/schedule-definition.ts";
import { MAX_SCHEDULES_PER_SESSION } from "../../shared/session-schedule-input.ts";
import {
  SESSION_SCHEDULE_CREATE_TOOL, SESSION_SCHEDULE_DELETE_TOOL, SESSION_SCHEDULE_LIST_TOOL,
} from "../../shared/session-schedule-tools.ts";

export function sessionScheduleToolDefinitions() {
  return [
    {
      name: SESSION_SCHEDULE_CREATE_TOOL,
      title: "Schedule a prompt in this chat",
      description:
        "Schedule a prompt to be sent into this chat later, on a cron: a reminder, a daily check, a follow-up at a set "
        + "time. When it fires, the prompt arrives in this chat as a message and you work on it then. PPM stores it, so "
        + "it survives PPM and this chat's process restarting; prefer it to any built-in scheduler (CronCreate, "
        + "durable or not) for anything that must still happen after a restart. It is delivered only while the chat "
        + "is idle: a running turn finishes first, and fires missed while waiting (or while PPM was off) arrive once, "
        + "not as a queue. When the user presses Stop in this chat, a fire waiting for it is held until the chat's next "
        + "turn ends or the schedule's next fire, so it does not start the moment the user stopped. A prompt that starts "
        + "with a slash command (\"/review-pr 42\") runs that command or skill in a Claude chat; PPM's note saying this is "
        + "a scheduled run then follows it and reaches the command as part of its arguments, so write the arguments so "
        + "that trailing text does not change what they mean. "
        + `A chat holds at most ${MAX_SCHEDULES_PER_SESSION} schedules; the user sees and can delete `
        + "them in PPM. The result gives the schedule's id and its next fire time.",
      inputSchema: {
        type: "object",
        properties: {
          cron: {
            type: "string",
            description: "Standard 5-field cron expression: \"M H DoM Mon DoW\" (e.g. \"*/30 * * * *\" = every 30 minutes, "
              + "\"0 9 * * 1-5\" = weekdays at 9:00, \"30 14 28 2 *\" = Feb 28 at 14:30). Read in `timezone` when given, "
              + "otherwise in the local time zone of the machine PPM runs on.",
          },
          prompt: { type: "string", description: `The message to deliver at each fire (at most ${SCHEDULE_LIMITS.prompt} characters). Write it so it stands on its own: it arrives later, maybe after this conversation was compacted.` },
          recurring: {
            type: "boolean",
            description: "true (default) = fire on every cron match until deleted. false = fire once at the next match, then "
              + "delete itself. Use false for \"remind me at X\" with a pinned minute, hour, day and month.",
          },
          timezone: { type: "string", description: "IANA time zone the cron is read in, e.g. \"Europe/London\". Leave out for the machine's own." },
          name: { type: "string", description: `A short name shown in PPM's schedule list (at most ${SCHEDULE_LIMITS.name} characters); the prompt's first line by default.` },
          task: {
            type: "string",
            description: "The PPM task this reminds about (\"ppm/12\", \"#12\"), an open task of this chat's project. The "
              + "reminder then shows on the task's page, and closing or deleting the task deletes it. Give it for every "
              + "reminder about a task.",
          },
        },
        required: ["cron", "prompt"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: SESSION_SCHEDULE_LIST_TOOL,
      title: "List this chat's schedules",
      description:
        "List the prompts scheduled into this chat: id, name, cron, time zone, whether it repeats, its next fire, whether a "
        + "fire is waiting for the chat to be idle (or held after the user pressed Stop, until the chat's next turn ends or "
        + "the next fire), and why one is paused. Only this chat's schedules.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: SESSION_SCHEDULE_DELETE_TOOL,
      title: "Delete one of this chat's schedules",
      description: "Delete a prompt scheduled into this chat, by the id session_schedule_create or session_schedule_list gave. "
        + "It will not fire again. Only this chat's schedules can be deleted.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "integer", minimum: 1, description: "The schedule's id." } },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
  ];
}
