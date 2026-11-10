/**
 * A scratch git project with a manager chat, a scripted Claude provider and the Assistant's routes,
 * for the manager-rules integration tests. The provider records every stream start (`sends`) and
 * every follow-up pushed into a live stream (`pushes`), and answers the rules check from `check`.
 */
import { Hono } from "hono";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerRegistry } from "../../src/providers/registry.ts";
import { assistantSettingsRoutes } from "../../src/server/routes/assistant-settings.ts";
import { configService } from "../../src/services/config.service.ts";
import { setSessionMetadata, setSessionProvider } from "../../src/services/db.service.ts";
import { managerChats } from "../../src/services/assistant-managers/manager-chats.service.ts";
import { managerRulesEvents, type ManagerRulesEvent } from "../../src/services/assistant-managers/manager-rules-events.ts";
import { rulesFilePath } from "../../src/services/assistant-managers/manager-rules-file.ts";
import type { AIProvider, SendMessageOpts } from "../../src/providers/provider.interface.ts";

export const RESTRICTS_ALL = (count: number) =>
  JSON.stringify({ verdicts: Array.from({ length: count }, (_, i) => ({ line: i + 1, verdict: "restriction" })) });

export function createManagerRulesFixture(name: string) {
  const sends: SendMessageOpts[] = [];
  const pushes: SendMessageOpts[] = [];
  const events: ManagerRulesEvent[] = [];
  const created: string[] = [];
  const state = { check: async (_prompt: string): Promise<string> => RESTRICTS_ALL(1), checks: 0 };

  const claude = {
    id: "claude", name: "Scripted Claude", supportsSharedContext: true,
    async createSession() {
      const id = crypto.randomUUID();
      created.push(id);
      return { id, providerId: "claude", title: "", createdAt: new Date().toISOString() };
    },
    async resumeSession(id: string) { return { id, providerId: "claude", title: "", createdAt: "" }; },
    async listSessions() { return []; },
    async deleteSession() {},
    async *sendMessage(id: string, _message: string, opts: SendMessageOpts) {
      sends.push(opts);
      yield { type: "system", subtype: "compact_done" } as never;
      yield { type: "done", sessionId: id } as never;
    },
    hasStreamingSession: () => true,
    pushMessage(_id: string, _content: string, opts: SendMessageOpts) { pushes.push(opts); return true; },
    async completeOnce(input: { prompt: string }) {
      state.checks++;
      return { text: await state.check(input.prompt), costUsd: 0, inputTokens: 0, outputTokens: 0 };
    },
  };

  const app = new Hono();
  app.route("/api/assistant", assistantSettingsRoutes);
  let original: AIProvider | undefined;
  let projectsBefore = configService.get("projects");
  let shareBefore: boolean | undefined;
  let off: (() => void) | null = null;
  let counter = 0;

  return {
    sends, pushes, events, created, state,
    setup() {
      original = providerRegistry.get("claude");
      providerRegistry.register(claude as never);
      projectsBefore = configService.get("projects");
      shareBefore = configService.get("ai").share_provider_context;
      // The manager entry must not depend on sharing provider context.
      configService.get("ai").share_provider_context = false;
      off = managerRulesEvents.on((e) => events.push(e));
    },
    teardown() {
      for (const p of configService.get("projects")) if (p.name.startsWith(name)) managerChats.unassign(p.name);
      (configService as any).config.projects = projectsBefore;
      configService.get("ai").share_provider_context = shareBefore;
      off?.();
      if (original) providerRegistry.register(original);
    },
    /** A fresh git project, registered with PPM. */
    project() {
      const project = { name: `${name}-${++counter}`, path: join(process.env.PPM_HOME!, `${name}-${counter}`) };
      mkdirSync(project.path, { recursive: true });
      Bun.spawnSync(["git", "init", "-q"], { cwd: project.path });
      (configService as any).config.projects = [...configService.get("projects"), project];
      return project;
    },
    chat(project: { name: string; path: string }) {
      const id = crypto.randomUUID();
      setSessionMetadata(id, project.name, project.path);
      setSessionProvider(id, "claude");
      return id;
    },
    /** A project with a manager chat assigned through the route. */
    async managed(before?: (project: { name: string; path: string }) => void) {
      const project = this.project();
      before?.(project);
      const sessionId = this.chat(project);
      const res = await this.call("PUT", `/api/assistant/managers/${project.name}`, { sessionId });
      if (res.status !== 200) throw new Error(`assign failed: ${JSON.stringify(res.json)}`);
      return { project, sessionId };
    },
    readRules: (projectPath: string) => readFileSync(rulesFilePath(projectPath), "utf8"),
    writeRules: (projectPath: string, text: string) => {
      mkdirSync(join(projectPath, ".ppm"), { recursive: true });
      writeFileSync(rulesFilePath(projectPath), text);
    },
    git: (projectPath: string, ...args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: projectPath, stdout: "pipe", stderr: "pipe" }).stdout.toString(),
    async call(method: string, path: string, body?: unknown) {
      const res = await app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: await res.json() as { ok: boolean; data?: any; error?: string } };
    },
  };
}
