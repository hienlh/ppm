/**
 * A scratch PPM server for the `ppm group-chat`, `ppm teams`, `ppm cloud` and `ppm forward` CLI
 * tests, run as its own process like `cli-scratch-server-main.ts` (same arguments, same
 * `READY <port>`).
 *
 * It registers one project, `demo`, in `$PPM_HOME-project`, and mounts the real group chat, teams
 * and cloud routers. Group chats never spawn an agent (the service's spawn stub), the teams router
 * reads the `HOME` the test gives this process, and PPM Cloud is whatever `cloud_url` the test
 * writes into the scratch `cloud-auth.json`.
 *
 * `/api/tunnels` is a stand-in with the real route's shape: the machine-wide list is fixed (one
 * forward this server started, one other program's cloudflared, the protected app tunnel, one
 * Tailscale forward), and nothing is spawned or killed — every call is recorded instead, at
 * `GET /api/__scratch/tunnel-calls`.
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
process.env.CLAUDE_PROJECTS_DIR = join(process.env.PPM_HOME!, ".claude", "projects");

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
const { groupChatRoutes } = await import("../../src/server/routes/group-chat.ts");
const { groupChatService } = await import("../../src/services/group-chat/group-chat.service.ts");
const { teamRoutes } = await import("../../src/server/routes/teams.ts");
const { cloudRoutes } = await import("../../src/server/routes/cloud.ts");
const { ok, err } = await import("../../src/types/api.ts");

groupChatService._setSpawnStub(true);

type Row = { pid: number; port: number; url: string; source: "ppm" | "app" | "external"; protected: boolean; status: string; startedAt: string; via?: "tailscale" };
const at = new Date().toISOString();
const tunnels: Row[] = [
  { pid: 41001, port: 3000, url: "https://own.trycloudflare.com", source: "ppm", protected: false, status: "running", startedAt: at },
  { pid: 41002, port: 4000, url: "https://foreign.trycloudflare.com", source: "external", protected: false, status: "running", startedAt: at },
  { pid: 41003, port: 8080, url: "https://app.trycloudflare.com", source: "app", protected: true, status: "running", startedAt: at },
  { pid: 41004, port: 5000, url: "https://host.example.ts.net:5000", source: "ppm", protected: false, status: "running", startedAt: at, via: "tailscale" },
];
const tunnelCalls: Array<{ method: string; path: string; body?: unknown }> = [];
let nextPid = 42000;

const standInTunnels = new Hono();
standInTunnels.get("/", (c) => {
  tunnelCalls.push({ method: "GET", path: c.req.url.replace(/^.*\/api\/tunnels/, "") });
  return c.json(ok(c.req.query("detail") === "1" ? { tunnels, scanFailed: false } : tunnels));
});
standInTunnels.post("/", async (c) => {
  const body = await c.req.json<{ port: number; via?: string }>();
  tunnelCalls.push({ method: "POST", path: "/", body });
  const via = body.via === "tailscale" ? "tailscale" as const : undefined;
  const url = `https://forward-${body.port}.example.test`;
  tunnels.push({ pid: nextPid++, port: body.port, url, source: "ppm", protected: false, status: "running", startedAt: at, ...(via && { via }) });
  return c.json(ok({ port: body.port, url, via: body.via ?? "cloudflare" }));
});
standInTunnels.delete("/:pid{[0-9]+}", (c) => {
  const pid = Number(c.req.param("pid"));
  tunnelCalls.push({ method: "DELETE", path: `/${pid}` });
  const i = tunnels.findIndex((t) => t.pid === pid);
  if (i < 0) return c.json(err("No tunnel found for this PID"), 404);
  tunnels.splice(i, 1);
  return c.json(ok({ pid }));
});

const app = new Hono();
app.route("/api/cli", cliHelloRoutes);
app.use("/api/*", authMiddleware);
app.route("/api/group-chat", groupChatRoutes);
app.route("/api/teams", teamRoutes);
app.route("/api/cloud", cloudRoutes);
app.route("/api/tunnels", standInTunnels);
app.get("/api/__scratch/tunnel-calls", (c) => c.json(ok(tunnelCalls)));
app.get("/api/__scratch/events", (c) => c.json(ok([])));

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
setServerListenAddress(server.port, "127.0.0.1");
publishServerEndpoint({ port: server.port, host: "127.0.0.1", dbFile: db.getDbPath(), version: "scratch", instanceId: serverInstanceId() });
process.on("SIGTERM", () => process.exit(0));
console.log(`READY ${server.port}`);
