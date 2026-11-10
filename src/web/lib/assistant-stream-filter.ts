/**
 * Which loaded turns of the Assistant's chat a project filter keeps, and which wake turns fold to
 * one line. Pure, over the transcript rows the chat already holds: the filter is only a view, so
 * nothing it hides is gone, and it never asks for more history by itself.
 *
 * A turn opens at a user message and runs to the next one. It belongs to a project when the
 * Assistant called one of the session tools on that project's manager chat in it: `send_to_session`
 * or `session_status` naming the chat's id, or `create_session` naming the project.
 */
import { isNoReplyText } from "../../shared/assistant-cards";
import { decodeMessageBlocks } from "../../shared/chat-message-blocks";
import { CREATE_SESSION_TOOL, SEND_TO_SESSION_TOOL, SESSION_STATUS_TOOL } from "../../shared/session-collab";

export interface StreamRow {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  events?: ReadonlyArray<{ type: string; tool?: string; input?: unknown; content?: string }>;
}

export interface ManagerTarget {
  projectName: string;
  /** The project's manager chat, when it has one. */
  sessionId: string | null;
}

/** Rows grouped by turn; rows before the first user message form a turn of their own. */
export function groupTurns<R extends Pick<StreamRow, "role">>(rows: readonly R[]): R[][] {
  const turns: R[][] = [];
  for (const row of rows) {
    if (row.role === "user" || turns.length === 0) turns.push([row]);
    else turns[turns.length - 1]!.push(row);
  }
  return turns;
}

/** The bare tool name: `mcp__ppm-sessions__send_to_session` and `ppm_sessions.send_to_session` alike. */
export function bareToolName(tool: string): string {
  const cut = Math.max(tool.lastIndexOf("__"), tool.lastIndexOf("."));
  return cut >= 0 ? tool.slice(cut + (tool[cut] === "." ? 1 : 2)) : tool;
}

/** Whether one tool call reaches the target's manager chat. */
export function callTouchesManager(tool: string, input: unknown, target: ManagerTarget): boolean {
  const name = bareToolName(tool);
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (name === CREATE_SESSION_TOOL) return args.project === target.projectName;
  if (!target.sessionId) return false;
  if (name === SEND_TO_SESSION_TOOL) return args.session_id === target.sessionId;
  if (name === SESSION_STATUS_TOOL) return Array.isArray(args.session_ids) && args.session_ids.includes(target.sessionId);
  return false;
}

function turnTouches(turn: readonly StreamRow[], target: ManagerTarget): boolean {
  return turn.some((row) => row.role === "assistant"
    && (row.events ?? []).some((e) => e.type === "tool_use" && typeof e.tool === "string" && callTouchesManager(e.tool, e.input, target)));
}

/** Ids of the rows a project filter hides: every turn that did not touch that project's manager. */
export function hiddenByProjectFilter(rows: readonly StreamRow[], target: ManagerTarget): Set<string> {
  const hidden = new Set<string>();
  for (const turn of groupTurns(rows)) {
    if (!turnTouches(turn, target)) for (const row of turn) hidden.add(row.id);
  }
  return hidden;
}

/** The final text of a turn: the last assistant text event, else the last assistant content. */
function finalText(turn: readonly StreamRow[]): string | null {
  for (let i = turn.length - 1; i >= 0; i--) {
    const row = turn[i]!;
    if (row.role !== "assistant") continue;
    const texts = (row.events ?? []).filter((e) => e.type === "text" && typeof e.content === "string");
    if (texts.length) return texts[texts.length - 1]!.content ?? null;
    if (row.content.trim()) return row.content;
  }
  return null;
}

export interface CollapsedWakeTurn {
  /** Rows the one-line summary replaces. */
  ids: string[];
  /** Where the line goes: the turn's opening time. */
  at: number;
  /** When the turn before it opened, so the reports it read can be counted. */
  since: number;
}

/**
 * Turns PPM started on its own (`[PPM] News …`) that the Assistant answered with `[no reply]`:
 * nothing in them is for the user, so each shows as one muted line.
 */
export function collapsedWakeTurns(rows: readonly StreamRow[]): CollapsedWakeTurn[] {
  const out: CollapsedWakeTurn[] = [];
  let previous = 0;
  for (const turn of groupTurns(rows)) {
    const opener = turn[0]!;
    const at = Date.parse(opener.timestamp);
    const fromPpm = opener.role === "user" && decodeMessageBlocks(opener.content).content.trimStart().startsWith("[PPM] News");
    if (fromPpm && turn.length > 1 && isNoReplyText(finalText(turn))) {
      out.push({ ids: turn.map((r) => r.id), at: Number.isFinite(at) ? at : previous, since: previous });
    }
    if (opener.role === "user" && Number.isFinite(at)) previous = at;
  }
  return out;
}
