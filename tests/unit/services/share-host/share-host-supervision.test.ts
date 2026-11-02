import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { openTestDb, setConfigValue, setDb } from "../../../../src/services/db.service.ts";
import { STATUS_FILE } from "../../../../src/services/supervisor-state.ts";
import { buildTunnelAttempts } from "../../../../src/services/supervisor.ts";
import { resolveShareHostConfig } from "../../../../src/services/share-host/share-host-config.ts";
import {
  initShareHost, PLAIN_PPM_ROUTES, ppmConnectorRoutes, ppmConnectorRoutesByHostname, reloadShareHost,
  routesForPpmConnector, stopShareHost, type ShareHostSupervisorHooks,
} from "../../../../src/services/share-host/share-host-supervision.ts";
import type { ResolvedTunnelConfig } from "../../../../src/services/named-tunnel/named-tunnel-config.ts";

const PPM_NAMED: ResolvedTunnelConfig = {
  enabled: true, mode: "named", hostname: "ppm.example.com", tunnelName: "ppm-box", token: "p".repeat(120),
  zoneID: "a".repeat(32), accountID: "b".repeat(32), dismissed: false,
};
const PPM_QUICK: ResolvedTunnelConfig = {
  enabled: true, mode: "quick", hostname: null, tunnelName: null, token: null, zoneID: null, accountID: null, dismissed: false,
};
/** A review hostname set up on PPM's tunnel: its DNS record points there from then on. */
const SHARED_ROW = { mode: "shared", hostname: "share.example.com", zoneID: "a".repeat(32), accountID: "b".repeat(32) };

/** No `--url` in PPM's named argv: only the hostnames its ingress names reach anything. */
const routesByHostname = (routes: Parameters<typeof buildTunnelAttempts>[2]) =>
  !buildTunnelAttempts(PPM_NAMED, 4000, routes)[0]!.args.includes("--url");

describe("ppmConnectorRoutes — what PPM's named connector routes", () => {
  const routes = (row: unknown, ppm: ResolvedTunnelConfig = PPM_NAMED, port: number | null = 4100) =>
    ppmConnectorRoutes(resolveShareHostConfig(row), ppm, port);

  it("carries the review hostname to the worker while the review address rides on PPM's tunnel", () => {
    expect(routes({ ...SHARED_ROW, enabled: true })).toEqual({ byHostname: true, share: { hostname: "share.example.com", port: 4100 } });
  });

  it("keeps routing by hostname whenever it does not carry the review hostname", () => {
    // Each of these fell back to --url, which answered the review hostname with all of PPM.
    expect(routes({ ...SHARED_ROW, enabled: true }, PPM_NAMED, null)).toEqual({ byHostname: true, share: null }); // worker has no port
    expect(routes({ ...SHARED_ROW, enabled: false })).toEqual({ byHostname: true, share: null }); // switched off
    expect(routes({ ...SHARED_ROW, enabled: true, mode: "quick" })).toEqual({ byHostname: true, share: null }); // back to temporary
    expect(routes({ ...SHARED_ROW, enabled: true, mode: "named", token: "t".repeat(120) })).toEqual({ byHostname: true, share: null });
  });

  it("leaves PPM's connector on --url when no review hostname was ever set up, or PPM's own address is temporary", () => {
    expect(routes(null)).toEqual(PLAIN_PPM_ROUTES);
    expect(routes({ enabled: true })).toEqual(PLAIN_PPM_ROUTES);
    expect(routes({ ...SHARED_ROW, enabled: true }, PPM_QUICK)).toEqual(PLAIN_PPM_ROUTES);
  });
});

describe("reconciling the share host — PPM's connector", () => {
  // Restore, never delete: the preload's PPM_HOME keeps later files away from the real ~/.ppm.
  const ORIGINAL_PPM_HOME = process.env.PPM_HOME;
  let ppmHome: string;
  let restarts = 0;
  let gateCalls = 0;
  let gate: ShareHostSupervisorHooks["gate"];
  const hooks: ShareHostSupervisorHooks = {
    logFd: 2,
    ppmTunnel: () => ({ config: PPM_NAMED, linkOn: true }),
    restartPpmConnector: () => { restarts++; },
    gate: (fn) => { gateCalls++; return gate(fn); },
  };
  const shareRow = (row: Record<string, unknown>) => setConfigValue("share_host", JSON.stringify(row));
  const status = () => JSON.parse(readFileSync(STATUS_FILE(), "utf8"));

  beforeEach(() => {
    ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-share-supervision-"));
    process.env.PPM_HOME = ppmHome;
    _resetPpmDir();
    setDb(openTestDb());
    restarts = 0;
    gateCalls = 0;
    // As Bun.spawn does for a missing binary: it throws rather than starting a process that fails.
    gate = () => Promise.reject(new Error("Executable not found in $PATH"));
  });
  afterEach(() => {
    stopShareHost();
    process.env.PPM_HOME = ORIGINAL_PPM_HOME;
    _resetPpmDir();
    rmSync(ppmHome, { recursive: true, force: true });
  });

  it("switched off, it drops the route to the worker and keeps routing by hostname", async () => {
    gate = (fn) => Promise.resolve(fn());
    shareRow({ ...SHARED_ROW, enabled: true });
    await initShareHost(hooks, null, { ppmRestarting: true });
    expect(routesForPpmConnector(PPM_NAMED).share?.hostname).toBe("share.example.com");

    shareRow({ ...SHARED_ROW, enabled: false });
    await reloadShareHost();
    expect(restarts).toBe(1);
    const off = routesForPpmConnector(PPM_NAMED);
    expect(off).toEqual({ byHostname: true, share: null });
    expect(routesByHostname(off)).toBe(true);
  }, 15_000);

  it("a hostname set up while the switch is off moves PPM's connector off --url at once, and only once", async () => {
    await initShareHost(hooks, null, { ppmRestarting: true });
    expect(routesForPpmConnector(PPM_NAMED)).toEqual(PLAIN_PPM_ROUTES);

    shareRow({ ...SHARED_ROW, enabled: false });
    await reloadShareHost();
    expect(restarts).toBe(1);
    expect(routesForPpmConnector(PPM_NAMED)).toEqual({ byHostname: true, share: null });
    await reloadShareHost();
    expect(restarts).toBe(1);
  });

  it("a worker that cannot be started is tried again, and PPM's connector meanwhile routes PPM's hostname only", async () => {
    shareRow({ ...SHARED_ROW, enabled: true });
    await initShareHost(hooks, null, { ppmRestarting: true });
    expect(gateCalls).toBe(1);
    expect(status().shareHostWarning).toBe("The review address could not start; retrying.");
    // PPM's connector started now (a retunnel, a crash respawn) has no worker to route to.
    const routes = routesForPpmConnector(PPM_NAMED);
    expect(routes).toEqual({ byHostname: true, share: null });
    expect(routesByHostname(routes)).toBe(true);

    // No process ever started, so no exit will come: the retry is the supervisor's own.
    const deadline = Date.now() + 3000;
    while (gateCalls < 2 && Date.now() < deadline) await Bun.sleep(50);
    expect(gateCalls).toBe(2);
    expect(restarts).toBe(0);
  });

  it("tells the supervisor not to adopt PPM's connector once a review hostname is set up", () => {
    expect(ppmConnectorRoutesByHostname(PPM_NAMED)).toBe(false);
    shareRow({ ...SHARED_ROW, enabled: false });
    expect(ppmConnectorRoutesByHostname(PPM_NAMED)).toBe(true);
    expect(ppmConnectorRoutesByHostname(PPM_QUICK)).toBe(false);
  });
});
