/**
 * The restart-news half of the Assistant e2e fixture (`assistant-server.ts` with
 * PPM_ASSISTANT_RESTART_NEWS=1), for `tests/e2e/assistant-restart-news-e2e.mjs`:
 *
 * - this run is recorded at boot the way `src/server/index.ts` records it (`noteServerStart`, which
 *   reads PPM_START_REASON and PPM_START_DETAIL as the supervisor hands them over), and a clean stop
 *   on SIGTERM/SIGINT or the exit route (`noteServerStop`); a SIGKILL leaves no stop, as a crash does;
 * - PPM_ASSISTANT_E2E_PREVIOUS_VERSION rewrites the previous run's version in the run log before
 *   this run is recorded, which is how an upgrade is played without building two PPM versions;
 * - `/__assistant-test/rn/link {child, parent}` records that one chat opened another (`spawned_by`),
 *   `/__assistant-test/rn/trace/<sessionId>` lists a session's trace rows (flushed first), and
 *   `/__assistant-test/rn/state` answers the pending news, the run log and this run's restart.
 *
 * Imported only after `assistant-server.ts` has checked that PPM_HOME and HOME are scratch
 * directories and loaded the config.
 */

const json = (body: unknown, status = 200) => Response.json(body, { status });

export interface RestartNewsFixture {
  /** Records this run's clean stop; safe to call more than once. */
  stop(trigger: string): void;
  /** Handles `/__assistant-test/rn/<route>`; null for a route it does not own. */
  route(req: Request, route: string): Promise<Response | null>;
}

export async function setupRestartNews(): Promise<RestartNewsFixture> {
  const { getConfigValue, setConfigValue } = await import("../../../src/services/db.service");
  const { SERVER_RUN_LOG_ROW } = await import("../../../src/services/restart-news/server-run-log");
  const { RESTART_NEWS_ROW, pendingRestartNews } = await import("../../../src/services/restart-news/restart-news-source");
  const { currentServerStart, noteServerStart, noteServerStop } = await import("../../../src/services/restart-news/restart-news-run");

  const previousVersion = process.env.PPM_ASSISTANT_E2E_PREVIOUS_VERSION;
  if (previousVersion) {
    const log = JSON.parse(getConfigValue(SERVER_RUN_LOG_ROW) ?? "null") as { runs?: Array<{ version: string }> } | null;
    const last = log?.runs?.at(-1);
    if (!log || !last) throw new Error("PPM_ASSISTANT_E2E_PREVIOUS_VERSION needs a previous run in the run log");
    last.version = previousVersion;
    setConfigValue(SERVER_RUN_LOG_ROW, JSON.stringify(log));
  }
  if (!noteServerStart()) throw new Error("this fixture run could not be recorded in the run log");

  let stopped = false;
  return {
    stop(trigger) {
      if (stopped) return;
      stopped = true;
      try { noteServerStop(trigger); } catch (e) { console.error(`[restart-news fixture] could not record the stop: ${(e as Error).message}`); }
    },
    async route(req, route) {
      if (route === "link" && req.method === "POST") {
        const b = await req.json() as { child?: unknown; parent?: unknown };
        if (typeof b.child !== "string" || typeof b.parent !== "string") return json({ error: "child and parent are required" }, 400);
        const { recordSpawn } = await import("../../../src/services/session-collab/session-links.service");
        return json({ depth: recordSpawn(b.child, b.parent) });
      }
      if (route.startsWith("trace/")) {
        const { traceWriter } = await import("../../../src/services/session-trace/trace-writer");
        const { getTraceDb } = await import("../../../src/services/session-trace/session-trace-db");
        traceWriter.flush();
        const rows = getTraceDb()
          .query("SELECT ts, type FROM session_events WHERE trace_id = ? AND source <> 'browser' ORDER BY seq")
          .all(decodeURIComponent(route.slice("trace/".length)));
        return json({ rows });
      }
      if (route === "state") {
        const store = { load: () => getConfigValue(RESTART_NEWS_ROW), save: (v: string) => setConfigValue(RESTART_NEWS_ROW, v) };
        return json({
          pending: pendingRestartNews(store),
          runs: (JSON.parse(getConfigValue(SERVER_RUN_LOG_ROW) ?? "null") as { runs?: unknown[] } | null)?.runs ?? [],
          restart: currentServerStart()?.restart ?? null,
        });
      }
      return null;
    },
  };
}
