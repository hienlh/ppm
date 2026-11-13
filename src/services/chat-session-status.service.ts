/**
 * Every recent session's waiting, stopped and reply state, across all registered projects, in
 * one call: what an extension needs to tell "the AI is waiting on you" and "this stopped" from
 * "finished, and you never replied". Assembled from three places, none written here:
 *  - the session trace (`session-trace.db`): which sessions moved in the window, and how their
 *    latest turn ended;
 *  - `ppm.db` `session_metadata`: project, provider, title, unread type;
 *  - the chat socket's live entries (memory): phase and any pending approval or question.
 * Never reads a transcript.
 */
import type { SessionPhase } from "../types/api.ts";
import type {
  ChatSessionLastTurn, ChatSessionStatus, ChatSessionStatusResponse,
} from "../shared/chat-session-status.ts";
import type { TraceTurnStatus } from "./session-trace/turn-stop-reader.ts";

export interface SessionMetaRow {
  sessionId: string;
  projectName: string | null;
  providerId: string | null;
  unreadType: string | null;
  title: string | null;
}

export interface LiveSessionState {
  phase: SessionPhase;
  providerId: string;
  pending: { tool: string; requestId: string; since: number } | null;
}

export interface ChatSessionStatusDeps {
  now(): number;
  /** Trace ids with a row newer than `sinceMs`, their newest row, and a provider seen on them. */
  recentTraces(sinceMs: number): Array<{ traceId: string; updatedAt: number; providerId: string | null }>;
  turnStatus(traceId: string): TraceTurnStatus;
  /** The id a session goes by now (`migrated_to` followed). */
  currentSessionId(traceId: string): string;
  metadata(sessionIds: string[]): Map<string, SessionMetaRow>;
  registeredProjects(): Set<string>;
  liveState(): Map<string, LiveSessionState>;
  /** Whether this process runs a turn of it now, whoever started it (`isTurnRunning`). */
  isTurnRunning(id: string): boolean;
}

/**
 * A turn whose rows stop mid-turn with nothing in this process running it is still called
 * running for this long after its newest row: `ppm chat` and other processes write to the same
 * trace, and their turns are invisible to this process otherwise.
 */
export const OTHER_PROCESS_GRACE_MS = 2 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();

function lastTurnOf(status: TraceTurnStatus, running: boolean, now: number, updatedAt: number): ChatSessionLastTurn | null {
  if (running) return { outcome: "running", at: iso(status.last?.at ?? updatedAt) };
  const last = status.last;
  if (!last) return null;
  if (last.outcome === "unfinished" && now - updatedAt < OTHER_PROCESS_GRACE_MS) {
    return { outcome: "running", at: iso(last.at) };
  }
  switch (last.outcome) {
    case "done":
    case "cancelled":
      return { outcome: last.outcome, at: iso(last.at) };
    case "error":
    case "max_turns":
      return { outcome: last.outcome, at: iso(last.at), message: last.message, ...(last.subtype ? { subtype: last.subtype } : {}) };
    case "unfinished":
      // Rows stop mid-turn, nothing here runs it and nothing has written for a while: the run
      // died without a closing row (a crash, a killed process).
      return { outcome: "error", at: iso(last.at), message: "The turn ended without finishing" };
  }
}

export function listChatSessionStatus(
  deps: ChatSessionStatusDeps,
  opts: { sinceHours: number; project?: string },
): ChatSessionStatusResponse {
  const now = deps.now();
  const traces = deps.recentTraces(now - opts.sinceHours * 3_600_000);

  // One conversation, one row: a trace and the id it migrated to are the same session.
  const byId = new Map<string, { traceId: string; updatedAt: number; traceProvider: string | null }>();
  for (const t of traces) {
    const sessionId = deps.currentSessionId(t.traceId);
    const seen = byId.get(sessionId);
    if (!seen || t.updatedAt > seen.updatedAt) byId.set(sessionId, { traceId: t.traceId, updatedAt: t.updatedAt, traceProvider: t.providerId });
  }

  const ids = [...byId.keys()];
  const traceIds = [...byId.values()].map((v) => v.traceId);
  const meta = deps.metadata([...new Set([...ids, ...traceIds])]);
  const projects = deps.registeredProjects();
  const live = deps.liveState();

  const sessions: ChatSessionStatus[] = [];
  for (const [sessionId, { traceId, updatedAt, traceProvider }] of byId) {
    // Written under either id: the row the session goes by now wins, the original fills gaps.
    const current = meta.get(sessionId);
    const original = traceId !== sessionId ? meta.get(traceId) : undefined;
    if (!current && !original) continue;
    const projectName = current?.projectName ?? original?.projectName ?? null;
    if (!projectName || !projects.has(projectName)) continue;
    if (opts.project && projectName !== opts.project) continue;

    const entry = live.get(sessionId) ?? live.get(traceId);
    const phase: SessionPhase = entry?.phase ?? "idle";
    const status = deps.turnStatus(traceId);
    const pending = entry?.pending
      ? {
        kind: entry.pending.tool === "AskUserQuestion" ? "question" as const : "approval" as const,
        tool: entry.pending.tool,
        requestId: entry.pending.requestId,
        since: iso(entry.pending.since),
      }
      : null;

    sessions.push({
      sessionId,
      providerId: current?.providerId ?? entry?.providerId ?? original?.providerId ?? traceProvider ?? "claude",
      projectName,
      title: current?.title ?? original?.title ?? null,
      updatedAt: iso(updatedAt),
      phase,
      pending,
      lastTurn: lastTurnOf(
        status,
        phase !== "idle" || deps.isTurnRunning(sessionId) || deps.isTurnRunning(traceId),
        now,
        updatedAt,
      ),
      lastAnswerAt: status.lastAnswerAt === null ? null : iso(status.lastAnswerAt),
      lastUserMessageAt: status.lastUserMessageAt === null ? null : iso(status.lastUserMessageAt),
      // No answer in the rows read means there is nothing to have replied to.
      userRepliedSinceAnswer: status.lastUserMessageAt !== null && status.lastAnswerAt !== null
        && status.lastUserMessageAt > status.lastAnswerAt,
      unreadType: current?.unreadType ?? original?.unreadType ?? null,
    });
  }

  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { generatedAt: iso(now), sessions };
}
