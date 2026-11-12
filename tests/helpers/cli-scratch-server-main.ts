/**
 * A scratch PPM server for CLI tests, run as its own process: `bun cli-scratch-server-main.ts
 * <profile|-> <token>`, with `PPM_HOME` set to a temp folder by the caller. It opens that folder's
 * database for the profile, signs it in with `token`, serves the CLI's identity check and the
 * routes under test, publishes its endpoint file, and prints `READY <port>`.
 *
 * `GET /api/__scratch/config` answers the server's in-memory config, so a test can tell a change
 * that reached the server from one written to the database behind its back.
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
const { ok } = await import("../../src/types/api.ts");

const app = new Hono();
app.route("/api/cli", cliHelloRoutes);
app.use("/api/*", authMiddleware);
app.route("/api/settings", settingsConfigKeyRoutes);
app.get("/api/__scratch/config", (c) => c.json(ok(configService.getAll())));

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
setServerListenAddress(server.port, "127.0.0.1");
publishServerEndpoint({ port: server.port, host: "127.0.0.1", dbFile: getDbPath(), version: "scratch", instanceId: serverInstanceId() });
process.on("SIGTERM", () => process.exit(0));
console.log(`READY ${server.port}`);
