import type { Database } from "bun:sqlite";
import type { InterruptedChat } from "../../shared/restart-news.ts";

/**
 * Which chats a restart cut off mid-turn, read from the session trace: the one record that says,
 * for every chat whether or not anyone had it open, that a turn began and whether anything ended it.
 *
 * A chat counts when, among its rows written during the previous run (`since` to `before`, the new
 * run's start), the last top-level turn has no row that ends it — no `done`, `run_failed`,
 * `error`, `turn_aborted` or `run_closed`. A chat already written to again by the new run is left
 * out (someone or something has taken it up), and so is anything that is not a person's chat: the
 * PPM Assistant's own sessions, design sessions, and the API proxy's streams.
 *
 * The trace file is shared: `ppm.db` and `ppm.dev.db` keep theirs in one PPM folder, and the
 * `ppm chat` CLI appends to it from its own process. So a trace counts only when this database
 * places its session in a registered project; anything else is another instance's chat, and
 * listing it would hand that instance's prompts to this one's Assistant.
 */

/** Rows of one trace that close a turn. `run_closed` is a stream that ended mid-turn on its own: not the restart's doing. */
const TURN_END_TYPES = new Set(["done", "run_failed", "error", "turn_aborted", "run_closed"]);
/** Origins whose traces are not chats a person or a manager could resume. */
const NOT_CHAT_ORIGINS = new Set(["proxy", "browser"]);

/** Most chats listed by name; the rest are counted. */
export const MAX_INTERRUPTED_LISTED = 30;
/** How far back a cut-off turn is looked for, at most, whatever the previous run's start. */
export const INTERRUPTED_LOOKBACK_MS = 24 * 60 * 60_000;

const CANDIDATES_SQL = `
  SELECT trace_id, MAX(ts) AS last_ts
  FROM session_events
  WHERE ts >= ? AND ts < ? AND source <> 'browser'
  GROUP BY trace_id
  ORDER BY last_ts DESC
  LIMIT 500`;

/** The trace's newest row of any kind but a browser's, on the primary key. */
const NEWEST_SQL = `
  SELECT ts FROM session_events WHERE trace_id = ? AND source <> 'browser' ORDER BY seq DESC LIMIT 1`;

/**
 * The trace's last top-level rows before the new run, newest first. `tool_result` is left out: it
 * always follows a `tool_use`, and it is the one row that can weigh a megabyte.
 */
const TURN_ROWS_SQL = `
  SELECT ts, type, origin, provider_id,
    CASE WHEN type = 'user_message' THEN substr(json_extract(payload_json, '$.text'), 1, 600) END AS text,
    CASE WHEN type IN ('tool_use', 'approval_request') THEN json_extract(payload_json, '$.tool') END AS tool,
    CASE WHEN type IN ('approval_request', 'approval_resolved') THEN json_extract(payload_json, '$.requestId') END AS request_id
  FROM session_events
  WHERE trace_id = ? AND ts < ? AND source <> 'browser' AND type <> 'tool_result'
    AND json_extract(payload_json, '$.parentToolUseId') IS NULL
  ORDER BY seq DESC
  LIMIT 400`;

interface TurnRow {
  ts: number;
  type: string;
  origin: string;
  provider_id: string | null;
  text: string | null;
  tool: string | null;
  request_id: string | null;
}

export interface InterruptedChatDeps {
  traceDb: Database;
  /** The id the session goes by now (a Codex chat is renamed on its first turn). */
  sessionOf(traceId: string): string;
  /** Where this database recorded the session; null for one it never recorded (another instance's). */
  projectPathOf(sessionId: string): string | null;
  /** The registered project at that path; null when none is. */
  projectNameOf(projectPath: string): string | null;
  providerOf(sessionId: string): string | null;
  titleOf(sessionId: string): string | null;
  isAssistant(sessionId: string, projectPath: string | null): boolean;
  isDesign(sessionId: string): boolean;
  /** The session id of the project's manager chat, or null. */
  managerOf(projectPath: string): string | null;
  parentOf(sessionId: string): string | null;
  openCardsOf(sessionId: string): number;
}

export interface InterruptedScan {
  chats: InterruptedChat[];
  /** Cut-off chats past {@link MAX_INTERRUPTED_LISTED}. */
  more: number;
}

const firstLine = (text: string | null, max: number): string | undefined => {
  const line = (text ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return undefined;
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : line;
};

function activityOf(row: TurnRow): string {
  switch (row.type) {
    case "tool_use": return row.tool ? `running tool ${row.tool}` : "running a tool";
    case "approval_request": return row.tool ? `waiting for approval of ${row.tool}` : "waiting for an approval";
    case "approval_resolved": return "just answered an approval";
    case "text": return "writing its answer";
    case "thinking": return "thinking";
    case "user_message": return "starting the turn";
    case "context_added": return "starting the turn";
    default: return row.type.replaceAll("_", " ");
  }
}

/**
 * What the last turn was doing when the rows stop, or null when that turn ended (or there is none).
 * Rows newest first.
 */
export function cutOffTurn(rows: readonly TurnRow[]): { prompt?: string; activity: string; lastAt: number; pendingApproval?: string; origin: string; providerId: string | null } | null {
  if (rows.length === 0) return null;
  const resolved = new Set<string>();
  let pendingApproval: string | undefined;
  for (const row of rows) {
    // An error the model went on past did not end the turn; one with nothing after it did.
    if (row.type === "error" && row !== rows[0]) continue;
    if (TURN_END_TYPES.has(row.type)) return null;
    if (row.type === "approval_resolved" && row.request_id) resolved.add(row.request_id);
    if (row.type === "approval_request" && !pendingApproval && (!row.request_id || !resolved.has(row.request_id))) {
      pendingApproval = row.tool ?? "a tool";
    }
    if (row.type === "user_message") {
      const newest = rows[0]!;
      return {
        prompt: firstLine(row.text, 160), activity: activityOf(newest), lastAt: newest.ts,
        ...(pendingApproval ? { pendingApproval } : {}), origin: row.origin, providerId: row.provider_id ?? newest.provider_id,
      };
    }
  }
  // The turn's opening message is older than the rows read: still a turn nothing ended.
  const newest = rows[0]!;
  return { activity: activityOf(newest), lastAt: newest.ts, ...(pendingApproval ? { pendingApproval } : {}), origin: newest.origin, providerId: newest.provider_id };
}

/**
 * Every chat whose last turn of the previous run was left unfinished, newest first. `restartAt` is
 * the new run's start (rows from then on are the new run's). Throws when the trace cannot be read.
 */
export function findInterruptedChats(deps: InterruptedChatDeps, window: { since: number; restartAt: number }): InterruptedScan {
  const since = Math.max(window.since, window.restartAt - INTERRUPTED_LOOKBACK_MS);
  const db = deps.traceDb;
  const candidates = db.query(CANDIDATES_SQL).all(since, window.restartAt) as Array<{ trace_id: string; last_ts: number }>;
  const newestQ = db.query(NEWEST_SQL);
  const turnQ = db.query(TURN_ROWS_SQL);
  const found: InterruptedChat[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const newest = newestQ.get(c.trace_id) as { ts: number } | null;
    if (newest && newest.ts >= window.restartAt) continue; // the new run has taken it up
    const turn = cutOffTurn(turnQ.all(c.trace_id, window.restartAt) as TurnRow[]);
    if (!turn || NOT_CHAT_ORIGINS.has(turn.origin)) continue;
    const sessionId = deps.sessionOf(c.trace_id);
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    const projectPath = deps.projectPathOf(sessionId);
    // A session this database never recorded, or one outside every registered project, is not ours to report.
    if (!projectPath) continue;
    if (deps.isAssistant(sessionId, projectPath) || deps.isDesign(sessionId)) continue;
    const projectName = deps.projectNameOf(projectPath);
    if (!projectName) continue;
    const parent = deps.parentOf(sessionId);
    const cards = deps.openCardsOf(sessionId);
    found.push({
      sessionId,
      providerId: deps.providerOf(sessionId) ?? turn.providerId ?? "claude",
      projectName,
      title: firstLine(deps.titleOf(sessionId), 120) ?? `Session ${sessionId.slice(0, 8)}`,
      ...(turn.prompt ? { prompt: turn.prompt } : {}),
      activity: turn.activity,
      lastAt: turn.lastAt,
      ...(turn.pendingApproval ? { pendingApproval: turn.pendingApproval } : {}),
      ...(cards > 0 ? { openCards: cards } : {}),
      ...(projectPath && deps.managerOf(projectPath) === sessionId ? { manager: true } : {}),
      ...(parent ? { parentSessionId: parent } : {}),
      restartAt: window.restartAt,
    });
  }
  found.sort((a, b) => b.lastAt - a.lastAt);
  return { chats: found.slice(0, MAX_INTERRUPTED_LISTED), more: Math.max(0, found.length - MAX_INTERRUPTED_LISTED) };
}
