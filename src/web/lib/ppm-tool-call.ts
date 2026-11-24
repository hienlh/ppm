/**
 * Reads a chat event as a call of one of PPM's own MCP tools — the session server (`ppm-sessions`:
 * tasks, schedules, reports), the tab server (`ppm-tabs`: session history), the PPM Assistant's and
 * the design server's — and turns it into the one line its card shows: a readable name, what the
 * call was about, and what it answered. Pure, so it is tested without the stores. The header that
 * draws it is `ppm-tool-header.tsx`, inside the ordinary tool card.
 *
 * Tools with a card of their own (`create_session`, `send_to_session`, `session_status`, the tab,
 * device, database and vault tools) are read by their own modules; this one only adds a line for
 * the others. Everything here comes from an AI or from a tool's output, so every field is checked:
 * anything missing or malformed is left out of the line, never shown as "undefined".
 */
import { taskToolSummary } from "./ppm-tool-summaries-tasks";
import { sessionToolSummary } from "./ppm-tool-summaries-sessions";
import { browserToolSummary } from "./ppm-tool-summaries-browser";
import { tabToolResultText } from "./tab-tool-call";
import { isObj, jsonAnswer, oneLine, str, type Args, type PpmToolContext, type PpmToolSummary } from "./ppm-tool-summary-types";

export type { PpmToolSummary, PpmToolSessionLink } from "./ppm-tool-summary-types";

/** Which PPM server a tool belongs to. */
export type PpmToolServer = "sessions" | "tabs" | "db" | "assistant" | "design";

/** Each server under Claude's name (hyphen) and Codex's (underscore: a hyphen is not safe in its config key). */
const SERVERS: Record<string, PpmToolServer> = {
  "ppm-sessions": "sessions", ppm_sessions: "sessions",
  "ppm-tabs": "tabs", ppm_tabs: "tabs",
  "ppm-db": "db", ppm_db: "db",
  "ppm-assistant": "assistant", ppm_assistant: "assistant",
  "ppm-design": "design", ppm_design: "design",
};

/** Claude: `mcp__ppm-sessions__ppm_task_create`. Codex: `ppm_sessions:ppm_task_create`. */
const CLAUDE_NAME = /^mcp__(ppm-[a-z]+)__([a-z0-9_]+)$/;
const CODEX_NAME = /^(ppm_[a-z]+):([a-z0-9_]+)$/;

export interface PpmToolName { server: PpmToolServer; tool: string }

/** The PPM server and tool a tool name is, or null for any other tool. */
export function ppmToolName(toolName: string): PpmToolName | null {
  const m = CLAUDE_NAME.exec(toolName) ?? CODEX_NAME.exec(toolName);
  const server = m ? SERVERS[m[1]!] : undefined;
  return m && server ? { server, tool: m[2]! } : null;
}

/** The arguments of a call: Codex wraps them as `{ server, tool, arguments }`. */
export function ppmToolArgs(input: unknown): Args {
  if (!isObj(input)) return {};
  return "arguments" in input && isObj(input.arguments) ? input.arguments : input;
}

/** Words a tool name abbreviates, as a person writes them. */
const WORDS: Record<string, string> = { ui: "UI", db: "database", cli: "CLI", mcp: "MCP", ppm: "PPM", pr: "PR", url: "URL" };

/** "chat_list_sessions" → "Chat list sessions", "ui_open_tab" → "UI open tab". */
export function humanizeToolName(tool: string): string {
  const words = tool.replace(/^ppm_/, "").split("_").filter(Boolean).map((w) => WORDS[w] ?? w).join(" ");
  return words ? words[0]!.toUpperCase() + words.slice(1) : tool;
}

/** Arguments that name what a call is about, in the order a generic line prefers them. */
const HINT_KEYS = ["title", "query", "name", "project", "session_id", "path", "branch", "url", "connection", "task", "id", "message"];

/** A line for a PPM tool with no reading of its own: its name and the first argument that says what it is about. */
function genericSummary(ctx: PpmToolContext): PpmToolSummary {
  for (const key of HINT_KEYS) {
    const v = ctx.args[key];
    const text = typeof v === "number" && Number.isFinite(v) ? String(v) : str(v);
    if (text) return { label: humanizeToolName(ctx.tool), detail: oneLine(text, 60) };
  }
  return { label: humanizeToolName(ctx.tool) };
}

/**
 * PPM tools whose card is the ordinary one under a readable name, with no line of their own, and
 * why. Every tool of the PPM Assistant's own server (`ppm-assistant`) is named only too. Any other new
 * PPM tool needs a reading in `ppm-tool-summaries-*.ts` or a card of its own routed in
 * `tool-cards.tsx`; `tests/unit/web/ppm-tool-card-coverage.test.ts` fails until it has one.
 */
export const PPM_TOOLS_NAMED_ONLY: Readonly<Record<string, string>> = {
  design_screenshot: "its pictures are the card: the ordinary card previews them",
  design_check: "a design chat's check of its own canvas; the report it returns is the output",
};

/** Whether a PPM tool has a line of its own read from its input and output. */
export function ppmToolHasOwnLine(tool: string): boolean {
  const ctx: PpmToolContext = { tool, args: {}, text: "", isError: false, ok: false };
  return (taskToolSummary(ctx) ?? sessionToolSummary(ctx) ?? browserToolSummary(ctx)) !== null;
}

/** Where the call stands. */
export interface PpmToolState {
  /** The tool's raw output, once there is one. */
  output?: string;
  isError: boolean;
}

/**
 * The header line of a PPM tool's card, or null when the tool is not one of PPM's own (or is a
 * database tool, which has its own line). Never throws: an output it cannot read gives a line from
 * the input alone.
 */
export function ppmToolSummary(toolName: string, input: unknown, state: PpmToolState): PpmToolSummary | null {
  const name = ppmToolName(toolName);
  if (!name || name.server === "db") return null;
  try {
    const text = state.output === undefined ? "" : tabToolResultText(state.output);
    const ctx: PpmToolContext = {
      tool: name.tool, args: ppmToolArgs(input), text, isError: state.isError, ok: state.output !== undefined && !state.isError,
    };
    return taskToolSummary(ctx) ?? sessionToolSummary(ctx) ?? browserToolSummary(ctx) ?? genericSummary(ctx);
  } catch {
    return { label: humanizeToolName(name.tool) };
  }
}

/** The icon family a PPM tool's chip shows. */
export type PpmToolIcon = "task" | "search" | "turns" | "schedule" | "report" | "assistant" | "design" | "tool";

export function ppmToolIcon(toolName: string): PpmToolIcon | null {
  const name = ppmToolName(toolName);
  if (!name || name.server === "db") return null;
  const t = name.tool;
  if (t.startsWith("ppm_task_")) return "task";
  if (t === "search_sessions") return "search";
  if (t === "list_session_turns" || t === "read_session_turns") return "turns";
  if (t.startsWith("session_schedule_")) return "schedule";
  if (t === "report_to_assistant") return "report";
  if (name.server === "design" || t.startsWith("design_")) return "design";
  if (name.server === "assistant") return "assistant";
  return "tool";
}

/**
 * The line under a failed PPM tool's header: the first line of its answer, or — for an answer that
 * is a JSON object, as the schedule tools' refusals are — its note, message or outcome.
 */
export function ppmToolErrorLine(output: string): string {
  const text = tabToolResultText(output);
  const answer = jsonAnswer(text);
  if (answer) {
    const said = str(answer.note) ?? str(answer.message) ?? str(answer.error) ?? str(answer.outcome);
    if (said) return oneLine(said, 300);
  }
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}

/** How many rows a `db_query` answer says its statements returned, or null when it says none or cannot be read. */
export function dbRowsBadge(output: string | undefined): string | null {
  if (output === undefined) return null;
  const text = tabToolResultText(output);
  let rows = 0;
  let found = false;
  for (const m of text.matchAll(/ returned (no rows|(\d+) rows?)\b/g)) {
    found = true;
    rows += m[2] ? Number(m[2]) : 0;
  }
  return found ? `${rows} ${rows === 1 ? "row" : "rows"}` : null;
}
