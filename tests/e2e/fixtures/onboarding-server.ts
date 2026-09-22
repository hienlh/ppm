/** Isolated real-route server for onboarding Playwright captures. Never use __serve__. */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ChatEvent, ChatMessage } from "../../../src/providers/provider.interface";

const canonical = (path: string) => realpathSync(path).replace(/\\/g, "/").toLowerCase();
const ppmHome = process.env.PPM_HOME;
const sandboxHome = process.env.HOME;
const profile = process.env.USERPROFILE;
if (!ppmHome || !sandboxHome || !profile || !process.env.PPM_ONBOARDING_REAL_HOME) throw new Error("Fixture requires explicit isolated PPM_HOME, HOME, USERPROFILE and the parent's real home.");
// Bun on Windows derives userInfo().homedir from the overridden environment.
const realHome = canonical(process.env.PPM_ONBOARDING_REAL_HOME);
const privateHome = canonical(sandboxHome);
const privatePpm = canonical(ppmHome);
if (privateHome === realHome || canonical(profile) !== privateHome || privatePpm === realHome ||
    privatePpm === `${realHome}/.ppm` || privatePpm.startsWith(`${realHome}/.ppm/`)) {
  throw new Error("Refusing production home or PPM directory. Use newly created sandbox directories.");
}
if (existsSync(resolve(ppmHome, "ppm.db"))) throw new Error("Fixture requires an empty PPM_HOME without an existing ppm.db.");
if (process.argv.includes("__serve__") || process.env.PPM_ALLOW_PROD_DB) throw new Error("Production flags are forbidden in this fixture.");
const port = Number(process.env.PPM_ONBOARDING_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Set a dedicated PPM_ONBOARDING_PORT between 1024 and 65535.");
// No provider credentials or shared native provider memories enter this fixture.
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");
process.env.SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/bash";

// Dynamic imports are essential: the isolation guard runs before any service can open a DB.
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("device_name", "PPM Tour Sandbox");
configService.set("host", "127.0.0.1");
configService.set("port", port);
configService.set("ai", { default_provider: "tour-test", new_chat_provider_mode: "default", share_provider_context: false,
  providers: { "tour-test": { type: "mock" } } });

const { MockProvider } = await import("../../../src/providers/mock-provider");
const { providerRegistry } = await import("../../../src/providers/registry");
class TourTestProvider extends MockProvider {
  override id = "tour-test";
  override name = "Tour test AI";
  private answers = new Map<string, ChatMessage[]>();
  private canceled = new Set<string>();
  override async *sendMessage(sessionId: string, message: string): AsyncIterable<ChatEvent> {
    await this.resumeSession(sessionId);
    this.canceled.delete(sessionId);
    const history = this.answers.get(sessionId) ?? [];
    history.push({ id: crypto.randomUUID(), role: "user", content: message, timestamp: new Date().toISOString() });
    const answer = "This is a deterministic test response from Tour test AI. Your sandbox project is ready to explore. Open README.md to find its documented run instructions. No real AI service was contacted and no files were changed.";
    for (const word of answer.split(" ")) {
      if (this.canceled.has(sessionId)) return;
      yield { type: "text", content: `${word} ` };
      await Bun.sleep(35);
    }
    history.push({ id: crypto.randomUUID(), role: "assistant", content: answer, timestamp: new Date().toISOString() });
    this.answers.set(sessionId, history);
    yield { type: "done", sessionId };
  }
  override abortQuery(sessionId: string) { this.canceled.add(sessionId); }
  override async getMessages(sessionId: string) { return this.answers.get(sessionId) ?? []; }
}
const provider = new TourTestProvider();
providerRegistry.register(provider);
// Keep imported production provider instances unreachable, including aggregate history routes.
providerRegistry.get = (id) => id === provider.id ? provider : undefined;
providerRegistry.list = () => [{ id: provider.id, name: provider.name }];
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = () => provider;

const { app } = await import("../../../src/server/index");
const { terminalWebSocket } = await import("../../../src/server/ws/terminal");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");
const { terminalService } = await import("../../../src/services/terminal.service");
type SocketData = { type: "health" | "global" | "terminal" | "chat"; id?: string; projectName?: string; cwd?: string; sessionId?: string };

const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname === "/__tour-test/shutdown" && req.method === "POST") {
      setTimeout(shutdown, 50);
      return new Response("Sandbox stopping");
    }
    let data: SocketData | undefined;
    if (url.pathname === "/ws/health") data = { type: "health" };
    else if (url.pathname === "/ws/global") data = { type: "global" };
    else if (url.pathname.startsWith("/ws/project/")) {
      const parts = url.pathname.split("/");
      const projectName = decodeURIComponent(parts[3] ?? "");
      const id = parts[5] ?? "";
      if (parts[4] === "terminal") data = { type: "terminal", id, projectName, cwd: url.searchParams.get("cwd") ?? undefined };
      if (parts[4] === "chat") data = { type: "chat", sessionId: id, projectName };
    }
    if (data) return instance.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
    if (url.pathname.startsWith("/ws/")) return new Response("Socket disabled in sandbox", { status: 404 });
    // These operations have no role in tour verification and could start external integrations.
    if (/^\/api\/(?:tunnels?|preview|upgrade|accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname) ||
        /^\/api\/settings\/(?:telegram|clawbot|ppmbot)/.test(url.pathname)) return new Response("Disabled in sandbox", { status: 403 });
    return app.fetch(req, instance);
  },
  websocket: {
    idleTimeout: 960, sendPong: true,
    open(ws) {
      if (ws.data.type === "chat") chatWebSocket.open(ws as never);
      else if (ws.data.type === "terminal") terminalWebSocket.open(ws as never);
      else if (ws.data.type === "global") globalWebSocket.open(ws);
    },
    message(ws, message) {
      if (ws.data.type === "chat") chatWebSocket.message(ws as never, message as string);
      else if (ws.data.type === "terminal") terminalWebSocket.message(ws as never, message as string);
      else if (ws.data.type === "global") globalWebSocket.message(ws, message as string);
      else if (ws.data.type === "health") ws.send("pong");
    },
    close(ws) {
      if (ws.data.type === "chat") chatWebSocket.close(ws as never);
      else if (ws.data.type === "terminal") terminalWebSocket.close(ws as never);
      else if (ws.data.type === "global") globalWebSocket.close(ws);
    },
  },
});
function shutdown() {
  server.stop(true);
  for (const session of terminalService.list()) terminalService.kill(session.id);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`PPM tour sandbox ready at http://127.0.0.1:${server.port}; empty projects; deterministic test AI only.`);
