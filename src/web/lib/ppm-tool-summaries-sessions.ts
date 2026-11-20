/**
 * The header line of the session-history tools (`search_sessions`, `list_session_turns`,
 * `read_session_turns`), `report_to_assistant` and the `session_schedule_*` tools, read from the
 * call's arguments and from what they answer (`session-history-tools.ts`, `turn-render.ts`,
 * `manager-report-env.ts`, `collab-schedules.ts`, `collab-schedule-proposals.ts`), and the
 * Assistant's `ui_open_file_browser`.
 */
import {
  isObj, joinParts, jsonAnswer, labelFor, oneLine, plural, posInt, str, type PpmToolContext, type PpmToolSummary,
} from "./ppm-tool-summary-types";

/** A search hit: `- <session id> · <provider> · …`, one per title or content match. */
const SEARCH_HIT = /^- \S+ · \S+ · /;
/** `Session <id> · <provider> · <project> · <n> turns` (list) or `… · Turn <n> · …` (a read turn). */
const LIST_HEAD = /^Session (\S+) · (\S+) · .*? · (\d+) turns?\b/;
const TURN_HEAD = /^Session (\S+) · (\S+) · (.*?) · Turn (\d+) · /;

/**
 * The project a read turn's header names (`turnProjectLabel`): undefined for the chat's own
 * ("this project (demo)"), the name for another one ("project web, not this chat's project").
 */
function otherProjectOf(label: string | undefined): string | undefined {
  if (!label || label.startsWith("this project")) return undefined;
  const m = /^project (.+?)(?:, not this chat's project)?$/.exec(label);
  return m ? str(m[1]) : undefined;
}

const REPORT_KINDS: Record<string, string> = {
  done: "Done", failed: "Failed", needs_decision: "Needs decision", urgent: "Urgent", digest: "Digest",
};

/** A provider id the card can open a chat with. */
const provider = (v: string | undefined): string | undefined => (v && v !== "?" ? v : undefined);

function searchSessions(ctx: PpmToolContext): PpmToolSummary {
  const query = str(ctx.args.query);
  const detail = query ? `“${oneLine(query, 40)}”` : undefined;
  if (!ctx.ok) return { label: "Search sessions", detail };
  const text = ctx.text;
  const hits = text.split("\n").filter((line) => SEARCH_HIT.test(line.trim())).length;
  const none = /No session matches\b/.test(text);
  return { label: "Searched sessions", detail, badge: hits || none ? plural(hits, "result") : undefined };
}

function listTurns(ctx: PpmToolContext): PpmToolSummary {
  const sessionId = str(ctx.args.session_id);
  const head = ctx.ok ? LIST_HEAD.exec(ctx.text.trim()) : null;
  const session = sessionId ? { sessionId, ...(provider(head?.[2]) ? { providerId: head![2] } : {}) } : undefined;
  return {
    label: labelFor(ctx, "List turns", "Listed turns"),
    ...(head ? { badge: plural(Number(head[3]), "turn") } : {}),
    ...(session ? { session } : {}),
  };
}

function readTurns(ctx: PpmToolContext): PpmToolSummary {
  const { args } = ctx;
  const sessionId = str(args.session_id);
  const ids = Array.isArray(args.turn_ids) ? args.turn_ids.filter((id): id is string => typeof id === "string" && !!id.trim()) : [];
  const from = posInt(args.from_turn);
  const to = posInt(args.to_turn);
  const read = ctx.ok
    ? ctx.text.split("\n").map((line) => TURN_HEAD.exec(line.trim())).filter((m): m is RegExpExecArray => !!m)
    : [];
  const numbers = [...new Set(read.map((m) => Number(m[4])))];
  // "Read turns 490, 491", "Read turns 3–5", "Read 2 turns" (before the answer names them).
  const [label, turns] = numbers.length
    ? [numbers.length === 1 ? "Read turn" : "Read turns", `${numbers.slice(0, 4).join(", ")}${numbers.length > 4 ? "…" : ""}`]
    : from && to ? [from === to ? "Read turn" : "Read turns", from === to ? String(from) : `${from}–${to}`]
    : [ids.length === 1 ? "Read turn" : ids.length > 1 ? `Read ${ids.length} turns` : "Read turns", undefined];
  // A turn the user linked from another project is read without `project`: its header says where it is.
  const project = str(args.project) ?? otherProjectOf(read[0]?.[3]);
  const providerId = provider(read[0]?.[2]);
  const session = sessionId ? {
    sessionId,
    ...(providerId ? { providerId } : {}),
    ...(ids.length === 1 ? { turnId: ids[0] } : {}),
    ...(project ? { project } : {}),
  } : undefined;
  return { label, detail: joinParts(turns, project && `in ${oneLine(project, 30)}`), ...(session ? { session } : {}) };
}

function report(ctx: PpmToolContext): PpmToolSummary {
  const asked = str(ctx.args.kind);
  const answer = ctx.ok ? jsonAnswer(ctx.text) : null;
  const kind = str(answer?.kind) ?? asked;
  const title = str(ctx.args.title);
  const kindLabel = kind ? (REPORT_KINDS[kind] ?? oneLine(kind, 20)) : undefined;
  return { label: labelFor(ctx, "Report to Assistant", "Reported to Assistant"), detail: joinParts(kindLabel, title && oneLine(title, 80)) };
}

/** A schedule's name and next fire as an answer gives them. */
function scheduleOf(v: unknown): { id?: number; name?: string; next?: string } {
  if (!isObj(v)) return {};
  const next = isObj(v.nextFire) ? str(v.nextFire.local) : undefined;
  return { id: posInt(v.id), name: str(v.name), next };
}

function schedule(ctx: PpmToolContext): PpmToolSummary | null {
  const { tool, args } = ctx;
  // Read on an error too: a declined or stale card answers `{ done: false, outcome }` as an error.
  const answer = jsonAnswer(ctx.text);
  const named = (s: { id?: number; name?: string }) => joinParts(s.id ? `#${s.id}` : undefined, s.name && `“${oneLine(s.name, 50)}”`);
  switch (tool) {
    case "session_schedule_create": {
      const s = scheduleOf(answer);
      const inputName = str(args.name) ?? (str(args.prompt) && oneLine(str(args.prompt)!, 50));
      if (answer?.created === true) return { label: "Scheduled prompt", detail: joinParts(named(s) ?? inputName, s.next && `next ${s.next}`) };
      return { label: "Schedule prompt", detail: joinParts(inputName && `“${inputName}”`, str(args.cron)) };
    }
    case "session_schedule_list": {
      if (!ctx.ok || !answer) return { label: "List schedules" };
      const own = Array.isArray(answer.schedules) ? answer.schedules.length : undefined;
      const project = Array.isArray(answer.projectSchedules) ? answer.projectSchedules.length : 0;
      return { label: "Listed schedules", badge: own === undefined ? undefined : plural(own, "schedule"), detail: project ? `${project} more in the project` : undefined };
    }
    case "session_schedule_delete": {
      const id = posInt(args.id) ?? (typeof args.id === "string" && /^\d+$/.test(args.id) ? Number(args.id) : undefined);
      if (answer?.deleted === true) return { label: "Deleted schedule", detail: named({ id: posInt(answer.id) ?? id, name: str(answer.name) }) };
      return { label: "Delete schedule", detail: id ? `#${id}` : undefined };
    }
    case "session_schedule_set_enabled": {
      const on = args.enabled === true;
      const id = posInt(args.id);
      const changed = answer?.updated === true ? scheduleOf(answer[on ? "turnedOn" : "paused"]) : null;
      if (changed) return { label: on ? "Turned on schedule" : "Paused schedule", detail: named(changed) };
      const stale = answer?.done === false ? str(answer.outcome) : undefined;
      return { label: args.enabled === false ? "Pause schedule" : "Turn on schedule", detail: id ? `#${id}` : undefined, badge: stale && oneLine(stale.replace(/_/g, " "), 20) };
    }
    case "session_schedule_propose_script": {
      const s = scheduleOf(answer?.schedule);
      if (answer?.created === true) return { label: "Created script schedule", detail: named(s) };
      const declined = answer?.done === false ? str(answer.outcome) : undefined;
      return { label: "Propose script schedule", detail: joinParts(str(args.name) && `“${oneLine(str(args.name)!, 50)}”`), badge: declined && oneLine(declined.replace(/_/g, " "), 20) };
    }
    default:
      return null;
  }
}

/**
 * The Assistant's `ui_open_file_browser`: the file it selected, or the folder it opened
 * (`assistant-open-file-browser.ts`); the path asked for while it runs or when it was refused.
 */
function openFileBrowser(ctx: PpmToolContext): PpmToolSummary {
  const answer = ctx.ok ? jsonAnswer(ctx.text) : null;
  const shown = str(answer?.select) ?? str(answer?.dir) ?? str(ctx.args.path);
  return { label: labelFor(ctx, "Open file browser", "Opened file browser"), detail: shown && oneLine(shown, 80) };
}

export function sessionToolSummary(ctx: PpmToolContext): PpmToolSummary | null {
  switch (ctx.tool) {
    case "ui_open_file_browser": return openFileBrowser(ctx);
    case "search_sessions": return searchSessions(ctx);
    case "list_session_turns": return listTurns(ctx);
    case "read_session_turns": return readTurns(ctx);
    case "report_to_assistant": return report(ctx);
    default: return ctx.tool.startsWith("session_schedule_") ? schedule(ctx) : null;
  }
}
