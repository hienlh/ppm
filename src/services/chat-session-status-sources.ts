import { getDb, getProjects, resolveMigratedSession } from "./db.service.ts";
import { getTraceDb } from "./session-trace/session-trace-db.ts";
import { readTurnStatusForTrace } from "./session-trace/turn-stop-reader.ts";
import { isTurnRunning } from "./session-trace/trace-recorder.ts";
import type { ChatSessionStatusDeps, LiveSessionState, SessionMetaRow } from "./chat-session-status.service.ts";

/** SQLite's default bound-parameter limit is 999; stay well under it. */
const IN_BATCH = 500;

/**
 * The real sources behind `listChatSessionStatus`. `liveState` is passed in because it lives
 * in the chat socket module, which the route loads lazily.
 */
export function chatSessionStatusSources(liveState: () => Map<string, LiveSessionState>): ChatSessionStatusDeps {
  return {
    now: () => Date.now(),
    recentTraces(sinceMs) {
      // `idx_session_events_ts` narrows this to the window; browser rows are filed under a
      // device, not a session, so they never name one.
      const rows = getTraceDb().query(
        `SELECT trace_id, MAX(ts) AS updated_at, MAX(provider_id) AS provider_id
         FROM session_events
         WHERE ts > ? AND source != 'browser'
         GROUP BY trace_id`,
      ).all(sinceMs) as { trace_id: string; updated_at: number; provider_id: string | null }[];
      return rows.map((r) => ({ traceId: r.trace_id, updatedAt: r.updated_at, providerId: r.provider_id }));
    },
    turnStatus: readTurnStatusForTrace,
    currentSessionId: resolveMigratedSession,
    metadata(sessionIds) {
      const out = new Map<string, SessionMetaRow>();
      for (let i = 0; i < sessionIds.length; i += IN_BATCH) {
        const batch = sessionIds.slice(i, i + IN_BATCH);
        const placeholders = batch.map(() => "?").join(", ");
        const rows = getDb().query(
          `SELECT m.session_id, m.project_name, m.provider_id, m.unread_type, COALESCE(t.title, m.last_known_title) AS title
           FROM session_metadata m LEFT JOIN session_titles t ON m.session_id = t.session_id
           WHERE m.session_id IN (${placeholders})`,
        ).all(...batch) as { session_id: string; project_name: string | null; provider_id: string | null; unread_type: string | null; title: string | null }[];
        for (const r of rows) {
          out.set(r.session_id, {
            sessionId: r.session_id,
            projectName: r.project_name,
            providerId: r.provider_id,
            unreadType: r.unread_type,
            title: r.title,
          });
        }
      }
      return out;
    },
    registeredProjects: () => new Set(getProjects().map((p) => p.name)),
    liveState,
    isTurnRunning,
  };
}
