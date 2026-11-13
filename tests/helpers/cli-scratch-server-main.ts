/**
 * A scratch PPM server for CLI tests, run as its own process: `bun cli-scratch-server-main.ts
 * <profile|-> <token>`, with `PPM_HOME` set to a temp folder by the caller. It opens that folder's
 * database for the profile, signs it in with `token`, serves the CLI's identity check and the
 * routes under test, publishes its endpoint file, and prints `READY <port>`.
 *
 * `GET /api/__scratch/config` answers the server's in-memory config, so a test can tell a change
 * that reached the server from one written to the database behind its back.
 * `GET /api/__scratch/events` answers what the server broadcast on `/ws/global`, recorded by a
 * client registered the way a browser's is.
 * `GET /api/__scratch/connections` answers the saved database connections, config decrypted.
 */
import { Hono } from "hono";
import { assertIsolatedPpmHome } from "./assert-isolated-ppm-home.ts";

assertIsolatedPpmHome();
const profileArg = process.argv[2] ?? "-";
const token = process.argv[3] ?? "scratch-token";

const { setDbProfile, getDbPath } = await import("../../src/services/db.service.ts");
if (profileArg !== "-") setDbProfile(profileArg);
const { configService } = await import("../../src/services/config.service.ts");
configService.load();
configService.set("auth", { enabled: true, token });
configService.save();

const { cliHelloRoutes } = await import("../../src/server/routes/cli-hello.ts");
const { settingsConfigKeyRoutes } = await import("../../src/server/routes/settings-config-key.ts");
const { authMiddleware } = await import("../../src/server/middleware/auth.ts");
const { setServerListenAddress } = await import("../../src/services/server-listen-address.ts");
const { publishServerEndpoint } = await import("../../src/services/server-endpoint-file.ts");
const { serverInstanceId } = await import("../../src/services/server-instance-id.ts");
const { projectRoutes } = await import("../../src/server/routes/projects.ts");
const { globalWebSocket } = await import("../../src/server/ws/global.ts");
const { ok } = await import("../../src/types/api.ts");
const { initAdapters } = await import("../../src/services/database/init-adapters.ts");
const { databaseRoutes } = await import("../../src/server/routes/database.ts");
const { getConnections, decryptConfig } = await import("../../src/services/db.service.ts");
initAdapters();

const events: unknown[] = [];
globalWebSocket.open({ data: { type: "global" }, send: (json: string) => { events.push(JSON.parse(json)); return json.length; } });

const app = new Hono();
app.route("/api/cli", cliHelloRoutes);
app.use("/api/*", authMiddleware);
app.route("/api/settings", settingsConfigKeyRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/db", databaseRoutes);
app.get("/api/__scratch/config", (c) => c.json(ok(configService.getAll())));
// The saved connections as the database holds them, config decrypted: what a test checks a write against.
app.get("/api/__scratch/connections", (c) => c.json(ok(getConnections().map((row) => ({ ...row, connection_config: decryptConfig(row.connection_config) })))));
app.get("/api/__scratch/events", (c) => c.json(ok(events)));

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
setServerListenAddress(server.port, "127.0.0.1");
publishServerEndpoint({ port: server.port, host: "127.0.0.1", dbFile: getDbPath(), version: "scratch", instanceId: serverInstanceId() });
process.on("SIGTERM", () => process.exit(0));
console.log(`READY ${server.port}`);
