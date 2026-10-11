import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPpmDir } from "../../src/services/ppm-dir.ts";
import { getCloudflaredPath } from "../../src/services/cloudflared.service.ts";
import { configService } from "../../src/services/config.service.ts";
import { createRouteCaller } from "../../src/services/assistant-mcp/assistant-route-call.ts";
import type { CallPpmRoute, RouteMethod } from "../../src/services/assistant-mcp/assistant-route-rules.ts";
import type { ApprovalAsk } from "../../src/services/assistant-mcp/assistant-approval-broker.ts";
import type { ToolContext } from "../../src/services/assistant-mcp/assistant-tool-family.ts";
import { createTunnelToolHandlers, TUNNEL_ROUTES } from "../../src/services/assistant-mcp/assistant-tunnel-tools.ts";
import { realTunnelHost, type TunnelHost } from "../../src/services/assistant-mcp/assistant-tunnel-host.ts";
import { activeTunnels } from "../../src/server/routes/tunnel-spawn.ts";
import { listTailscaleForwards, startTailscaleForward } from "../../src/services/port-forward/tailscale-forward.ts";
import { defaultRunner } from "../../src/services/host-info/spawn-runner.ts";
import { rmRetrying } from "../helpers/rm-retrying.ts";

/**
 * The tunnel tools against PPM's real routes, in-process, on the throwaway PPM_HOME the test
 * preload makes. No real cloudflared or tailscale runs: cloudflared is `fake-cloudflared.ts`
 * compiled into `<PPM_HOME>/bin`, where PPM looks for it, and a Tailscale forward is opened with
 * `fake-tailscale.ts` as its CLI. The two read routes that would ask the host's real tailscale
 * (`/api/tailscale/state`, `/api/tunnels/transports`) are answered by the test instead.
 */

setDefaultTimeout(90_000);

const FAKE_CLOUDFLARED = resolve(import.meta.dir, "../fixtures/fake-cloudflared.ts");
const FAKE_TAILSCALE = resolve(import.meta.dir, "../fixtures/fake-tailscale.ts");

// Refuse to run anywhere but an isolated PPM folder: these tests switch the public link and
// stop processes, and must never reach the user's live instance.
if (resolve(getPpmDir()) === resolve(homedir(), ".ppm")) throw new Error("assistant-tunnel-tools integration needs an isolated PPM_HOME");

const FAKE_READS: Record<string, unknown> = {
  "GET /api/tailscale/state": { ok: true, data: { installed: true, backendState: "Running", tailnet: "example.org", device: { name: "devbox", ips: ["100.64.0.7"] }, service: { name: "ppm", url: null, approved: false, pointsAtPpm: false }, enabled: false } },
  "GET /api/tunnels/transports": { ok: true, data: { tailscale: { available: true, dnsName: "devbox.tail1234.ts.net" } } },
};

const realCaller = createRouteCaller(TUNNEL_ROUTES);
const calls: string[] = [];
const callRoute = (async (method: RouteMethod, path: string, body?: Record<string, unknown>) => {
  calls.push(`${method} ${path}`);
  const fake = FAKE_READS[`${method} ${path}`] as { ok: boolean; data: unknown } | undefined;
  if (fake) return { status: 200, ...fake };
  return realCaller(method, path, body);
}) as CallPpmRoute;

const asks: ApprovalAsk[] = [];
const ctx: ToolContext = { sessionId: "it", callRoute, ask: async (ask) => { asks.push(ask); return { verdict: "approved" }; } };
const tools = (host: TunnelHost = realTunnelHost) => createTunnelToolHandlers(host);
const jsonOf = (r: Record<string, unknown>) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);

let dev: ReturnType<typeof Bun.serve>;
let tsDir: string;

async function gone(pid: number, ms = 10_000): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await Bun.sleep(100)) {
    try { process.kill(pid, 0); } catch { return true; }
  }
  return false;
}

beforeAll(() => {
  mkdirSync(resolve(getPpmDir(), "bin"), { recursive: true });
  const built = Bun.spawnSync([process.execPath, "build", "--compile", FAKE_CLOUDFLARED, "--outfile", getCloudflaredPath()], { stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0 || !existsSync(getCloudflaredPath())) throw new Error(`could not build the fake cloudflared: ${built.stderr.toString().slice(0, 500)}`);
  dev = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("dev") });
  tsDir = mkdtempSync(join(tmpdir(), "ppm-assistant-ts-"));
  writeFileSync(join(tsDir, "state.json"), "{}");
});

afterAll(async () => {
  // Only this test's own children: the fakes it started, by exact pid.
  for (const t of [...activeTunnels.values()]) try { t.process.kill(); } catch { /* gone */ }
  for (const f of listTailscaleForwards()) try { process.kill(f.pid); } catch { /* gone */ }
  dev?.stop(true);
  await Bun.sleep(300);
  await rmRetrying(tsDir).catch(() => {});
  try { rmSync(getCloudflaredPath(), { force: true }); } catch { /* the preload removes the folder at exit */ }
});

describe("port forwards through the real routes", () => {
  let forwardPid = 0;

  test("port_forward_start asks, then the route spawns the fake cloudflared from PPM_HOME", async () => {
    asks.length = 0;
    const out = jsonOf(await tools()["port_forward_start"]!(ctx, { port: dev.port }));
    expect(asks).toHaveLength(1);
    expect(asks[0]!.summary.headline).toBe(`Put localhost:${dev.port} on the public internet`);
    expect(out.outcome).toBe("forwarded");
    expect(out.url).toMatch(/^https:\/\/e2e-\d+\.trycloudflare\.com$/);
    const tunnel = activeTunnels.get(dev.port!);
    expect(tunnel?.url).toBe(out.url);
    forwardPid = tunnel!.process.pid;
  });

  test("a second start for the same port answers at once, with no card", async () => {
    asks.length = 0;
    const out = jsonOf(await tools()["port_forward_start"]!(ctx, { port: dev.port }));
    expect(out.outcome).toBe("already-forwarded");
    expect(asks).toHaveLength(0);
  });

  test("tunnels_status lists it as this PPM's, without asking", async () => {
    asks.length = 0;
    const out = jsonOf(await tools()["tunnels_status"]!(ctx, {}));
    expect(asks).toHaveLength(0);
    const row = out.forwards.find((f: { pid: number }) => f.pid === forwardPid);
    expect(row).toMatchObject({ port: dev.port, ownedByThisPpm: true, protected: false });
    expect(JSON.stringify(out)).not.toContain("100.64.0.7");
  });

  test("a pid this PPM did not start is refused without any DELETE", async () => {
    calls.length = 0;
    for (const pid of [process.pid, 9_999_991]) {
      const r = await tools()["port_forward_stop"]!(ctx, { pid });
      expect(r.isError).toBe(true);
    }
    expect(calls.filter((c) => c.startsWith("DELETE"))).toHaveLength(0);
  });

  test("port_forward_stop stops exactly its own forward through the real DELETE route", async () => {
    calls.length = 0;
    asks.length = 0;
    const out = jsonOf(await tools()["port_forward_stop"]!(ctx, { port: dev.port }));
    expect(asks).toHaveLength(1);
    expect(out).toMatchObject({ outcome: "stopped", pid: forwardPid });
    expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([`DELETE /api/tunnels/${forwardPid}`]);
    expect(activeTunnels.has(dev.port!)).toBe(false);
    expect(await gone(forwardPid)).toBe(true);
  });

  test("a Tailscale forward this PPM opened (with the fake CLI) is stopped through the same route", async () => {
    const forward = await startTailscaleForward(dev.port!, { argv: [process.execPath, FAKE_TAILSCALE, join(tsDir, "state.json")], runner: defaultRunner });
    calls.length = 0;
    const out = jsonOf(await tools()["port_forward_stop"]!(ctx, { pid: forward.pid }));
    expect(out).toMatchObject({ outcome: "stopped", via: "tailscale" });
    expect(calls).toEqual([`DELETE /api/tunnels/${forward.pid}`]);
    expect(listTailscaleForwards()).toHaveLength(0);
  });

  test("PPM's own port is refused before any route", async () => {
    calls.length = 0;
    const r = await tools()["port_forward_start"]!(ctx, { port: configService.get("port") });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("public link on a throwaway PPM_HOME", () => {
  const auth = () => (configService as unknown as { config: { auth: { enabled: boolean } } }).config.auth;
  const linkEnabled = async () => ((await realCaller<{ enabled: boolean }>("GET", "/api/tunnel")).data!.enabled);

  test("the real host reports the default profile here", async () => {
    expect(await realTunnelHost.dbProfile()).toBeNull();
  });

  test("off, on with login off (refused), on with login on — and no supervisor is ever told", async () => {
    const before = auth().enabled;
    try {
      // Start from on, so switching off is a change.
      await realCaller("POST", "/api/tunnel/enabled", { enabled: true });
      auth().enabled = false;
      const off = jsonOf(await tools()["public_link_set"]!(ctx, { enabled: false }));
      expect(off).toMatchObject({ outcome: "switched", enabled: false, reload: "no-supervisor" });
      expect(await linkEnabled()).toBe(false);

      const refused = await tools()["public_link_set"]!(ctx, { enabled: true });
      expect(refused.isError).toBe(true);
      expect(await linkEnabled()).toBe(false);

      auth().enabled = true;
      const on = jsonOf(await tools()["public_link_set"]!(ctx, { enabled: true }));
      expect(on).toMatchObject({ outcome: "switched", enabled: true, reload: "no-supervisor" });
      expect(existsSync(join(getPpmDir(), ".supervisor-cmd"))).toBe(false);
    } finally {
      auth().enabled = before;
    }
  });

  test("a non-default database profile is refused without touching the switch", async () => {
    calls.length = 0;
    const r = await tools({ ...realTunnelHost, dbProfile: async () => "dev" })["public_link_set"]!(ctx, { enabled: false });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
