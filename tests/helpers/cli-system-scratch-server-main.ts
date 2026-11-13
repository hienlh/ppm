/**
 * A scratch PPM for the `ppm system` tests: `bun cli-system-scratch-server-main.ts <profile|-> <token>`.
 * It mounts the REAL Task Manager and Services routes (`createResourceRoutes`,
 * `createSystemServiceRoutes`) with the real metrics service and its real kill/signal chain, over
 * a stand-in process table and a stand-in service manager. Nothing here can reach a real process
 * or service: the executors only record what they were asked to do.
 *
 *   GET  /api/__scratch/streams           metrics stream sessions still subscribed
 *   GET  /api/__scratch/kills             kills and signals the executors were asked for
 *   GET  /api/__scratch/service-actions   service actions the stand-in manager ran
 *   POST /api/__scratch/register-provider {pid} — that stand-in pid is a chat's provider process
 */
import { Hono } from "hono";
import { assertIsolatedPpmHome } from "./assert-isolated-ppm-home.ts";
import type { ServiceDetails, ServiceInfo } from "../../src/types/system-services.ts";

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
const { authMiddleware } = await import("../../src/server/middleware/auth.ts");
const { setServerListenAddress } = await import("../../src/services/server-listen-address.ts");
const { publishServerEndpoint } = await import("../../src/services/server-endpoint-file.ts");
const { serverInstanceId } = await import("../../src/services/server-instance-id.ts");
const { ok } = await import("../../src/types/api.ts");
const { createResourceRoutes } = await import("../../src/server/routes/resources.ts");
const { createSystemServiceRoutes } = await import("../../src/server/routes/system-services.ts");
const { SystemMetricsService } = await import("../../src/services/system-metrics/system-metrics.service.ts");
const { registerChatProviderPid } = await import("../../src/services/system-metrics/chat-provider-pids.ts");
const { ServiceActionRefused } = await import("../../src/services/system-services/systemd-collector.ts");

// The stand-in table. "busy" gains CPU time every tick, so a CPU sort has something to measure.
const STARTED = 1_700_000_000_000;
let busyCpuMs = 0;
const rows = () => {
  busyCpuMs += 400;
  return [
    { pid: 4100, ppid: 1, name: "bun", command: "bun ppm-server", cpuMs: 0, ramMB: 50, startedAt: STARTED + 100 },
    { pid: 4242, ppid: 1, name: "node", command: "node stand-in-server.js --port 3000", cpuMs: 0, ramMB: 300, startedAt: STARTED + 242 },
    { pid: 4343, ppid: 1, name: "busy", command: "busy --loop", cpuMs: busyCpuMs, ramMB: 20, startedAt: STARTED + 343 },
    { pid: 4444, ppid: 1, name: "claude", command: "claude --output-format stream-json", cpuMs: 0, ramMB: 120, startedAt: STARTED + 444 },
  ];
};

const kills: unknown[] = [];
const service = new SystemMetricsService({
  collectors: {
    platform: "linux",
    processes: { collect: async () => ({ rows: rows(), warnings: [] }), stop: () => {} },
    diskNet: async () => ({ disk: null, net: null, warnings: [] }),
    gpus: { collect: async () => [], isDisabled: () => false },
    devices: null,
    apps: null,
  },
  intervals: { full: 300, light: 300 },
  idleTeardownMs: 100,
  resolveProtected: () => ({ pids: new Set([4100]), roots: new Set([4100]), selfPid: 4100 }),
  execute: async (pid, tree) => { kills.push({ kind: "kill", pid, tree }); return { pid, tree, method: "signal", killed: [pid] }; },
  executeSignal: async (pid, signal, tree) => {
    kills.push({ kind: "signal", pid, signal, tree });
    return { pid, signal, tree, method: "signal", signalled: [pid] };
  },
  details: (pid) => (pid === 4242 ? {
    pid, ppid: 1, name: "node", startedAt: STARTED + 242, command: "node stand-in-server.js --port 3000",
    exe: "/usr/bin/node", cwd: "/srv/app", user: "dev", state: "S (sleeping)", threads: 7, nice: 0, cgroup: null,
  } : null),
  log: { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, isEnabled: () => false },
  exitHooks: false,
});

// The stand-in service manager.
const SERVICES: ServiceInfo[] = [
  { unit: "demo.service", scope: "system", description: "Demo web app", activeState: "active", subState: "running", unitFileState: "enabled", running: true, failed: false, enabled: true, mainPid: 4242 },
  { unit: "ppm.service", scope: "system", description: "PPM", activeState: "active", subState: "running", unitFileState: "enabled", running: true, failed: false, enabled: true, mainPid: 4100, refused: { stop: "PPM's own unit cannot be stopped from here" } },
  { unit: "sync.service", scope: "user", description: "File sync", activeState: "inactive", subState: "dead", unitFileState: "disabled", running: false, failed: false, enabled: false, mainPid: null },
];
const serviceActions: unknown[] = [];
const backend = {
  manager: "systemd" as const,
  isName: (unit: string) => /^[\w@.:-]+$/.test(unit),
  collect: async () => ({ supported: true, manager: "systemd" as const, services: SERVICES, warnings: [] }),
  details: async (unit: string, scope: "system" | "user"): Promise<ServiceDetails | null> => {
    const s = SERVICES.find((x) => x.unit === unit && x.scope === scope);
    return s ? { ...s, user: null, group: null, fragmentPath: `/etc/systemd/system/${unit}`, logs: [{ ts: STARTED, message: `${unit} started` }] } : null;
  },
  action: async (unit: string, scope: "system" | "user", action: "start" | "stop" | "restart" | "enable" | "disable") => {
    const why = SERVICES.find((x) => x.unit === unit && x.scope === scope)?.refused?.[action];
    if (why) throw new ServiceActionRefused(why);
    serviceActions.push({ unit, scope, action });
    return { unit, scope, action };
  },
};

const app = new Hono();
app.route("/api/cli", cliHelloRoutes);
app.use("/api/*", authMiddleware);
app.route("/api/system", createResourceRoutes(service, async () => ({ platform: "linux", ts: 1, disks: [], nics: [], gpus: [] })));
app.route("/api/system", createSystemServiceRoutes(backend));
app.get("/api/__scratch/streams", (c) => c.json(ok(service.liveCount())));
app.get("/api/__scratch/kills", (c) => c.json(ok(kills)));
app.get("/api/__scratch/service-actions", (c) => c.json(ok(serviceActions)));
app.post("/api/__scratch/register-provider", async (c) => {
  const { pid } = await c.req.json<{ pid: number }>();
  registerChatProviderPid(pid, "claude");
  return c.json(ok({ pid }));
});

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 60 });
setServerListenAddress(server.port, "127.0.0.1");
publishServerEndpoint({ port: server.port, host: "127.0.0.1", dbFile: getDbPath(), version: "scratch", instanceId: serverInstanceId() });
process.on("SIGTERM", () => { service.shutdown(); process.exit(0); });
console.log(`READY ${server.port}`);
