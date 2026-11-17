import type { Database } from "bun:sqlite";
import type { InterruptedChat } from "../../shared/restart-news.ts";
import { redactLogText } from "../../shared/log-redact.ts";

/**
 * Which chats a restart cut off mid-turn, read from the session trace: the one record that says,
 * for every chat whether or not anyone had it open, that a turn began and whether anything ended it.
 *
 * A chat counts when, among its rows written during the previous run (`since` to `before`, the new
 * run's start), the last top-level turn has no row that ends it — no `done`, `run_failed`,
 * `error`, `turn_aborted` or `run_closed`. That includes a turn no message opened: the provider's
 * own continuation after a background task ended, seen as turn work after the last turn's end. A chat already written to again by the new run is left
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
/**
 * Rows only a running turn writes. Found after the last turn's end, they are a turn a restart cut
 * off: a follow-up queued while that turn ran (its message was written before the end, and its rows
 * carry its turn id), or a turn the provider started by itself — the Claude CLI does that when a
 * background task it ran ends — whose rows carry no turn id. An approval request is not among them:
 * a background agent asks for one between turns.
 */
const TURN_WORK_TYPES = new Set(["tool_use", "text", "thinking"]);
/**
 * Origins of a cut-off turn that no manager may be told to resume. `proxy` and `browser` are not
 * chats at all. A `cli` turn belongs to a `ppm chat` process, which outlives the server: it is
 * usually still running, and a manager injecting into it would drive a session another process
 * owns. An `extension` turn spends an extension's AI budget, which only the extension controls.
 * Every other origin (the browser's `ws`, `telegram`, `schedule`, `scheduler`, `jira`, `session`,
 * the Assistant's own sends, a provider's continuation) is a chat a person or PPM was driving.
 */
export const NOT_RESUMABLE_ORIGINS: ReadonlySet<string> = new Set(["proxy", "browser", "cli", "extension"]);

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
export const NEWEST_SQL = `
  SELECT ts FROM session_events WHERE trace_id = ? AND source <> 'browser' ORDER BY seq DESC LIMIT 1`;

/**
 * The trace's last top-level rows before the new run, newest first. `tool_result` is left out: it
 * always follows a `tool_use`, and it is the one row that can weigh a megabyte.
 */
const TURN_ROWS_SQL = `
  SELECT ts, type, origin, provider_id, turn_id,
    CASE WHEN type = 'user_message' THEN substr(json_extract(payload_json, '$.text'), 1, 600) END AS text,
    CASE WHEN type IN ('tool_use', 'approval_request') THEN json_extract(payload_json, '$.tool') END AS tool,
    CASE WHEN type IN ('approval_request', 'approval_resolved') THEN json_extract(payload_json, '$.requestId') END AS request_id
  FROM session_events
  WHERE trace_id = ? AND ts < ? AND source <> 'browser' AND type <> 'tool_result'
    AND json_extract(payload_json, '$.parentToolUseId') IS NULL
  ORDER BY seq DESC
  LIMIT 400`;

/**
 * The trace's first top-level message: what the chat list shows as a chat's title until someone
 * renames it (the providers title a chat by its first prompt). Read ascending on the primary key,
 * so it stops at the first match.
 */
const FIRST_PROMPT_SQL = `
  SELECT substr(json_extract(payload_json, '$.text'), 1, 600) AS text
  FROM session_events
  WHERE trace_id = ? AND type = 'user_message' AND json_extract(payload_json, '$.parentToolUseId') IS NULL
  ORDER BY seq ASC
  LIMIT 1`;

interface TurnRow {
  ts: number;
  type: string;
  origin: string;
  provider_id: string | null;
  /** The turn the row belongs to; null between turns. */
  turn_id?: string | null;
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
  /** The title the chat was given (renamed by the user or the AI); null when it never was. */
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
  /** Every cut-off chat found, listed or not: what the background-work scan leaves to this list. */
  allIds?: string[];
}

/**
 * A user's words leave their chat here: into the Assistant's context, and from there possibly onto
 * Telegram. Secrets (tokens, passwords, keys) are taken out first; names and paths stay, since the
 * Assistant needs them to say which chat is which.
 */
const ONLY_SECRETS = { home: false, email: false, chats: false } as const;
export const withoutSecrets = (text: string | null): string | null => (text ? redactLogText(text, ONLY_SECRETS) : text);

export const firstLine = (text: string | null, max: number): string | undefined => {
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
    case "system": return "between steps";
    default: return row.type.replaceAll("_", " ");
  }
}

/**
 * What the last turn was doing when the rows stop, or null when that turn ended (or there is none).
 * Rows newest first. A turn the provider continued on its own, with no message opening it, is
 * reported with `continued` and no prompt.
 */
export function cutOffTurn(rows: readonly TurnRow[]): { prompt?: string; activity: string; lastAt: number; pendingApproval?: string; origin: string; providerId: string | null; continued?: boolean } | null {
  if (rows.length === 0) return null;
  const resolved = new Set<string>();
  let pendingApproval: string | undefined;
  let worked = false;
  let workTurn: string | null = null;
  for (const [i, row] of rows.entries()) {
    // An error the model went on past did not end the turn; one with nothing after it did.
    if (row.type === "error" && row !== rows[0]) continue;
    if (TURN_END_TYPES.has(row.type)) {
      if (!worked) return null;
      const newest = rows[0]!;
      const common = { activity: activityOf(newest), lastAt: newest.ts, ...(pendingApproval ? { pendingApproval } : {}) };
      if (workTurn) {
        // A follow-up queued while the previous turn ran: its message sits before that turn's end.
        const opener = rows.slice(i + 1).find((r) => r.type === "user_message" && r.turn_id === workTurn);
        const prompt = opener ? firstLine(withoutSecrets(opener.text), 160) : undefined;
        return { ...(prompt ? { prompt } : {}), ...common, origin: opener?.origin ?? newest.origin, providerId: opener?.provider_id ?? newest.provider_id };
      }
      // The previous turn ended, and a turn nobody opened ran after it without ending.
      return { ...common, origin: newest.origin, providerId: newest.provider_id, continued: true };
    }
    if (TURN_WORK_TYPES.has(row.type)) {
      if (!worked) workTurn = row.turn_id ?? null;
      worked = true;
    }
    if (row.type === "approval_resolved" && row.request_id) resolved.add(row.request_id);
    if (row.type === "approval_request" && !pendingApproval && (!row.request_id || !resolved.has(row.request_id))) {
      pendingApproval = row.tool ?? "a tool";
    }
    if (row.type === "user_message") {
      const newest = rows[0]!;
      return {
        prompt: firstLine(withoutSecrets(row.text), 160), activity: activityOf(newest), lastAt: newest.ts,
        ...(pendingApproval ? { pendingApproval } : {}), origin: row.origin, providerId: row.provider_id ?? newest.provider_id,
      };
    }
  }
  // The turn's opening message is older than the rows read: still a turn nothing ended.
  const newest = rows[0]!;
  return { activity: activityOf(newest), lastAt: newest.ts, ...(pendingApproval ? { pendingApproval } : {}), origin: newest.origin, providerId: newest.provider_id };
}

/**
 * A chat's title as the chat list shows it: a renamed chat's title, else its own first prompt,
 * else `fallback` (the cut-off turn's prompt), else its id.
 */
export function chatTitleReader(deps: Pick<InterruptedChatDeps, "traceDb" | "titleOf">): (traceId: string, sessionId: string, fallback?: string) => string {
  const firstPromptQ = deps.traceDb.query(FIRST_PROMPT_SQL);
  return (traceId, sessionId, fallback) => {
    const renamed = firstLine(deps.titleOf(sessionId), 120);
    if (renamed) return renamed;
    const first = (firstPromptQ.get(traceId) as { text: string | null } | null)?.text ?? null;
    return firstLine(withoutSecrets(first), 120) ?? fallback ?? `Session ${sessionId.slice(0, 8)}`;
  };
}

/**
 * Whether any of these traces has a row (other than a browser's) written at or after `since`: a
 * chat listed as cut off that has done this has been taken up again since the news was written.
 */
export function tracesWrittenSince(traceDb: Database, traceIds: readonly string[], since: number): boolean {
  const newestQ = traceDb.query(NEWEST_SQL);
  return traceIds.some((id) => {
    const newest = newestQ.get(id) as { ts: number } | null;
    return !!newest && newest.ts >= since;
  });
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
  const titleFor = chatTitleReader(deps);
  const found: InterruptedChat[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const newest = newestQ.get(c.trace_id) as { ts: number } | null;
    if (newest && newest.ts >= window.restartAt) continue; // the new run has taken it up
    const turn = cutOffTurn(turnQ.all(c.trace_id, window.restartAt) as TurnRow[]);
    if (!turn || NOT_RESUMABLE_ORIGINS.has(turn.origin)) continue;
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
      title: titleFor(c.trace_id, sessionId, turn.prompt),
      ...(turn.prompt ? { prompt: turn.prompt } : {}),
      activity: turn.activity,
      lastAt: turn.lastAt,
      ...(turn.pendingApproval ? { pendingApproval: turn.pendingApproval } : {}),
      ...(turn.continued ? { continued: true } : {}),
      ...(cards > 0 ? { openCards: cards } : {}),
      ...(projectPath && deps.managerOf(projectPath) === sessionId ? { manager: true } : {}),
      ...(parent ? { parentSessionId: parent } : {}),
      restartAt: window.restartAt,
    });
  }
  found.sort((a, b) => b.lastAt - a.lastAt);
  return {
    chats: found.slice(0, MAX_INTERRUPTED_LISTED), more: Math.max(0, found.length - MAX_INTERRUPTED_LISTED),
    allIds: found.map((c) => c.sessionId),
  };
}
