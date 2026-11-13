/**
 * A scratch PPM server for the `ppm design`, `ppm logs issues` and `ppm schedule` CLI tests, run
 * as its own process like `cli-scratch-server-main.ts` (same arguments, same `READY <port>`).
 *
 * It registers one project, `demo`, in `$PPM_HOME-project`, and mounts the real routers
 * those commands call: the project-scoped router (designs), `/api/schedules` and `/api/logs`.
 * The scheduler is never started, so nothing a test saves ever runs. Test-only routes:
 * `GET /api/__scratch/events` (what went out on `/ws/global`) and `GET /api/__scratch/schedules`
 * (the rows as the database holds them).
 */
import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertIsolatedPpmHome } from "./assert-isolated-ppm-home.ts";

assertIsolatedPpmHome();
const token = process.argv[3] ?? "scratch-token";
// Nothing below may reach the real Claude or Codex folders.
process.env.CLAUDE_CONFIG_DIR = join(process.env.PPM_HOME!, ".claude");
process.env.CODEX_HOME = join(process.env.PPM_HOME!, ".codex");

// Beside the PPM folder, not in it: PPM refuses file work inside its own folder.
const projectDir = `${process.env.PPM_HOME!}-project`;
mkdirSync(projectDir, { recursive: true });

const db = await import("../../src/services/db.service.ts");
const { configService } = await import("../../src/services/config.service.ts");
configService.load();
configService.set("auth", { enabled: true, token });
configService.set("projects", [{ name: "demo", path: projectDir }]);
configService.save();

const { cliHelloRoutes } = await import("../../src/server/routes/cli-hello.ts");
const { authMiddleware } = await import("../../src/server/middleware/auth.ts");
const { setServerListenAddress } = await import("../../src/services/server-listen-address.ts");
const { publishServerEndpoint } = await import("../../src/services/server-endpoint-file.ts");
const { serverInstanceId } = await import("../../src/services/server-instance-id.ts");
const { projectScopedRouter } = await import("../../src/server/routes/project-scoped.ts");
const { schedulesRoutes } = await import("../../src/server/routes/schedules.ts");
const { logsRoutes } = await import("../../src/server/routes/logs.ts");
const { getSchedules } = await import("../../src/services/scheduler-db.service.ts");
const { globalWebSocket } = await import("../../src/server/ws/global.ts");
const { ok } = await import("../../src/types/api.ts");

const events: unknown[] = [];
globalWebSocket.open({ data: { type: "global" }, send: (json: string) => { events.push(JSON.parse(json)); return json.length; } } as never);

const app = new Hono();
app.route("/api/cli", cliHelloRoutes);
app.use("/api/*", authMiddleware);
app.route("/api/project/:projectName", projectScopedRouter);
app.route("/api/schedules", schedulesRoutes);
app.route("/api/logs", logsRoutes);
app.get("/api/__scratch/events", (c) => c.json(ok(events)));
app.get("/api/__scratch/schedules", (c) => c.json(ok(getSchedules(false))));

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
setServerListenAddress(server.port, "127.0.0.1");
publishServerEndpoint({ port: server.port, host: "127.0.0.1", dbFile: db.getDbPath(), version: "scratch", instanceId: serverInstanceId() });
process.on("SIGTERM", () => process.exit(0));
console.log(`READY ${server.port}`);
