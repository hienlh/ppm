/**
 * Served-production fixture for session collaboration. Requires an isolated home and PPM
 * directory, serves the scratch Vite bundle named by PPM_COLLAB_WEB_DIR, and registers scripted
 * Claude and Codex providers (`session-collab-scripted-providers.ts`) whose turns call the real
 * `/api/sessions-mcp` endpoint with the token PPM hands each turn. Notifications go to a fake ntfy
 * server in this process, sent at once (no delay), so the e2e can read which ones were sent. No real
 * SDK or CLI runs, and no real user data is read.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

const canonical = (path: string) => realpathSync(path).replace(/\\/g, "/").toLowerCase();
const ppmHome = process.env.PPM_HOME, sandboxHome = process.env.HOME;
const profile = process.env.USERPROFILE, realHomePath = process.env.PPM_HTML_TEST_REAL_HOME;
if (!ppmHome || !sandboxHome || !profile || !realHomePath) throw new Error("Fixture requires isolated PPM_HOME, HOME, USERPROFILE and the parent's real home.");
const realHome = canonical(realHomePath), privateHome = canonical(sandboxHome), privatePpm = canonical(ppmHome);
if (privateHome === realHome || canonical(profile) !== privateHome || privatePpm === realHome ||
    privatePpm === `${realHome}/.ppm` || privatePpm.startsWith(`${realHome}/.ppm/`) || canonical(homedir()) !== privateHome) {
  throw new Error("Refusing the production home or PPM directory");
}
if (existsSync(resolve(ppmHome, "ppm.db"))) throw new Error("Fixture requires an empty PPM_HOME");
if (process.argv.includes("__serve__") || process.env.PPM_ALLOW_PROD_DB) throw new Error("Production flags are forbidden");
const port = Number(process.env.PPM_HTML_TEST_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3211, 3212, 8080, 8081].includes(port)) throw new Error("Invalid fixture port");
const projectsDir = process.env.PPM_COLLAB_PROJECTS;
if (!projectsDir || !existsSync(projectsDir)) throw new Error("PPM_COLLAB_PROJECTS required");
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");

const alpha = join(projectsDir, "alpha");
const claudeProjects = join(sandboxHome, ".claude", "projects"), codexSessions = join(sandboxHome, ".codex", "sessions");
for (const dir of [alpha, claudeProjects, codexSessions]) mkdirSync(dir, { recursive: true });

const { startFakeNtfy, WRITER_TOKEN } = await import("../../helpers/fake-ntfy-server");
const ntfy = startFakeNtfy();

// Import services only after validating environment isolation.
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("port", port);
configService.set("ai", {
  default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false,
  providers: { claude: { type: "agent-sdk", permission_mode: "bypassPermissions" }, codex: { type: "cli", permission_mode: "bypassPermissions" } },
} as never);
// The session tools are off until the tour's question is answered; these flows start from "Turn on".
const { answerFeatureIntro } = await import("../../../src/services/feature-intros.service");
const { FEATURE_INTROS } = await import("../../../src/shared/feature-intros");
answerFeatureIntro(FEATURE_INTROS[0]!.id, "on");
configService.set("notifications", { delay_seconds: 0 } as never);
configService.set("ntfy", { server: ntfy.url, topic: "ppm-collab-e2e", token: WRITER_TOKEN } as never);

const { _setClaudeProjectsRoot } = await import("../../../src/services/agent-transcript/claude-projects-root");
_setClaudeProjectsRoot(claudeProjects);

const providers = await import("./session-collab-scripted-providers");
const { providerRegistry } = await import("../../../src/providers/registry");
const claude = new providers.ScriptedClaude(claudeProjects);
const codex = new providers.ScriptedCodex(codexSessions);
providerRegistry.register(claude as never);
providerRegistry.register(codex as never);
const visible = [claude, codex];
providerRegistry.get = ((id: string) => visible.find((p) => p.id === id)) as typeof providerRegistry.get;
providerRegistry.list = () => visible.map((p) => ({ id: p.id, name: p.name }));
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = (() => claude) as typeof providerRegistry.getDefault;

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");
const { setServerListenAddress } = await import("../../../src/services/server-listen-address");
const { testRoute } = await import("./session-collab-test-routes");

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__collab-test/")) return testRoute(req, url, { alpha, ntfyPublished: () => ntfy.published });
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
      const webDir = process.env.PPM_COLLAB_WEB_DIR;
      if (!webDir) throw new Error("PPM_COLLAB_WEB_DIR required");
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (relative.includes("..")) return new Response("Invalid path", { status: 400 });
      const file = Bun.file(resolve(webDir, relative || "index.html"));
      return file.exists().then((found) => new Response(found ? file : Bun.file(resolve(webDir, "index.html"))));
    }
    // Passing the server lets a route lift Bun's 10 s idle timeout, as the session tools' wait does.
    return app.fetch(req, instance);
  },
  websocket: {
    idleTimeout: 960,
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
// What `src/server/index.ts` records once it listens: the MCP endpoints' URLs are built from it.
setServerListenAddress(server.port ?? port, "127.0.0.1");
function shutdown() {
  server.stop(true);
  ntfy.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Session-collab fixture ready at http://127.0.0.1:${server.port}; scripted providers only.`);
