/**
 * A scratch PPM server for the chat CLI tests, run as its own process like
 * `cli-scratch-server-main.ts` (same arguments, same `READY <port>`), with the real chat stack:
 * the project-scoped chat and tag routes, the real chat socket (`ws/chat.ts`) and its chat
 * control, and the session trace. The only provider is a scripted stand-in for Claude whose turn
 * runs until it is stopped — or, for a session marked stuck, ignores the stop.
 *
 * Test-only routes under `/api/__scratch/`: `config`, `events` (as the base server), and
 * `chat/start`, `chat/stuck`, `chat/state/:id`, `chat/rows/:id`, `trace/:id`, and `review/seed`
 * (two turns of file changes and the history naming their calls, `cli-chat-review-seed.ts`).
 */
import { Hono } from "hono";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertIsolatedPpmHome } from "./assert-isolated-ppm-home.ts";

assertIsolatedPpmHome();
const token = process.argv[3] ?? "scratch-token";
// Nothing below may reach the real Claude or Codex folders.
process.env.CLAUDE_CONFIG_DIR = join(process.env.PPM_HOME!, ".claude");
process.env.CODEX_HOME = join(process.env.PPM_HOME!, ".codex");
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]) delete process.env[key];

const db = await import("../../src/services/db.service.ts");
const { configService } = await import("../../src/services/config.service.ts");
configService.load();
configService.set("auth", { enabled: true, token });
configService.set("ai", { ...configService.get("ai"), default_provider: "claude", providers: { claude: { type: "mock", permission_mode: "bypassPermissions" } } } as never);
configService.save();

const { MockProvider } = await import("../../src/providers/mock-provider.ts");
type ChatEvent = import("../../src/providers/provider.interface.ts").ChatEvent;
type ChatMessage = import("../../src/types/chat.ts").ChatMessage;

class ScratchClaude extends MockProvider {
  readonly stuck = new Set<string>();
  /** A history a test wrote for a session, served in place of the mock's own. */
  readonly scripted = new Map<string, ChatMessage[]>();
  override async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.scripted.get(sessionId) ?? super.getMessages(sessionId);
  }
  private readonly releases = new Map<string, () => void>();
  constructor() {
    super();
    this.id = "claude";
    this.name = "Claude";
  }
  /**
   * Records the chat's project, as the real providers do when they create a session, and leaves
   * a one-line Claude transcript where Claude's SDK looks for it, so a rename has a file to name.
   */
  override async createSession(config: Parameters<MockProvider["createSession"]>[0]) {
    const session = await super.createSession(config);
    db.setSessionMetadata(session.id, config.projectName, config.projectPath);
    if (config.projectPath) {
      const dir = join(process.env.CLAUDE_CONFIG_DIR!, "projects", config.projectPath.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      const line = { type: "user", sessionId: session.id, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(),
        cwd: config.projectPath, message: { role: "user", content: "Hello" } };
      writeFileSync(join(dir, `${session.id}.jsonl`), `${JSON.stringify(line)}\n`);
    }
    return session;
  }
  /** A turn that works until it is stopped; a stopped turn's stream simply ends, as Claude's does. */
  override async *sendMessage(sessionId: string): AsyncIterable<ChatEvent> {
    yield { type: "text", content: "Working." };
    await new Promise<void>((resolve) => this.releases.set(sessionId, resolve));
  }
  override abortQuery(sessionId: string): void {
    if (!this.stuck.has(sessionId)) this.release(sessionId);
  }
  release(sessionId: string): void {
    this.releases.get(sessionId)?.();
    this.releases.delete(sessionId);
  }
}

const { providerRegistry } = await import("../../src/providers/registry.ts");
const claude = new ScratchClaude();
providerRegistry.register(claude as never);
providerRegistry.get = ((id: string) => (id === "claude" ? claude : undefined)) as typeof providerRegistry.get;
providerRegistry.list = () => [{ id: claude.id, name: claude.name }];
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = (() => claude) as typeof providerRegistry.getDefault;

const { cliHelloRoutes } = await import("../../src/server/routes/cli-hello.ts");
const { authMiddleware } = await import("../../src/server/middleware/auth.ts");
const { setServerListenAddress } = await import("../../src/services/server-listen-address.ts");
const { publishServerEndpoint } = await import("../../src/services/server-endpoint-file.ts");
const { serverInstanceId } = await import("../../src/services/server-instance-id.ts");
const { projectRoutes } = await import("../../src/server/routes/projects.ts");
const { projectScopedRouter } = await import("../../src/server/routes/project-scoped.ts");
const { chatWebSocket, chatSocketData } = await import("../../src/server/ws/chat.ts");
const { globalWebSocket } = await import("../../src/server/ws/global.ts");
const { chatControl } = await import("../../src/services/chat-control/chat-control.ts");
const { traceWriter } = await import("../../src/services/session-trace/trace-writer.ts");
const { readSessionTimeline } = await import("../../src/services/session-trace/session-trace-store.ts");
const { getSessionTags } = await import("../../src/services/tag.service.ts");
const { seedReview } = await import("./cli-chat-review-seed.ts");
const { ok, err } = await import("../../src/types/api.ts");

const events: unknown[] = [];
globalWebSocket.open({ data: { type: "global" }, send: (json: string) => { events.push(JSON.parse(json)); return json.length; } } as never);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const app = new Hono();
app.route("/api/cli", cliHelloRoutes);
app.use("/api/*", authMiddleware);
app.route("/api/projects", projectRoutes);
app.route("/api/project/:projectName", projectScopedRouter);
app.get("/api/__scratch/config", (c) => c.json(ok(configService.getAll())));
app.get("/api/__scratch/events", (c) => c.json(ok(events)));
app.post("/api/__scratch/chat/start", async (c) => {
  const { sessionId, projectName } = await c.req.json<{ sessionId: string; projectName: string }>();
  const control = chatControl()!;
  const sent = control.sendUserMessage(sessionId, "Work on it.", { origin: "telegram", projectName, providerId: "claude" });
  for (let i = 0; i < 100 && !control.liveState(sessionId)?.running; i++) await sleep(50);
  if (!control.liveState(sessionId)?.running) return c.json(err(`turn did not start: ${JSON.stringify(await sent)}`), 500);
  return c.json(ok({ running: true }));
});
app.post("/api/__scratch/chat/stuck", async (c) => {
  const { sessionId, stuck } = await c.req.json<{ sessionId: string; stuck: boolean }>();
  if (stuck) claude.stuck.add(sessionId);
  else { claude.stuck.delete(sessionId); claude.release(sessionId); }
  return c.json(ok({ stuck }));
});
app.get("/api/__scratch/chat/state/:id", (c) => c.json(ok(chatControl()!.liveState(c.req.param("id")))));
app.get("/api/__scratch/chat/rows/:id", (c) => {
  const id = c.req.param("id");
  return c.json(ok({
    title: db.getSessionTitle(id), pinned: db.getPinnedSessionIds().has(id),
    tag: getSessionTags([id])[id]?.name ?? null, projectPath: db.getSessionProjectPath(id),
  }));
});
app.get("/api/__scratch/trace/:id", (c) => {
  traceWriter.flush();
  return c.json(ok(readSessionTimeline(c.req.param("id")).map((e) => ({ type: e.type, payload: e.payload }))));
});
app.post("/api/__scratch/review/seed", async (c) => {
  const { sessionId, dir } = await c.req.json<{ sessionId: string; dir: string }>();
  const seeded = await seedReview(sessionId, dir);
  claude.scripted.set(sessionId, seeded.messages);
  return c.json(ok(seeded.files));
});

type SocketData = ReturnType<typeof chatSocketData>;
const server = Bun.serve<SocketData>({
  port: 0, hostname: "127.0.0.1",
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/ws/")) {
      if (url.searchParams.get("token") !== token) return new Response("Unauthorized", { status: 401 });
      const parts = url.pathname.split("/");
      if (parts[2] !== "project" || parts[4] !== "chat") return new Response("Not found", { status: 404 });
      const data = chatSocketData(decodeURIComponent(parts[5] ?? ""), decodeURIComponent(parts[3] ?? ""), url.searchParams);
      return instance.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
    }
    return app.fetch(req, instance);
  },
  websocket: {
    open: (ws) => chatWebSocket.open(ws as never),
    message: (ws, message) => chatWebSocket.message(ws as never, message as string),
    close: (ws) => chatWebSocket.close(ws as never),
  },
});
setServerListenAddress(server.port, "127.0.0.1");
publishServerEndpoint({ port: server.port, host: "127.0.0.1", dbFile: db.getDbPath(), version: "scratch", instanceId: serverInstanceId() });
process.on("SIGTERM", () => process.exit(0));
console.log(`READY ${server.port}`);
