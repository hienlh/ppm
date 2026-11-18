/**
 * The header line of a `ppm_task_*` tool card ("Created task ppm/151 · Fix login", "Updated task
 * #48: status → Waiting", "Listed tasks · 3 of 12"), read from the call's arguments and from the
 * text the task tools answer with (`ppm-task-write-tools.ts`, `ppm-task-tools.ts`). A task's code
 * is kept apart so the card can open the task.
 */
import { parseTaskRef } from "../../shared/ppm-tasks-refs";
import { joinParts, labelFor, oneLine, plural, posInt, str, type PpmToolContext, type PpmToolSummary } from "./ppm-tool-summary-types";

/** The first line of a write's answer: `Created: ppm/151 "Fix login" — now revision 1.` */
const WRITE_LINE = /^(Created|Updated|Closed(?: as ([a-z]+))?|Moved|Undid #(\d+) on): (\S+) "(.*)" — now revision \d+\.?$/;
/** A proposal's answer: `Proposed closing ppm/151 "Fix login" as done. It stays open…` */
const PROPOSAL_LINE = /^Proposed closing (\S+) "(.*)" as ([a-z]+)\./;
/** An update that changed nothing: `Nothing changed: ppm/151 already holds those values (revision 3).` */
const UNCHANGED_LINE = /^Nothing changed: (\S+) already holds\b/;
/** A task's first line inside the fence: `ppm/151 · week/normal · In progress · rev 3 · "Fix login" · …` */
const TASK_LINE = /^(\S+) · [^·]+ · (.+?) · rev \d+ · "(.*?)"(?: · |$)/;
/** A list's head: `3 of 12 tasks, what to do first at the top…` */
const LIST_HEAD = /^(\d+) of (\d+) tasks?\b/;

/**
 * A code the card can open, or undefined: `ppm/12`, `#12`, or a bare number read as `#12` — in
 * the project the call named, when it named one and the code did not.
 */
function taskCode(v: unknown, project?: string): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const ref = parseTaskRef(s);
  if (!ref) return undefined;
  const named = ref.project ?? (project && parseTaskRef(`${project}/${ref.number}`) ? project : null);
  return named ? `${named}/${ref.number}` : `#${ref.number}`;
}

/** What `task` names, for the line: its code when it is one, else a short id. */
function taskNamed(v: unknown): string | undefined {
  const s = str(v);
  return s ? (taskCode(s) ?? oneLine(s, 24)) : undefined;
}

/** The code and title a write answered with, when the answer is the one the tool writes. */
function writeAnswer(text: string): { kind: string; code: string; title: string; closedAs?: string } | null {
  const first = text.split("\n", 1)[0]?.trim() ?? "";
  const m = WRITE_LINE.exec(first);
  if (m) return { kind: m[1]!.startsWith("Closed") ? "Closed" : m[1]!.startsWith("Undid") ? "Undid" : m[1]!, code: m[4]!, title: m[5]!, ...(m[2] ? { closedAs: m[2] } : {}) };
  const p = PROPOSAL_LINE.exec(first);
  if (p) return { kind: "Proposed", code: p[1]!, title: p[2]!, closedAs: p[3]! };
  const u = UNCHANGED_LINE.exec(first);
  return u ? { kind: "Unchanged", code: u[1]!, title: "" } : null;
}

/** The task line inside a `ppm_task_get` answer. */
function taskAnswer(text: string): { code: string; status: string; title: string } | null {
  for (const line of text.split("\n")) {
    const m = TASK_LINE.exec(line.trim());
    if (m) return { code: m[1]!, status: m[2]!, title: m[3]! };
  }
  return null;
}

/** Fields an update names, as the line shows them: `status → Waiting`, then the names of the rest. */
const SHOWN_VALUES = ["status", "urgency", "importance", "assignee", "waiting_on", "due_date"] as const;
const OTHER_FIELDS: Record<string, string> = {
  title: "title", type: "type", why: "why", next_step: "next step", notes: "notes", tags: "tags", parent: "parent",
  working_session: "working chat", fields: "fields", snoozed_until: "snooze", snooze_until_change: "snooze",
  add_links: "links", remove_links: "links", result: "result",
};

function changesOf(args: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const key of SHOWN_VALUES) {
    if (!(key in args)) continue;
    const v = args[key];
    parts.push(`${key.replace("_", " ")} → ${v === null ? "none" : oneLine(str(v) ?? String(v), 30)}`);
  }
  const others = [...new Set(Object.keys(args).map((k) => OTHER_FIELDS[k]).filter((k): k is string => !!k))];
  const all = [...parts, ...others];
  if (!all.length) return undefined;
  return all.length > 3 ? `${all.slice(0, 3).join(", ")} +${all.length - 3}` : all.join(", ");
}

/** Filters a list call named, for its line. */
function listFilters(args: Record<string, unknown>): string | undefined {
  const query = str(args.query);
  return joinParts(
    str(args.project),
    query && `“${oneLine(query, 30)}”`,
    str(args.status_group), str(args.urgency), str(args.person) && `person ${oneLine(str(args.person)!, 20)}`,
    str(args.tag) && `tag ${oneLine(str(args.tag)!, 20)}`,
  );
}

export function taskToolSummary(ctx: PpmToolContext): PpmToolSummary | null {
  const { tool, args } = ctx;
  if (!tool.startsWith("ppm_task_")) return null;
  const write = ctx.ok ? writeAnswer(ctx.text) : null;
  const inputCode = taskCode(args.task, str(args.project));

  switch (tool) {
    case "ppm_task_create": {
      const title = str(args.title);
      if (write) return { label: "Created task", detail: joinParts(write.code, oneLine(write.title, 80)), task: write.code };
      return { label: "Create task", detail: title && oneLine(title, 80) };
    }
    case "ppm_task_update": {
      const changes = changesOf(args);
      if (write?.kind === "Proposed") {
        return { label: "Proposed closing task", detail: joinParts(write.code, write.closedAs && `as ${write.closedAs}`, oneLine(write.title, 60)), task: write.code };
      }
      if (write) {
        const head = write.kind === "Unchanged" ? "Task unchanged" : "Updated task";
        return { label: head, detail: joinParts(changes ? `${write.code}: ${changes}` : write.code, oneLine(write.title, 50)), task: write.code };
      }
      const named = taskNamed(args.task);
      return { label: "Update task", detail: named && changes ? `${named}: ${changes}` : (named ?? changes), task: inputCode };
    }
    case "ppm_task_close": {
      const as = str(args.as) ?? (str(args.status) ? `“${oneLine(str(args.status)!, 20)}”` : undefined);
      if (write) return { label: "Closed task", detail: joinParts(write.code, (write.closedAs ?? as) && `as ${write.closedAs ?? as}`, oneLine(write.title, 60)), task: write.code };
      return { label: "Close task", detail: joinParts(taskNamed(args.task), as && `as ${as}`), task: inputCode };
    }
    case "ppm_task_get": {
      const found = ctx.ok ? taskAnswer(ctx.text) : null;
      if (found) return { label: "Read task", detail: joinParts(found.code, oneLine(found.title, 60), oneLine(found.status, 24)), task: found.code };
      return { label: "Read task", detail: taskNamed(args.task), task: inputCode };
    }
    case "ppm_task_list": {
      const filters = listFilters(args);
      if (ctx.ok) {
        const head = LIST_HEAD.exec(ctx.text.trim());
        const none = /^No tasks match\b/.test(ctx.text.trim());
        const badge = head ? (head[1] === head[2] ? plural(Number(head[1]), "task") : `${head[1]} of ${head[2]} tasks`) : none ? "0 tasks" : undefined;
        return { label: "Listed tasks", detail: filters, badge };
      }
      return { label: "List tasks", detail: filters };
    }
    case "ppm_task_reorder": {
      if (write) return { label: "Moved task", detail: joinParts(write.code, oneLine(write.title, 60)), task: write.code };
      const anchor = taskNamed(args.before) ? `before ${taskNamed(args.before)}` : taskNamed(args.after) ? `after ${taskNamed(args.after)}` : undefined;
      return { label: "Move task", detail: joinParts(taskNamed(args.task), anchor), task: inputCode };
    }
    case "ppm_task_undo": {
      const id = posInt(args.history_id);
      if (write) return { label: "Undid task change", detail: joinParts(write.code, id ? `#${id}` : undefined, oneLine(write.title, 60)), task: write.code };
      return { label: "Undo task change", detail: id ? `#${id}` : undefined };
    }
    case "ppm_task_project":
      return { label: labelFor(ctx, "Read task setup", "Read task setup"), detail: str(args.project) };
    case "ppm_task_project_update":
      return { label: labelFor(ctx, "Change task setup", "Changed task setup"), detail: str(args.project) };
    case "ppm_task_notify_manager":
      return { label: labelFor(ctx, "Tell the manager", "Told the manager"), detail: str(args.project) };
    default:
      return null;
  }
}
