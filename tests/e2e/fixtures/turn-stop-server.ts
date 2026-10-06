/** Served-production fixture for the turn-stop bar. Adapted from chat-reply-server.
 * Requires an isolated home/config and serves the scratch Vite bundle in PPM_TURN_STOP_WEB_DIR.
 * The only provider is a scripted mock: a message ends the way a real Max Turns stop does
 * (tool use, `error`, `done` error_max_turns), and "Continue from where you left off." finishes.
 */
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
type SendOpts = import("../../../src/providers/provider.interface").SendMessageOpts;
type ChatEvent = import("../../../src/providers/provider.interface").ChatEvent;
type ChatMessage = import("../../../src/providers/provider.interface").ChatMessage;

const CONTINUE = "Continue from where you left off.";
const MAX_TURNS = "Agent reached maximum turn limit.\nReached maximum number of turns (500)";
const turns: { sessionId: string; message: string; at: number }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class TurnStopMock extends MockProvider {
  constructor() {
    super();
    this.id = "claude";
    this.name = "Claude";
  }
  /** The history `getMessages` answers with, as Claude's transcript would hold it: no stop in it. */
  private history(sessionId: string): ChatMessage[] {
    const all = (this as unknown as { messageHistory: Map<string, ChatMessage[]> }).messageHistory;
    if (!all.has(sessionId)) all.set(sessionId, []);
    return all.get(sessionId)!;
  }
  override async *sendMessage(sessionId: string, message: string, _opts?: SendOpts): AsyncIterable<ChatEvent> {
    turns.push({ sessionId, message, at: Date.now() });
    const history = this.history(sessionId);
    history.push({ id: crypto.randomUUID(), role: "user", content: message, timestamp: new Date().toISOString() });
    await sleep(150);
    if (message.startsWith(CONTINUE)) {
      yield { type: "text", content: "Resumed and finished." };
      history.push({ id: crypto.randomUUID(), role: "assistant", content: "Resumed and finished.", timestamp: new Date().toISOString() });
      yield { type: "done", sessionId, resultSubtype: "success" } as ChatEvent;
      return;
    }
    yield { type: "text", content: "Working on it." };
    const toolUseId = crypto.randomUUID();
    yield { type: "tool_use", tool: "Bash", input: { command: "ls" }, toolUseId } as ChatEvent;
    await sleep(100);
    yield { type: "tool_result", output: "README.md", toolUseId } as ChatEvent;
    history.push({ id: crypto.randomUUID(), role: "assistant", content: "Working on it.", timestamp: new Date().toISOString() });
    yield { type: "error", message: MAX_TURNS };
    yield { type: "done", sessionId, resultSubtype: "error_max_turns", numTurns: 501 } as ChatEvent;
  }
}

const { providerRegistry } = await import("../../../src/providers/registry");
const claude = new TurnStopMock();
providerRegistry.register(claude as never);
// Keep the imported production provider instances unreachable, including aggregate routes.
providerRegistry.get = ((id: string) => (id === "claude" ? claude : undefined)) as typeof providerRegistry.get;
providerRegistry.list = () => [{ id: claude.id, name: claude.name }];
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = (() => claude) as typeof providerRegistry.getDefault;

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");

/** Account routes that only read the isolated database; the rest would reach a real endpoint. */
function accountRouteAllowed(method: string, path: string): boolean {
  if (method === "GET") return /^\/api\/accounts(?:\/active|\/settings|\/usage|\/[^/]+\/usage)?$/.test(path);
  return method === "POST" && path === "/api/accounts/pick";
}

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname === "/__turn-stop-test/turns") return Response.json({ turns });
    let data: SocketData | undefined;
    if (url.pathname === "/ws/health") data = { type: "health" };
    else if (url.pathname === "/ws/global") data = { type: "global" };
    else if (url.pathname.startsWith("/ws/project/")) {
      const parts = url.pathname.split("/");
      if (parts[4] === "chat") data = { type: "chat", sessionId: parts[5] ?? "", projectName: decodeURIComponent(parts[3] ?? "") };
    }
    if (data) return instance.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
    if (url.pathname.startsWith("/ws/")) return new Response("Socket disabled in fixture", { status: 404 });
    if (/^\/api\/accounts(?:\/|$)/.test(url.pathname) && !accountRouteAllowed(req.method, url.pathname)) {
      return new Response("Disabled in fixture", { status: 403 });
    }
    if (/^\/api\/(?:tunnels?|preview|upgrade|codex-accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname) ||
        /^\/api\/settings\/(?:telegram|clawbot|ppmbot)/.test(url.pathname)) return new Response("Disabled in fixture", { status: 403 });
    if (!url.pathname.startsWith("/api/")) {
      const webDir = process.env.PPM_TURN_STOP_WEB_DIR;
      if (!webDir) throw new Error("PPM_TURN_STOP_WEB_DIR required");
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
console.log(`Turn-stop fixture ready at http://127.0.0.1:${server.port}; scripted provider only.`);
