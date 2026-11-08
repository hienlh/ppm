/**
 * A scratch PPM server for a live walkthrough with the REAL Claude provider (no scripted turns).
 *
 * Isolation: PPM_HOME must name an empty directory that is not the real `~/.ppm`, so PPM's own
 * database, logs and settings are throwaway. HOME is left alone on purpose: the Claude CLI signs
 * in with the user's existing login under `~/.claude`, and its transcripts for the scratch project
 * land in `~/.claude/projects/<scratch-project-slug>/`. Nothing here writes Claude's settings.
 *
 * Env:
 *   PPM_HOME            empty scratch directory (required)
 *   PPM_LIVE_PORT       port to listen on, 127.0.0.1 only (required; 3211/3212/8080/8081 refused)
 *   PPM_LIVE_WEB_DIR    built web bundle to serve (default: <repo>/dist/web)
 *   PPM_LIVE_MODEL      Claude model (default claude-sonnet-5)
 *   PPM_LIVE_EFFORT     Claude effort (default low)
 *
 * Run: PPM_HOME=<tmp> PPM_LIVE_PORT=<port> bun tests/e2e/demo/live-claude-server.ts
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const canonical = (path: string) => realpathSync(path).replace(/\\/g, "/").toLowerCase();
const ppmHome = process.env.PPM_HOME;
if (!ppmHome || !existsSync(ppmHome)) throw new Error("PPM_HOME must name an existing scratch directory");
const realPpm = `${canonical(homedir())}/.ppm`;
const scratch = canonical(ppmHome);
if (scratch === realPpm || scratch.startsWith(`${realPpm}/`) || scratch === canonical(homedir())) {
  throw new Error("Refusing the real PPM directory");
}
if (existsSync(resolve(ppmHome, "ppm.db"))) throw new Error("PPM_HOME must be empty (no ppm.db)");
if (process.argv.includes("__serve__") || process.env.PPM_ALLOW_PROD_DB) throw new Error("Production flags are forbidden");
const port = Number(process.env.PPM_LIVE_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3211, 3212, 3214, 8080, 8081, 8082].includes(port)) {
  throw new Error("PPM_LIVE_PORT must be a free port that is not one of PPM's own");
}
const webDir = resolve(process.env.PPM_LIVE_WEB_DIR ?? resolve(import.meta.dir, "../../../dist/web"));
if (!existsSync(resolve(webDir, "index.html"))) throw new Error(`No web bundle in ${webDir} (run bun run build:web)`);
// The CLI must use the subscription login, never a key a parent shell happens to export.
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];

// Services only after the isolation checks above.
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("port", port);
configService.set("tunnel", { ...configService.get("tunnel"), enabled: false } as never);
configService.set("ai", {
  ...configService.get("ai"),
  default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false,
  providers: {
    claude: {
      type: "agent-sdk", model: process.env.PPM_LIVE_MODEL ?? "claude-sonnet-5",
      effort: (process.env.PPM_LIVE_EFFORT ?? "low") as never, max_turns: 40,
      permission_mode: "bypassPermissions", inherit_claude_mcp: false,
    },
  },
} as never);
// The session tools are off until the tour's question is answered; the walkthrough starts from "Turn on".
const { answerFeatureIntro } = await import("../../../src/services/feature-intros.service");
const { FEATURE_INTROS } = await import("../../../src/shared/feature-intros");
answerFeatureIntro(FEATURE_INTROS[0]!.id, "on");

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");
const { setServerListenAddress } = await import("../../../src/services/server-listen-address");

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    let data: SocketData | undefined;
    if (url.pathname === "/ws/health") data = { type: "health" };
    else if (url.pathname === "/ws/global") data = { type: "global" };
    else if (url.pathname.startsWith("/ws/project/")) {
      const parts = url.pathname.split("/");
      if (parts[4] === "chat") data = { type: "chat", sessionId: parts[5] ?? "", projectName: decodeURIComponent(parts[3] ?? "") };
    }
    if (data) return instance.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
    if (url.pathname.startsWith("/ws/")) return new Response("Socket disabled in the live demo server", { status: 404 });
    if (/^\/api\/(?:tunnels?|upgrade|remote-desktop)(?:\/|$)/.test(url.pathname)) return new Response("Disabled in the live demo server", { status: 403 });
    if (!url.pathname.startsWith("/api/")) {
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (relative.includes("..")) return new Response("Invalid path", { status: 400 });
      const file = Bun.file(resolve(webDir, relative || "index.html"));
      return file.exists().then((found) => new Response(found ? file : Bun.file(resolve(webDir, "index.html"))));
    }
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
// The MCP endpoints' URLs (ppm-sessions, turn refs) are built from this.
setServerListenAddress(server.port ?? port, "127.0.0.1");
function shutdown() {
  server.stop(true);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Live demo server ready at http://127.0.0.1:${server.port} (pid ${process.pid}); PPM_HOME=${ppmHome}; real Claude.`);
