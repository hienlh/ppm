/**
 * The task store half of the Assistant e2e fixture (`assistant-server.ts` with PPM_ASSISTANT_TASKS=1,
 * which needs PPM_ASSISTANT_MANAGER_LOOP=1 too), for `tests/e2e/ppm-tasks-e2e.mjs`:
 *
 * - the task events reach browsers over `/ws/global`, as the real server starts them;
 * - the handed-off work checker runs on a clock of its own that the e2e moves
 *   (`POST /__assistant-test/tasks/check {advanceMs}` moves it and runs one check at once). The live
 *   checker and the link-state refresher are never started: no timer of the real clock may check a
 *   child behind the e2e's back, and no Jira or GitHub is asked;
 * - `POST /__assistant-test/tasks/child-lines {sessionId, lines}` appends tool output to a chat's
 *   Claude transcript, stamped with the checker's clock, as a child printing a waiting loop would;
 * - `GET /__assistant-test/tasks/messages` lists every message that entered a chat, with its origin
 *   (`ppm_ui` for the server's own decision and wake turns), from the chat lifecycle bus.
 *
 * Imported only after `assistant-server.ts` has checked that PPM_HOME and HOME are scratch
 * directories.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const json = (body: unknown, status = 200) => Response.json(body, { status });

export interface TasksFixture {
  /** Handles `/__assistant-test/tasks/<route>`; null for a route it does not own. */
  route(req: Request, route: string): Promise<Response | null>;
}

export async function setupTasksFixture(): Promise<TasksFixture> {
  const { startPpmTasksBroadcast } = await import("../../../src/server/ws/ppm-tasks-broadcast");
  const { createChildCheckRunner } = await import("../../../src/services/ppm-tasks/child-check/child-check-runner");
  const { liveChildCheckEnv } = await import("../../../src/services/ppm-tasks/child-check/child-check-env");
  const { chatLifecycle } = await import("../../../src/services/chat-control/chat-lifecycle");
  const { resolveSessionTranscript } = await import("../../../src/services/session-turns/session-turn-index.service");
  const { getSessionProjectPath } = await import("../../../src/services/db.service");
  // Registers the manager news formatter and the wake budget's listener, as the server's start does.
  await import("../../../src/services/ppm-tasks/ppm-tasks-startup");
  await import("../../../src/services/ppm-tasks/ppm-task-manager-news");
  await import("../../../src/services/ppm-tasks/ppm-task-unattended-card");

  startPpmTasksBroadcast();
  let offset = 0;
  const checkNow = () => Date.now() + offset;
  const checks = createChildCheckRunner({ ...liveChildCheckEnv, now: checkNow });

  const messages: Array<{ sessionId: string; origin: string; text: string; at: number }> = [];
  chatLifecycle.on("user_message", (m) => { messages.push({ sessionId: m.sessionId, origin: m.origin, text: m.text, at: Date.now() }); });

  return {
    async route(req, route) {
      if (route === "check") {
        const body = req.method === "POST" ? await req.json() as { advanceMs?: unknown } : {};
        const advance = typeof body.advanceMs === "number" && Number.isFinite(body.advanceMs) && body.advanceMs >= 0 ? body.advanceMs : 0;
        offset += advance;
        if (req.method === "POST") await checks.tick();
        return json({ now: checkNow(), offset });
      }
      if (route === "child-lines" && req.method === "POST") {
        const b = await req.json() as { sessionId?: unknown; lines?: unknown };
        if (typeof b.sessionId !== "string" || !Array.isArray(b.lines)) return json({ error: "sessionId and lines are required" }, 400);
        const projectPath = getSessionProjectPath(b.sessionId);
        if (!projectPath) return json({ error: "no such chat" }, 404);
        const path = resolveSessionTranscript({ providerId: "claude", sessionId: b.sessionId, projectPath }).path;
        mkdirSync(dirname(path), { recursive: true });
        const at = new Date(checkNow()).toISOString();
        const records = (b.lines as unknown[]).map((line) => JSON.stringify({
          type: "user", sessionId: b.sessionId, timestamp: at, uuid: crypto.randomUUID(),
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu-${crypto.randomUUID()}`, content: String(line) }] },
        }));
        appendFileSync(path, `${records.join("\n")}\n`);
        return json({ ok: true, path, at });
      }
      if (route === "messages") return json(messages);
      // A project's Jira site and its links' cached states, as a Jira config and the link checker
      // would leave them (the checker never runs here, and no Jira or GitHub is asked).
      if (route === "link-world" && req.method === "POST") {
        const b = await req.json() as { projectPath?: unknown; jiraBaseUrl?: unknown; states?: unknown };
        if (typeof b.projectPath !== "string" || !Array.isArray(b.states)) return json({ error: "projectPath and states are required" }, 400);
        const { getDb } = await import("../../../src/services/db.service");
        const { projectKey } = await import("../../../src/services/project-name-for-path");
        // The real link-state source over this cache, whose reads never leave the machine: a Jira
        // read answers "paused" and a PR read answers nothing, so the rows below are what shows.
        const { createLinkStateService, liveLinkStateEnv } = await import("../../../src/services/ppm-tasks/link-state/ppm-tasks-link-state.service");
        const { setTaskLinkStateSource } = await import("../../../src/services/ppm-tasks/ppm-tasks-link-state-source");
        setTaskLinkStateSource(createLinkStateService({ ...liveLinkStateEnv, readJira: async () => null, readPrs: async () => new Map() }).source);
        const db = getDb();
        const project = db.query("SELECT id FROM projects WHERE path = ?").get(b.projectPath) as { id: number } | null;
        if (!project) return json({ error: "no such project" }, 404);
        if (typeof b.jiraBaseUrl === "string") {
          db.query("INSERT OR REPLACE INTO jira_config (project_id, base_url, email, api_token_encrypted) VALUES (?, ?, 'alpha@example.com', 'e2e-not-a-token')")
            .run(project.id, b.jiraBaseUrl);
        }
        const key = projectKey(b.projectPath);
        const now = Date.now();
        for (const s of b.states as Array<{ kind: string; ref: string; state: unknown }>) {
          db.query("INSERT OR REPLACE INTO task_link_state (kind, ref, project_key, state_json, error, checked_at, changed_at) VALUES (?, ?, ?, ?, NULL, ?, ?)")
            .run(s.kind, s.ref, key, JSON.stringify(s.state), now, now);
        }
        return json({ ok: true, projectKey: key });
      }
      // A turn PPM starts itself (`watch`), as a watch or a wake does: nobody wrote in it, so an
      // Assistant turn begun this way is unattended.
      if (route === "watch-turn" && req.method === "POST") {
        const b = await req.json() as { sessionId?: unknown; projectName?: unknown; text?: unknown };
        if (typeof b.sessionId !== "string" || typeof b.projectName !== "string" || typeof b.text !== "string") return json({ error: "sessionId, projectName and text are required" }, 400);
        const { chatControl } = await import("../../../src/services/chat-control/chat-control");
        const control = chatControl();
        if (!control) return json({ error: "no chat control" }, 500);
        return json({ result: await control.sendUserMessage(b.sessionId, b.text, { origin: "watch", projectName: b.projectName, providerId: "claude" }) });
      }
      return null;
    },
  };
}
