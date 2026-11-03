/**
 * The session-history tools of the tab-tools MCP server: `search_sessions`, `list_session_turns`
 * and `read_session_turns`. Read-only. The caller is always the chat's canonical session (a Codex
 * chat is renamed during its first turn, and its token still names the first id), every call goes
 * through one rate limit per caller, and every word a session wrote comes back inside a fence.
 */
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import {
  LIST_SESSION_TURNS_TOOL, READ_SESSION_TURNS_TOOL, SEARCH_SESSIONS_TOOL, isSessionHistoryTool,
} from "../../shared/session-history-tools.ts";
import { listSessionTurns } from "../session-turns/session-turn-index.service.ts";
import { SessionTurnError } from "../session-turns/session-turn-types.ts";
import {
  searchIndexProgress, searchSessionTitles, searchSessionTurnText,
} from "../session-turns/session-search.ts";
import { resolveOwnSession, resolveTurnAccess, type TurnCaller } from "../session-turns/turn-access.ts";
import { fenced, oneLine } from "../session-turns/turn-render.ts";
import { readTurnsReportingErrors, renderReadAnswer } from "./session-history-read.ts";
import { createCallLimiter, type CallLimiter } from "./session-history-rate-limit.ts";
import {
  DEFAULT_LIST_LIMIT, DEFAULT_SEARCH_LIMIT, MAX_LIST_LIMIT, MAX_READ_TURNS, MAX_SEARCH_LIMIT,
} from "./session-history-tool-definitions.ts";

export interface SessionHistoryBinding {
  sessionId: string;
  projectPath: string | null;
  projectName: string | null;
}

export interface SessionHistoryTools {
  call(binding: SessionHistoryBinding, name: string, args: Json): Promise<Json>;
}

const MAX_QUERY_CHARS = 500;
const TITLE_HITS = 10;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const failure = (e: unknown): Json => {
  if (e instanceof SessionTurnError) return textResult(`${e.code}: ${e.message}`, true);
  throw e;
};

function intArg(args: Json, key: string, min: number, max: number, fallback: number): number | string {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (!isInt(v) || v < min || v > max) return `\`${key}\` must be a whole number from ${min} to ${max}.`;
  return v;
}

async function search(caller: TurnCaller, args: Json): Promise<Json> {
  if (!caller.projectPath) return textResult("This chat has no project, so there is nothing to search.", true);
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query || query.length > MAX_QUERY_CHARS) return textResult(`\`query\` must be 1 to ${MAX_QUERY_CHARS} characters.`, true);
  const limit = intArg(args, "limit", 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
  if (typeof limit === "string") return textResult(limit, true);
  const titles = searchSessionTitles(caller.projectPath, query, TITLE_HITS);
  const hits = searchSessionTurnText(caller.projectPath, query, limit);
  const { indexed, total } = searchIndexProgress(caller.projectPath);
  const notes: string[] = [];
  if (total === 0) notes.push("The search index holds no session of this project yet: PPM builds it when someone searches the chat list.");
  else if (indexed < total) notes.push(`Index incomplete (${indexed}/${total} sessions indexed): some sessions may be missing.`);
  if (!titles.length && !hits.length) return textResult([...notes, `No session matches "${oneLine(query, 80)}".`].join("\n"));
  const lines: string[] = [];
  if (titles.length) {
    lines.push("Title matches (session · provider · title):");
    for (const t of titles) lines.push(`- ${t.sessionId} · ${t.providerId || "?"} · ${oneLine(t.title, 200)}`);
  }
  if (hits.length) {
    if (lines.length) lines.push("");
    lines.push("Content matches (session · provider · title · turn · turn id · time · who: excerpt):");
    for (const h of hits) {
      const turn = h.turnId ? `Turn ${h.turnN ?? "?"} · ${h.turnId}` : "turn not known yet";
      lines.push(`- ${h.sessionId} · ${h.providerId || "?"} · ${oneLine(h.title, 120) || "(untitled)"} · ${turn} · ${h.ts} · ${h.role}: ${oneLine(h.snippet, 300)}`);
    }
  }
  return textResult([...notes, fenced(lines.join("\n")), "Read a turn with read_session_turns(session_id, turn_ids)."].join("\n"));
}

async function list(caller: TurnCaller, args: Json): Promise<Json> {
  const sessionId = typeof args.session_id === "string" ? args.session_id : "";
  const offset = intArg(args, "offset", 0, 1_000_000, 0);
  const limit = intArg(args, "limit", 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
  if (typeof offset === "string") return textResult(offset, true);
  if (typeof limit === "string") return textResult(limit, true);
  try {
    const target = resolveOwnSession(caller, sessionId);
    const { turns } = await listSessionTurns(target.ref);
    const end = Math.max(0, turns.length - offset);
    const shown = turns.slice(Math.max(0, end - limit), end);
    const head = `Session ${target.sessionId} · ${target.providerId} · ${target.projectName} · ${turns.length} turns`
      + (shown.length ? ` · showing turns ${shown[0]!.n}–${shown.at(-1)!.n}` : " · none in that page");
    const body = shown.map((t) => `${t.n} · ${t.turnId} · ${t.startedAt} · ${t.status} · ${oneLine(t.prompt, 200)}`).join("\n");
    const older = shown.length && shown[0]!.n > 1 ? `\nOlder turns: call again with offset ${offset + shown.length}.` : "";
    return textResult(`${head}\n${fenced(body)}${older}`);
  } catch (e) {
    if (e instanceof SessionTurnError && e.code === "session_missing") {
      return textResult("session_missing: list_session_turns reads this project's sessions only. For a turn the user linked from another project, use read_session_turns with its turn id.", true);
    }
    return failure(e);
  }
}

function turnIdsArg(args: Json): string[] | string | undefined {
  const raw = args.turn_ids;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_READ_TURNS || !raw.every((id) => typeof id === "string")) {
    return `\`turn_ids\` must list 1 to ${MAX_READ_TURNS} turn ids.`;
  }
  return [...new Set(raw as string[])];
}

async function read(caller: TurnCaller, args: Json): Promise<Json> {
  const sessionId = typeof args.session_id === "string" ? args.session_id : "";
  const project = typeof args.project === "string" && args.project.trim() ? args.project.trim().slice(0, 200) : undefined;
  const turnIds = turnIdsArg(args);
  if (typeof turnIds === "string") return textResult(turnIds, true);
  const hasRange = args.from_turn !== undefined || args.to_turn !== undefined;
  if (!turnIds && !hasRange) return textResult("Pass turn_ids, or from_turn and to_turn.", true);
  if (turnIds && hasRange) return textResult("Pass turn_ids or a range, not both.", true);
  let range: { from: number; to: number } | undefined;
  if (hasRange) {
    const { from_turn: from, to_turn: to } = args;
    if (!isInt(from) || !isInt(to) || from < 1 || to < from) return textResult("from_turn and to_turn must be turn numbers, from_turn ≤ to_turn.", true);
    if (to - from + 1 > MAX_READ_TURNS) return textResult(`A range may span at most ${MAX_READ_TURNS} turns.`, true);
    range = { from, to };
  }
  const access = resolveTurnAccess(caller, sessionId, project, { turnIds, range });
  if (!access.ok) return textResult(`${access.code}: ${access.message}`, true);
  try {
    let ids = access.turnIds;
    if (range) {
      const { turns } = await listSessionTurns(access.target.ref);
      ids = turns.filter((t) => t.n >= range.from && t.n <= range.to).map((t) => t.turnId);
      if (!ids.length) return textResult(`not_found: the session has ${turns.length} turns; none is numbered ${range.from}–${range.to}.`, true);
    }
    const { turns, errors } = await readTurnsReportingErrors(access.target.ref, ids);
    return textResult(renderReadAnswer(access.target, turns, [...access.denied, ...errors]), !turns.length);
  } catch (e) {
    return failure(e);
  }
}

export function createSessionHistoryTools(deps: { canonical: (sessionId: string) => string; limiter?: CallLimiter }): SessionHistoryTools {
  const limiter = deps.limiter ?? createCallLimiter();
  return {
    async call(binding, name, args) {
      if (!isSessionHistoryTool(name)) return textResult(`Unknown tool: ${name}`, true);
      const caller: TurnCaller = { ...binding, sessionId: deps.canonical(binding.sessionId) };
      const slot = limiter.acquire(caller.sessionId);
      if (!slot.ok) return textResult(slot.message, true);
      try {
        if (name === SEARCH_SESSIONS_TOOL) return await search(caller, args);
        if (name === LIST_SESSION_TURNS_TOOL) return await list(caller, args);
        if (name === READ_SESSION_TURNS_TOOL) return await read(caller, args);
        return textResult(`Unknown tool: ${name}`, true);
      } finally {
        slot.release();
      }
    },
  };
}
