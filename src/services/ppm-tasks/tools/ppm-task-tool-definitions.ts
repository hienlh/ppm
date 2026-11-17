/**
 * What the model is told about each `ppm_task_*` tool. Every description says these are PPM's
 * project task store, shown to the user in PPM and on Telegram — not the model's own built-in
 * TaskCreate/TaskList to-do list — because the two are otherwise easy to mix up.
 */
import type { Json } from "../../mcp-http-endpoint.ts";
import { BASE_GROUPS, CLOSED_AS, FIELD_TYPES, IMPORTANCES, LINK_KINDS, PPM_TASK_LIMITS as L, URGENCIES } from "../../../shared/ppm-tasks.ts";
import {
  PPM_TASK_CLOSE_TOOL, PPM_TASK_CREATE_TOOL, PPM_TASK_GET_TOOL, PPM_TASK_LIST_TOOL, PPM_TASK_NOTIFY_MANAGER_TOOL,
  PPM_TASK_PROJECT_TOOL, PPM_TASK_PROJECT_UPDATE_TOOL, PPM_TASK_REORDER_TOOL, PPM_TASK_UNDO_TOOL, PPM_TASK_UPDATE_TOOL,
} from "../../../shared/ppm-task-tools.ts";

export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 30;

const STORE = "PPM's project task store (the task list the user sees in PPM and on Telegram) — not your own TaskCreate/TaskList to-do list.";

const str = (description: string, maxLength?: number): Json => ({ type: "string", description, ...(maxLength ? { maxLength } : {}) });
const nullableStr = (description: string, maxLength?: number): Json => ({ type: ["string", "null"], description, ...(maxLength ? { maxLength } : {}) });

const PROJECT = str("The project's name in PPM. A manager or ordinary chat may only name its own project (or leave it out); the PPM Assistant must name it.");
const TASK = str("The task: `project/123`, `#123` or `123` within the project, or the task's id.");
const REVISION: Json = { type: "integer", minimum: 0, description: "The task's revision as you last read it (ppm_task_get or ppm_task_list). A stale revision is refused and nothing is written." };
/** What every write tool tells an ordinary chat about its limits. */
const CHAT_LIMITS = "A chat that is not the project's manager chat (nor the PPM Assistant) may only change result, next_step, notes, links and waiting_on of a task handed to it (its working session), and move the status between the In progress and Waiting groups; every other task it only reads, and anything else is the manager's to do.";

const REASON = str("Why you make this change, in a few words. Shown to the user in the task's history.", L.reason);
const LINK: Json = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...LINK_KINDS] },
    ref: str("A Jira key, a PR as owner/repo#n or its GitHub URL, a PPM chat id, or a URL.", L.linkRef),
    label: nullableStr("Optional label.", L.linkLabel),
  },
  required: ["kind", "ref"],
  additionalProperties: false,
};

/** The fields create and update share. */
const TASK_FIELDS: Record<string, Json> = {
  title: str("Short title.", L.title),
  type: str("task, decision or reply."),
  status: str("A status name or id of the project (see ppm_task_project)."),
  urgency: { type: "string", enum: [...URGENCIES], description: "now, today, week or later. A due date raises it automatically." },
  importance: { type: "string", enum: [...IMPORTANCES] },
  why: nullableStr("Why it matters.", L.why),
  next_step: nullableStr("The very next concrete step.", L.nextStep),
  notes: nullableStr("Longer notes.", L.notes),
  due_date: nullableStr("YYYY-MM-DD, or null to clear."),
  tags: { type: "array", items: { type: "string", maxLength: L.tag }, maxItems: L.tags },
  assignee: nullableStr("A member's name or id, `me` for the user, or null."),
  waiting_on: nullableStr("Who the task waits on: a member's name or id, `me`, or null."),
  parent: nullableStr("The parent task (`project/123`, `#123` or id), or null."),
  working_session: nullableStr("The chat doing the task: `self` (this chat), a PPM chat id of the same project, or null (the manager does it)."),
  fields: { type: "object", additionalProperties: { type: ["string", "number", "null"] }, description: "Custom field values by key; null removes a key. Keys the project has not declared are kept as they are." },
  snoozed_until: nullableStr("Snooze: hide the task from the daily lists (and from stalled checks of its chat) until this day, YYYY-MM-DD after today; it keeps its status and comes back by itself on that day. null brings it back now. Not for closed tasks."),
  snooze_until_change: { type: "boolean", description: "Snooze until one of the task's Jira or PR links changes (Jira status, PR state or review). Needs such a link. With snoozed_until too, whichever comes first brings it back. false stops it." },
};

export const PPM_TASK_TOOL_DEFINITIONS: readonly Json[] = [
  {
    name: PPM_TASK_LIST_TOOL,
    description: `List tasks of ${STORE} In "what to do first" order (effective urgency, then importance, then rank). Closed and snoozed tasks are left out unless asked for.`,
    inputSchema: {
      type: "object",
      properties: {
        project: str("The project's name. Leave out for your own project; the PPM Assistant may leave it out to list every project with Tasks on."),
        status_group: { type: "string", enum: [...BASE_GROUPS], description: "Only tasks whose status is in this group." },
        type: str("Only tasks of this type."),
        person: str("Only tasks assigned to or waiting on this member (name or id, or `me`)."),
        tag: str("Only tasks with this tag."),
        urgency: { type: "string", enum: [...URGENCIES], description: "Only tasks at this effective urgency." },
        query: str("Text to find in title, why, next step and notes.", 200),
        include_closed: { type: "boolean" },
        include_snoozed: { type: "boolean", description: "Also list tasks the user snoozed (hidden until a day or a link change)." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT, description: `At most this many (default ${DEFAULT_LIST_LIMIT}).` },
      },
      additionalProperties: false,
    },
  },
  {
    name: PPM_TASK_GET_TOOL,
    description: `One task of ${STORE} Every field (its snooze too), its links with their last known state, its children, its last 20 history rows (with ids ppm_task_undo takes), the check of the chat it was handed to, and the revision your next write must name.`,
    inputSchema: { type: "object", properties: { project: PROJECT, task: TASK }, required: ["task"], additionalProperties: false },
  },
  {
    name: PPM_TASK_PROJECT_TOOL,
    description: `A project's set-up in ${STORE} Whether Tasks is on, its statuses (with their groups), members, custom field definitions, and how often handed-off work is checked.`,
    inputSchema: { type: "object", properties: { project: PROJECT }, additionalProperties: false },
  },
  {
    name: PPM_TASK_CREATE_TOOL,
    description: `Create a task in ${STORE} Recorded in the task's history under your name; the user can undo it.`,
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        ...TASK_FIELDS,
        links: { type: "array", items: LINK, maxItems: L.links },
        decision: {
          type: "object",
          description: "Makes the task a decision the user picks an option of in PPM.",
          properties: {
            question: nullableStr("The question.", L.decisionLabel),
            options: { type: "array", items: { type: "string", maxLength: L.decisionLabel }, minItems: 2, maxItems: L.decisionOptions },
          },
          required: ["options"],
          additionalProperties: false,
        },
        reason: REASON,
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: PPM_TASK_UPDATE_TOOL,
    description: `Change a task of ${STORE} Name only what changes. \`result\` records what came of the task (it stops the checks of a handed-off task); any chat working on the task may record its own result. ${CHAT_LIMITS} Such a chat asks for its task to be closed with \`propose_close\`: the manager chat is told, checks the work and closes it.`,
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        task: TASK,
        revision: REVISION,
        reason: REASON,
        ...TASK_FIELDS,
        add_links: { type: "array", items: LINK, maxItems: L.links },
        remove_links: { type: "array", items: str("A link's ref (as ppm_task_get shows it)."), maxItems: L.links },
        result: nullableStr("What came of the task, or null to clear it.", L.result),
        propose_close: {
          type: "string", enum: [...CLOSED_AS],
          description: "For a chat that is not the manager chat: ask for the task to be closed as done or dropped, saying why in `reason`. The task stays open; the manager chat closes it after checking. Record the `result` first (in the same call is fine).",
        },
      },
      required: ["task", "revision", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: PPM_TASK_CLOSE_TOOL,
    description: `Close a task of ${STORE} as done or dropped (or into a named closed status). Only the project's manager chat, the PPM Assistant or the user closes a task; any other chat proposes it with ppm_task_update's \`propose_close\`.`,
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT, task: TASK, revision: REVISION, reason: REASON,
        as: { type: "string", enum: [...CLOSED_AS] },
        status: str("A closed status of the project, by name or id, instead of `as`."),
      },
      required: ["task", "revision", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: PPM_TASK_REORDER_TOOL,
    description: `Move a task of ${STORE} just before or just after another task with the same urgency and importance. The manager chat's and the Assistant's to do, not another chat's.`,
    inputSchema: {
      type: "object",
      properties: { project: PROJECT, task: TASK, revision: REVISION, reason: REASON, before: TASK, after: TASK },
      required: ["task", "revision", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: PPM_TASK_UNDO_TOOL,
    description: `Undo one AI change in ${STORE} by its history id (from ppm_task_get), within 90 days, while nothing changed the same fields since. A chat that is not the manager chat may undo only its own changes.`,
    inputSchema: {
      type: "object",
      properties: { project: PROJECT, history_id: { type: "integer", minimum: 1 }, reason: REASON },
      required: ["history_id"],
      additionalProperties: false,
    },
  },
  {
    name: PPM_TASK_PROJECT_UPDATE_TOOL,
    description: `Change a project's set-up in ${STORE}: members, statuses, custom fields, the check interval. Use it to move a hand-built board in (team roster → members, priority groups → a select field or tags). Recorded in the project's history. The manager chat's and the Assistant's to do, not another chat's.`,
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        reason: REASON,
        add_members: {
          type: "array", maxItems: 50,
          items: {
            type: "object",
            properties: { name: str("", L.memberName), jira_account_id: nullableStr(""), github_login: nullableStr(""), slack_user_id: nullableStr("") },
            required: ["name"], additionalProperties: false,
          },
        },
        update_members: {
          type: "array", maxItems: 50,
          items: {
            type: "object",
            properties: {
              member: str("The member's name or id."), name: str("", L.memberName), jira_account_id: nullableStr(""),
              github_login: nullableStr(""), slack_user_id: nullableStr(""), archived: { type: "boolean" },
            },
            required: ["member"], additionalProperties: false,
          },
        },
        add_statuses: {
          type: "array", maxItems: 20,
          items: {
            type: "object",
            properties: { name: str("", L.statusName), group: { type: "string", enum: [...BASE_GROUPS] }, closed_as: { type: "string", enum: [...CLOSED_AS] } },
            required: ["name", "group"], additionalProperties: false,
          },
        },
        update_statuses: {
          type: "array", maxItems: 20,
          items: {
            type: "object",
            properties: {
              status: str("The status's name or id."), name: str("", L.statusName), group: { type: "string", enum: [...BASE_GROUPS] },
              closed_as: { type: "string", enum: [...CLOSED_AS] }, position: { type: "integer", minimum: 0 },
            },
            required: ["status"], additionalProperties: false,
          },
        },
        upsert_fields: {
          type: "array", maxItems: 20,
          items: {
            type: "object",
            properties: {
              key: str("Letters, digits, _ . -"), label: str("", L.statusName), type: { type: "string", enum: [...FIELD_TYPES] },
              options: { type: "array", items: { type: "string" }, maxItems: 50, description: "The choices of a select field." },
            },
            required: ["key", "label", "type"], additionalProperties: false,
          },
        },
        delete_fields: { type: "array", items: { type: "string" }, maxItems: 20, description: "Field keys whose definition to remove; values tasks hold stay." },
        check_interval_min: { type: "integer", minimum: 5, maximum: 240, description: "How often PPM checks chats that were handed a task and have not reported." },
      },
      additionalProperties: false,
    },
  },
  {
    name: PPM_TASK_NOTIFY_MANAGER_TOOL,
    description: "PPM Assistant only. Tell a project's manager chat now about task changes it has not heard of: PPM sends it one message listing them. "
      + "Call it only after the user said yes to telling the manager now; otherwise the manager reads the changes at its next turn anyway.",
    inputSchema: { type: "object", properties: { project: PROJECT }, required: ["project"], additionalProperties: false },
  },
];
