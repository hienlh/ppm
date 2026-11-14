/**
 * Served-production fixture for session schedules. Requires an isolated home and PPM directory,
 * serves the scratch Vite bundle named by PPM_SCHED_WEB_DIR, and registers the scripted Claude
 * provider of the session-collaboration e2e, whose turns call the real `/api/sessions-mcp`
 * endpoint (and so the real `session_schedule_*` tools) with the token PPM hands each turn.
 *
 * It starts session-schedule delivery and the scheduler the way `src/server/index.ts` does, so a
 * schedule that comes due goes through the real timer, deliverer and chat door. Started again with
 * PPM_SCHED_RESUME=1 on the same PPM_HOME it is a restart of the same install; PPM_SCHED_BACKDATE
 * (`<schedule id>=<ISO time>`) moves a schedule's next fire into the past before the scheduler
 * starts, which is what a fire that came due while PPM was off looks like. No real SDK or CLI runs.
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
const resuming = process.env.PPM_SCHED_RESUME === "1";
if (!resuming && existsSync(resolve(ppmHome, "ppm.db"))) throw new Error("Fixture requires an empty PPM_HOME on its first start");
if (process.argv.includes("__serve__") || process.env.PPM_ALLOW_PROD_DB) throw new Error("Production flags are forbidden");
const port = Number(process.env.PPM_HTML_TEST_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3211, 3212, 8080, 8081].includes(port)) throw new Error("Invalid fixture port");
const projectsDir = process.env.PPM_SCHED_PROJECTS;
if (!projectsDir || !existsSync(projectsDir)) throw new Error("PPM_SCHED_PROJECTS required");
const webDir = process.env.PPM_SCHED_WEB_DIR;
if (!webDir) throw new Error("PPM_SCHED_WEB_DIR required");
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");

const alpha = join(projectsDir, "alpha");
const claudeProjects = join(sandboxHome, ".claude", "projects");
for (const dir of [alpha, claudeProjects]) mkdirSync(dir, { recursive: true });

// Import services only after validating environment isolation.
const { configService } = await import("../../../src/services/config.service");
configService.load();
if (!resuming) {
  configService.set("auth", { ...configService.get("auth"), enabled: false });
  configService.set("host", "127.0.0.1");
  configService.set("port", port);
  configService.set("ai", {
    default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false,
    providers: { claude: { type: "agent-sdk", permission_mode: "bypassPermissions" } },
  } as never);
  // The schedule tools are an introduced feature, off until answered: these flows start from "Turn on".
  const { answerFeatureIntrosAtStartup } = await import("./answer-feature-intros");
  await answerFeatureIntrosAtStartup("on");
  configService.set("notifications", { delay_seconds: 0 } as never);
} else {
  configService.set("port", port);
}

const { _setClaudeProjectsRoot } = await import("../../../src/services/agent-transcript/claude-projects-root");
_setClaudeProjectsRoot(claudeProjects);

const { ScriptedClaude } = await import("./session-collab-scripted-providers");
const { providerRegistry } = await import("../../../src/providers/registry");
const claude = new ScriptedClaude(claudeProjects);
providerRegistry.register(claude as never);
providerRegistry.get = ((id: string) => (id === claude.id ? claude : undefined)) as typeof providerRegistry.get;
providerRegistry.list = () => [{ id: claude.id, name: claude.name }];
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = (() => claude) as typeof providerRegistry.getDefault;

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");
const { setServerListenAddress } = await import("../../../src/services/server-listen-address");
const { testRoute } = await import("./session-schedules-test-routes");

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__sched-test/")) return testRoute(req, url, { alpha });
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
// What `src/server/index.ts` records once it listens: the MCP endpoints' URLs are built from it.
setServerListenAddress(server.port ?? port, "127.0.0.1");

// A fire that came due while this install was off: moved into the past before the scheduler looks.
const backdate = process.env.PPM_SCHED_BACKDATE;
if (backdate) {
  const [id, at] = backdate.split("=");
  const { updateSchedule } = await import("../../../src/services/scheduler-db.service");
  updateSchedule(Number(id), { next_fire_at: at! });
}

// The same order as the real server: delivery first, so fires still pending at start have a taker.
const { startSessionScheduleDelivery } = await import("../../../src/services/session-schedules/session-schedule-delivery");
const stopDelivery = await startSessionScheduleDelivery();
const { schedulerService } = await import("../../../src/services/scheduler.service");
schedulerService.start();

function shutdown() {
  schedulerService.stop();
  stopDelivery();
  server.stop(true);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Session-schedules fixture ready at http://127.0.0.1:${server.port}${resuming ? " (restarted)" : ""}; scripted provider only.`);
