/**
 * Isolated real-route server for the schedule owners e2e (`tests/e2e/schedule-owners-e2e.mjs`).
 * Never use __serve__. The same isolation guards as the other html-preview fixtures, a mock
 * provider only, and one test route: `/__owners-test/seed` puts four chats, three script schedules
 * with no owner and a session trace written the way Claude's answers really are stored (an MCP
 * content array as a JSON string) into this scratch PPM. It publishes its endpoint file, so a real
 * `ppm schedule owners --dry-run` run with the same PPM_HOME reaches it. Nothing reaches Anthropic.
 */
import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const canonical = (path: string) => realpathSync(path).replace(/\\/g, "/").toLowerCase();
const ppmHome = process.env.PPM_HOME, sandboxHome = process.env.HOME;
const profile = process.env.USERPROFILE, realHomePath = process.env.PPM_HTML_TEST_REAL_HOME;
if (!ppmHome || !sandboxHome || !profile || !realHomePath) throw new Error("Fixture requires isolated PPM_HOME, HOME, USERPROFILE and the parent's real home.");
const realHome = canonical(realHomePath), privateHome = canonical(sandboxHome), privatePpm = canonical(ppmHome);
if (privateHome === realHome || canonical(profile) !== privateHome || privatePpm === realHome ||
    privatePpm === `${realHome}/.ppm` || privatePpm.startsWith(`${realHome}/.ppm/`)) {
  throw new Error("Refusing the production home or PPM directory");
}
if (existsSync(resolve(ppmHome, "ppm.db"))) throw new Error("Fixture requires an empty PPM_HOME");
if (process.argv.includes("__serve__") || process.env.PPM_ALLOW_PROD_DB) throw new Error("Production flags are forbidden");
const port = Number(process.env.PPM_HTML_TEST_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3211, 3212, 3214, 8080, 8081].includes(port)) throw new Error("Invalid fixture port");
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");

// Import services only after validating environment isolation.
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("port", port);
configService.set("ai", {
  default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false,
  providers: { claude: { type: "mock", permission_mode: "bypassPermissions" } },
});
await (await import("./answer-feature-intros")).answerFeatureIntrosAtStartup();

const db = await import("../../../src/services/db.service");
const { getSchedule, insertSchedule } = await import("../../../src/services/scheduler-db.service");
const { getTraceDbPath } = await import("../../../src/services/session-trace/session-trace-db");
const { providerRegistry } = await import("../../../src/providers/registry");
const { MockProvider } = await import("../../../src/providers/mock-provider");
/** The only provider: a mock answering as "claude", whose chat list the owner picker reads. */
class ClaudeMock extends MockProvider {
  constructor() { super(); this.id = "claude"; this.name = "Claude"; }
  /** Its in-memory sessions, which `seed` fills with the made-up chats. */
  get chats() { return (this as unknown as { sessions: Map<string, unknown> }).sessions; }
}
const claude = new ClaudeMock();
providerRegistry.register(claude as never);
// Keep the imported production provider instances unreachable, including aggregate routes.
providerRegistry.get = ((id: string) => (id === "claude" ? claude : undefined)) as typeof providerRegistry.get;
providerRegistry.list = () => [{ id: claude.id, name: claude.name }];
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = (() => claude) as typeof providerRegistry.getDefault;
const { app } = await import("../../../src/server/index");
const { globalWebSocket } = await import("../../../src/server/ws/global");
const { publishServerEndpoint } = await import("../../../src/services/server-endpoint-file");
const { serverInstanceId } = await import("../../../src/services/server-instance-id");

/** Made-up chats: the manager that built the watches, and the chats they belong with. */
export const CHATS = {
  manager: { id: "1a2b3c4d-0000-4000-8000-000000000001", title: "Project manager" },
  slack: { id: "1a2b3c4d-0000-4000-8000-000000000002", title: "QL Slack" },
  review: { id: "1a2b3c4d-0000-4000-8000-000000000003", title: "QL Review PR" },
  pic: { id: "1a2b3c4d-0000-4000-8000-000000000004", title: "PIC this week" },
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** A propose_script call and its answer, as the trace recorder stores a Claude MCP answer. */
function traceCreation(t: Database, traceId: string, seq: number, id: number, name: string): void {
  const at = Date.parse(`${getSchedule(id)!.created_at.replace(" ", "T")}Z`) - 1500;
  const add = t.query("INSERT INTO session_events (trace_id, seq, ts, source, origin, type, payload_json) VALUES (?, ?, ?, 'agent', 'user', ?, ?)");
  const useId = `toolu_seed_${seq}`;
  const output = JSON.stringify([{ type: "text", text: JSON.stringify({ created: true, schedule: { id, name, kind: "script", mode: "tick" }, note: "The user allowed it." }, null, 1) }]);
  add.run(traceId, seq, at, "tool_use", JSON.stringify({ type: "tool_use", tool: "mcp__ppm-sessions__session_schedule_propose_script", input: { file: "watch.ppm-schedule.json" }, toolUseId: useId }));
  add.run(traceId, seq + 1, at + 1900, "tool_result", JSON.stringify({ type: "tool_result", output, isError: false, toolUseId: useId }));
}

function seed(projectName: string, projectPath: string): unknown {
  // The chat list the owner picker reads comes from the provider: the mock keeps its sessions in memory.
  let minutesAgo = 0;
  for (const chat of Object.values(CHATS)) {
    db.setSessionMetadata(chat.id, projectName, projectPath);
    db.setSessionProvider(chat.id, "claude");
    db.setSessionTitle(chat.id, chat.title);
    claude.chats.set(chat.id, {
      id: chat.id, providerId: "claude", title: chat.title, projectName,
      createdAt: new Date(Date.now() - (minutesAgo += 7) * 60_000).toISOString(),
    });
  }
  const watch = (name: string, reportsTo: string) => insertSchedule({
    name, cron_expr: "*/5 * * * *", provider_id: "claude", project_path: projectPath, prompt: "", enabled: true,
    kind: "script", script: "export default async (ctx) => { ctx.log('checked'); };", description: `Checks every 5 minutes and reports to its chat.`,
    inputs_json: JSON.stringify([{ key: "sessionId", label: "Chat to report to", type: "text", required: true, default: reportsTo }]),
    input_values_json: "{}", timezone: "Europe/London", next_fire_at: new Date(Math.ceil(Date.now() / 300_000) * 300_000).toISOString(),
  });
  const slack = watch("slack-watch", CHATS.slack.id);
  const review = watch("review-queue-watch", CHATS.review.id);
  const pic = watch("prod-issue-watch", CHATS.pic.id);
  const t = new Database(getTraceDbPath(), { create: true });
  t.exec(`CREATE TABLE IF NOT EXISTS session_events (
    trace_id TEXT NOT NULL, seq INTEGER NOT NULL, turn_id TEXT, ts INTEGER NOT NULL, source TEXT NOT NULL,
    origin TEXT NOT NULL, provider_id TEXT, ref_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY (trace_id, seq))`);
  // slack-watch and prod-issue-watch were proposed by the chats they report to; review-queue-watch
  // by the manager, on behalf of the review chat.
  traceCreation(t, CHATS.slack.id, 1, slack, "slack-watch");
  traceCreation(t, CHATS.manager.id, 1, review, "review-queue-watch");
  traceCreation(t, CHATS.pic.id, 1, pic, "prod-issue-watch");
  t.close();
  return { schedules: { slack, review, pic }, chats: CHATS };
}

type SocketData = { type: "health" | "global" };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  async fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname === "/__html-test/shutdown" && req.method === "POST") {
      setTimeout(shutdown, 50);
      return new Response("Stopping fixture");
    }
    if (url.pathname === "/__owners-test/seed" && req.method === "POST") {
      const { name, path } = await req.json() as { name: string; path: string };
      return json(seed(name, path));
    }
    let data: SocketData | undefined;
    if (url.pathname === "/ws/health") data = { type: "health" };
    else if (url.pathname === "/ws/global") data = { type: "global" };
    if (data) return instance.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
    if (url.pathname.startsWith("/ws/")) return new Response("Socket disabled in fixture", { status: 404 });
    if (/^\/api\/(?:accounts|tunnels?|preview|upgrade|codex-accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname) ||
        /^\/api\/settings\/(?:telegram|clawbot|ppmbot)/.test(url.pathname)) return new Response("Disabled in fixture", { status: 403 });
    return app.fetch(req, instance);
  },
  websocket: {
    idleTimeout: 960, sendPong: true,
    open(ws) { if (ws.data.type === "global") globalWebSocket.open(ws); },
    message(ws, message) {
      if (ws.data.type === "global") globalWebSocket.message(ws, message as string);
      else ws.send("pong");
    },
    close(ws) { if (ws.data.type === "global") globalWebSocket.close(ws); },
  },
});
publishServerEndpoint({ port: server.port, host: "127.0.0.1", dbFile: db.getDbPath(), version: "scratch", instanceId: serverInstanceId() });
function shutdown() { server.stop(true); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Schedule owners fixture ready at http://127.0.0.1:${server.port}; mock provider only.`);
