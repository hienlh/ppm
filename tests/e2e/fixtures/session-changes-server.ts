/** Served-production fixture for the session changes bar and Review tab. Adapted from
 * chat-reply-server. Requires an isolated home and PPM directory, serves the scratch Vite
 * bundle named by PPM_CHANGES_WEB_DIR, and answers every turn with a scripted provider that
 * really writes the project's files — taking each file's "before" first, the way the Claude
 * provider's PreToolUse hook does, and bracketing each shell command with the same calls its
 * shell hooks make. No real SDK or CLI turns.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid fixture port");
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");
process.env.SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/bash";

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

const { MockProvider } = await import("../../../src/providers/mock-provider");
const { setSessionMetadata } = await import("../../../src/services/db.service");
const { captureBaseline } = await import("../../../src/services/session-file-baselines/session-file-baselines.service");
const { observeFile } = await import("../../../src/services/session-file-baselines/session-file-history");
const { beginShellCommand, endShellCommand } = await import("../../../src/services/session-file-baselines/shell-change-tracker");
type SendOpts = import("../../../src/providers/provider.interface").SendMessageOpts;
type ChatEvent = import("../../../src/providers/provider.interface").ChatEvent;
type ChatMessage = import("../../../src/providers/provider.interface").ChatMessage;
type SessionConfig = import("../../../src/providers/provider.interface").SessionConfig;
type Session = import("../../../src/providers/provider.interface").Session;

/** One file write, or one shell command, a scripted turn performs. */
type ScriptOp =
  | { tool: "Edit" | "Write"; path: string; oldString?: string; newString?: string; content?: string }
  | { tool: "Bash"; command: string; cwd: string };
let script: ScriptOp[] = [];
const turns: { sessionId: string; message: string; at: number }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ChangesMock extends MockProvider {
  private history = new Map<string, ChatMessage[]>();
  constructor() {
    super();
    this.id = "claude";
    this.name = "Claude";
  }
  // As the Claude provider does: the review's routes answer only for a session of their project.
  override async createSession(config: SessionConfig): Promise<Session> {
    const session = await super.createSession(config);
    setSessionMetadata(session.id, config.projectName, config.projectPath);
    return session;
  }
  override async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.history.get(sessionId) ?? [];
  }
  override async *sendMessage(sessionId: string, message: string, _opts?: SendOpts): AsyncIterable<ChatEvent> {
    await this.resumeSession(sessionId);
    turns.push({ sessionId, message, at: Date.now() });
    const history = this.history.get(sessionId) ?? [];
    history.push({ id: crypto.randomUUID(), role: "user", content: message, timestamp: new Date().toISOString() });
    yield { type: "system" as never, subtype: "init" } as never;
    const events: ChatEvent[] = [];
    for (const op of script) {
      const toolUseId = `tu-${crypto.randomUUID()}`;
      if (op.tool === "Bash") {
        const use = { type: "tool_use", tool: "Bash", input: { command: op.command }, toolUseId } as ChatEvent;
        events.push(use);
        yield use;
        // What the Claude provider's shell hooks do around the CLI running the command.
        await beginShellCommand({ sessionId, toolUseId, cwd: op.cwd, command: op.command });
        const run = Bun.spawnSync(["bash", "-c", op.command], { cwd: op.cwd });
        if (run.exitCode !== 0) throw new Error(`${op.command}: ${run.stderr.toString()}`);
        await endShellCommand({ sessionId, toolUseId });
        const result = { type: "tool_result", output: "", toolUseId } as ChatEvent;
        events.push(result);
        yield result;
        await sleep(300);
        continue;
      }
      const input = op.tool === "Write"
        ? { file_path: op.path, content: op.content ?? "" }
        : { file_path: op.path, old_string: op.oldString ?? "", new_string: op.newString ?? "" };
      const use = { type: "tool_use", tool: op.tool, input, toolUseId } as ChatEvent;
      events.push(use);
      yield use;
      // What the Claude provider's PreToolUse hook does before the CLI runs the tool.
      await captureBaseline(sessionId, op.path);
      await observeFile(sessionId, op.path, toolUseId, "before");
      if (op.tool === "Write") {
        mkdirSync(dirname(op.path), { recursive: true });
        writeFileSync(op.path, op.content ?? "");
      } else {
        const before = await Bun.file(op.path).text();
        if (!before.includes(op.oldString ?? "")) throw new Error(`old_string not found in ${op.path}`);
        writeFileSync(op.path, before.replace(op.oldString ?? "", op.newString ?? ""));
      }
      // ...and its PostToolUse hook after.
      await observeFile(sessionId, op.path, toolUseId, "after");
      const result = { type: "tool_result", output: "The file has been updated.", toolUseId } as ChatEvent;
      events.push(result);
      yield result;
      await sleep(300);
    }
    const text = `Changed ${script.length} file${script.length === 1 ? "" : "s"}.`;
    yield { type: "text", content: text };
    history.push({ id: crypto.randomUUID(), role: "assistant", content: text, events, timestamp: new Date().toISOString() } as ChatMessage);
    this.history.set(sessionId, history);
    yield { type: "done", sessionId };
  }
}

const { providerRegistry } = await import("../../../src/providers/registry");
const claude = new ChangesMock();
const providers = [claude];
providerRegistry.register(claude as never);
// Keep the imported production provider instances unreachable, including aggregate routes.
providerRegistry.get = ((id: string) => providers.find((p) => p.id === id)) as typeof providerRegistry.get;
providerRegistry.list = () => providers.map((p) => ({ id: p.id, name: p.name }));
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = (() => claude) as typeof providerRegistry.getDefault;

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function testRoute(req: Request, path: string): Promise<Response> {
  if (path === "/__changes-test/state") return json({ turns });
  if (path === "/__changes-test/script" && req.method === "POST") {
    script = (await req.json() as { ops: ScriptOp[] }).ops;
    return json({ ok: true, ops: script.length });
  }
  return json({ error: "unknown test route" }, 404);
}

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__changes-test/")) return testRoute(req, url.pathname);
    let data: SocketData | undefined;
    if (url.pathname === "/ws/health") data = { type: "health" };
    else if (url.pathname === "/ws/global") data = { type: "global" };
    else if (url.pathname.startsWith("/ws/project/")) {
      const parts = url.pathname.split("/");
      if (parts[4] === "chat") data = { type: "chat", sessionId: parts[5] ?? "", projectName: decodeURIComponent(parts[3] ?? "") };
    }
    if (data) return instance.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
    if (url.pathname.startsWith("/ws/")) return new Response("Socket disabled in fixture", { status: 404 });
    if (/^\/api\/(?:accounts|tunnels?|preview|upgrade|codex-accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname) ||
        /^\/api\/settings\/(?:telegram|clawbot|ppmbot)/.test(url.pathname)) return new Response("Disabled in fixture", { status: 403 });
    if (!url.pathname.startsWith("/api/")) {
      const webDir = process.env.PPM_CHANGES_WEB_DIR;
      if (!webDir) throw new Error("PPM_CHANGES_WEB_DIR required");
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (relative.includes("..")) return new Response("Invalid path", { status: 400 });
      const file = Bun.file(resolve(webDir, relative || "index.html"));
      return file.exists().then((found) => new Response(found ? file : Bun.file(resolve(webDir, "index.html"))));
    }
    return app.fetch(req, instance);
  },
  websocket: {
    idleTimeout: 960, sendPong: true,
    open(ws) {
      if (ws.data.type === "chat") chatWebSocket.open(ws as never);
      else if (ws.data.type === "global") globalWebSocket.open(ws);
    },
    message(ws, message) {
      if (ws.data.type === "chat") chatWebSocket.message(ws as never, message as string);
      else if (ws.data.type === "global") globalWebSocket.message(ws, message as string);
      else ws.send("pong");
    },
    close(ws) {
      if (ws.data.type === "chat") chatWebSocket.close(ws as never);
      else if (ws.data.type === "global") globalWebSocket.close(ws);
    },
  },
});
function shutdown() { server.stop(true); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Session-changes fixture ready at http://127.0.0.1:${server.port}; scripted provider only.`);
