/**
 * Served-production fixture for the Schedules window (`tests/e2e/schedules-rail-e2e.mjs`). Requires
 * an isolated home and PPM directory, serves the scratch Vite bundle named by PPM_RAIL_WEB_DIR, and
 * seeds two projects (alpha, beta) with tasks, manager chats and one schedule of each shape the
 * window shows: a failed prompt in Bypass, a chat reminder waiting for its chat, a one-shot task
 * reminder kept in UK time, an Edits-mode digest that ran fine, a weekly one and one turned off.
 *
 * Neither the scheduler nor any provider runs: nothing fires by itself, and Run now records a run
 * row (`/__rail-test/runs-now` lists them) instead of starting a turn.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
const projectsDir = process.env.PPM_RAIL_PROJECTS, webDir = process.env.PPM_RAIL_WEB_DIR;
if (!projectsDir || !existsSync(projectsDir) || !webDir) throw new Error("PPM_RAIL_PROJECTS and PPM_RAIL_WEB_DIR required");
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");

const alpha = join(projectsDir, "alpha"), beta = join(projectsDir, "beta");
for (const dir of [alpha, beta]) mkdirSync(dir, { recursive: true });

// Services only after the isolation checks above.
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("port", port);
configService.set("projects", [{ name: "alpha", path: alpha }, { name: "beta", path: beta }] as never);
configService.set("ai", {
  default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false,
  providers: { claude: { type: "agent-sdk", permission_mode: "bypassPermissions" } },
} as never);
const { answerFeatureIntrosAtStartup } = await import("./answer-feature-intros");
await answerFeatureIntrosAtStartup("on");

const { seedSchedulesRail } = await import("./schedules-rail-seed");
const seeded = seedSchedulesRail({ alpha, beta });

// Run now records a run instead of starting a turn: no provider is reachable here.
const { schedulerService } = await import("../../../src/services/scheduler.service");
const { insertScheduleRun, updateScheduleRun } = await import("../../../src/services/scheduler-db.service");
const runsNow: number[] = [];
schedulerService.runJobNow = ((id: number) => {
  runsNow.push(id);
  const runId = insertScheduleRun(id, null, "done");
  updateScheduleRun(runId, { ended_at: new Date().toISOString() });
  return { runId, wasRunning: false };
}) as typeof schedulerService.runJobNow;
schedulerService.rearm = () => {};

const { app } = await import("../../../src/server/index");
const { globalWebSocket } = await import("../../../src/server/ws/global");
const { startTaskReminderCleanup } = await import("../../../src/services/task-reminders/task-reminder-cleanup");
startTaskReminderCleanup();

type SocketData = { type: "health" | "global" };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname === "/__rail-test/seeded") return Response.json(seeded);
    if (url.pathname === "/__rail-test/runs-now") return Response.json(runsNow);
    let data: SocketData | undefined;
    if (url.pathname === "/ws/health") data = { type: "health" };
    else if (url.pathname === "/ws/global") data = { type: "global" };
    if (data) return instance.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
    if (url.pathname.startsWith("/ws/")) return new Response("Socket disabled in fixture", { status: 404 });
    if (/^\/api\/(?:accounts|tunnels?|preview|upgrade|codex-accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname)) {
      return new Response("Disabled in fixture", { status: 403 });
    }
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
    open(ws) { if (ws.data.type === "global") globalWebSocket.open(ws); },
    message(ws, message) {
      if (ws.data.type === "global") globalWebSocket.message(ws, message as string);
      else ws.send("pong");
    },
    close(ws) { if (ws.data.type === "global") globalWebSocket.close(ws); },
  },
});

const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
console.log(`schedules-rail fixture listening on ${server.port}`);
