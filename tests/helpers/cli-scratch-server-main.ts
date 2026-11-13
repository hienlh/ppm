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
 * `POST /api/__scratch/seed-account` stores a Claude account with a token, never checked upstream.
 * `POST /api/__scratch/seed-extension` records an installed extension without downloading one.
 * The Jira, extensions, language-server and speech routers are the real ones; nothing here installs.
 * The settings, notifications, MCP and accounts routers are mounted behind the same
 * `settings:changed` middleware as the real server.
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
const { settingsRoutes } = await import("../../src/server/routes/settings.ts");
const { settingsProxyRoutes } = await import("../../src/server/routes/settings-proxy.ts");
const { settingsThemesRoutes } = await import("../../src/server/routes/settings-themes.ts");
const { announceSettingsChanges, SETTINGS_BROADCAST_MOUNTS } = await import("../../src/server/routes/settings-broadcast.ts");
const { notificationRoutes } = await import("../../src/server/routes/notifications.ts");
const { mcpRoutes } = await import("../../src/server/routes/mcp.ts");
const { accountsRoutes } = await import("../../src/server/routes/accounts.ts");
const { codexAccountsRoutes } = await import("../../src/server/routes/codex-accounts.ts");
const { insertAccount } = await import("../../src/services/db.service.ts");
const { encrypt } = await import("../../src/lib/account-crypto.ts");
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
for (const mount of SETTINGS_BROADCAST_MOUNTS) app.use(`${mount}/*`, announceSettingsChanges);
app.route("/api/settings/themes", settingsThemesRoutes);
app.route("/api/settings/mcp", mcpRoutes);
app.route("/api/notifications", notificationRoutes);
app.route("/api/accounts", accountsRoutes);
app.route("/api/codex-accounts", codexAccountsRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/settings", settingsConfigKeyRoutes);
app.route("/api/settings", settingsProxyRoutes);
app.route("/api/projects", projectRoutes);
app.route("/api/db", databaseRoutes);
app.route("/api/jira", (await import("../../src/server/routes/jira.ts")).jiraRoutes);
app.route("/api/extensions", (await import("../../src/server/routes/extensions.ts")).extensionRoutes);
app.route("/api/lsp", (await import("../../src/server/routes/lsp.ts")).lspGlobalRoutes);
app.route("/api/speech", (await import("../../src/server/routes/speech.ts")).speechRoutes);
// An installed extension's row, as the extension host records one; nothing is downloaded.
app.post("/api/__scratch/seed-extension", async (c) => {
  const { id } = await c.req.json<{ id: string }>();
  const { insertExtension } = await import("../../src/services/db.service.ts");
  insertExtension({ id, version: "1.0.0", display_name: id, description: null, icon: null, enabled: 1, manifest: JSON.stringify({ id, name: id, version: "1.0.0", main: "index.js" }) });
  return c.json(ok({ id }));
});
app.get("/api/__scratch/config", (c) => c.json(ok(configService.getAll())));
// The saved connections as the database holds them, config decrypted: what a test checks a write against.
app.get("/api/__scratch/connections", (c) => c.json(ok(getConnections().map((row) => ({ ...row, connection_config: decryptConfig(row.connection_config) })))));
app.get("/api/__scratch/events", (c) => c.json(ok(events)));
// A Claude account with a real-looking stored token, inserted without asking Anthropic about it.
app.post("/api/__scratch/seed-account", async (c) => {
  const { id, label, email, token } = await c.req.json<{ id: string; label: string; email: string; token: string }>();
  insertAccount({
    id, label, email, access_token: encrypt(token), refresh_token: encrypt(`${token}-refresh`), expires_at: null,
    status: "active", cooldown_until: null, priority: 0, total_requests: 0, last_used_at: null, profile_json: null,
    granted_at: null, refresh_expires_at: null, reauth_required: 0, last_refresh_attempt_at: null,
  });
  return c.json(ok({ id }));
});

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
setServerListenAddress(server.port, "127.0.0.1");
publishServerEndpoint({ port: server.port, host: "127.0.0.1", dbFile: getDbPath(), version: "scratch", instanceId: serverInstanceId() });
process.on("SIGTERM", () => process.exit(0));
console.log(`READY ${server.port}`);
