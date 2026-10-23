import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { Hono } from "hono";
import { configService } from "../../../src/services/config.service.ts";
import { STATUS_FILE } from "../../../src/services/supervisor-state.ts";
import { namedTunnelSetupService, SetupError } from "../../../src/services/named-tunnel/named-tunnel-setup.service.ts";
import { shareHostSetupService } from "../../../src/services/share-host/share-host-setup.service.ts";
import { shareHostRoutes } from "../../../src/server/routes/share-host.ts";

// Patch the service aggregates, never mock.module (it is process-wide and would replace the real
// modules for the services' own tests).
const originals = { ...shareHostSetupService };
const originalCertState = namedTunnelSetupService.currentCertState;
afterAll(() => {
  Object.assign(shareHostSetupService, originals);
  namedTunnelSetupService.currentCertState = originalCertState;
});

const calls: unknown[][] = [];
let setupThrow: SetupError | null = null;
shareHostSetupService.setEnabled = async (enabled: boolean) => { calls.push(["enabled", enabled]); return { applied: true }; };
shareHostSetupService.useTemporary = async () => { calls.push(["quick"]); return { applied: false, message: "Run `ppm restart` to apply." }; };
shareHostSetupService.readZone = async () => ({ zone: "example.com", proposedHostname: "share.example.com" });
shareHostSetupService.runSetup = async (mode, hostname) => {
  calls.push(["setup", mode, hostname]);
  if (setupThrow) throw setupThrow;
  return { hostname, tunnelName: "ppm-share-box", applied: { applied: true } };
};
namedTunnelSetupService.currentCertState = () => "ok";

const app = () => new Hono().route("/api/share-host", shareHostRoutes);
const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app().request(`http://localhost/api/share-host${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  calls.length = 0;
  setupThrow = null;
  configService.set("auth", { enabled: true, token: "test-token" });
  configService.set("share_host", { enabled: false, mode: "quick" });
  writeFileSync(STATUS_FILE(), JSON.stringify({}));
});

describe("/api/share-host", () => {
  it("reports settings and what runs, never the run token", async () => {
    const token = "secret-run-token-0123456789-must-not-leave";
    configService.set("share_host", {
      enabled: true, mode: "named", hostname: "share.example.com", tunnelName: "ppm-share-box", token,
      zoneID: "a".repeat(32), accountID: "b".repeat(32),
    });
    writeFileSync(STATUS_FILE(), JSON.stringify({
      supervisorPid: process.pid, capabilities: ["retunnel", "reshare"], shareHostPid: process.pid,
      shareHostTunnelPid: process.pid, shareHostUrl: "https://share.example.com",
    }));
    const res = await app().request("http://localhost/api/share-host/status");
    const text = await res.text();
    expect(text).not.toContain(token);
    expect(JSON.parse(text).data).toMatchObject({
      enabled: true, mode: "named", hostname: "share.example.com", tunnelName: "ppm-share-box",
      canApply: true, supervised: true, running: true, connected: true, url: "https://share.example.com",
      certState: "ok", authEnabled: true, ppmTunnel: { named: false },
    });
  });

  it("says a supervisor without reshare cannot apply changes", async () => {
    writeFileSync(STATUS_FILE(), JSON.stringify({ supervisorPid: process.pid, capabilities: ["retunnel"] }));
    const data = (await (await app().request("http://localhost/api/share-host/status")).json()).data;
    expect(data).toMatchObject({ supervised: true, canApply: false });
  });

  it("refuses every change while PPM sign-in is off, and from another origin", async () => {
    configService.set("auth", { enabled: false, token: "test-token" });
    for (const [path, body] of [["/enabled", { enabled: true }], ["/quick", undefined], ["/setup", { mode: "named", hostname: "share.example.com" }]] as const) {
      const res = await post(path, body);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain("a public review address requires PPM authentication");
    }
    configService.set("auth", { enabled: true, token: "test-token" });
    expect((await post("/enabled", { enabled: true }, { Origin: "https://evil.example" })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("switches on and off, and to a temporary address, passing back whether it applied", async () => {
    expect((await (await post("/enabled", { enabled: true })).json()).data).toEqual({ applied: true });
    expect((await post("/enabled", { enabled: "yes" })).status).toBe(400);
    expect((await (await post("/quick")).json()).data).toEqual({ applied: false, message: "Run `ppm restart` to apply." });
    expect(calls).toEqual([["enabled", true], ["quick"]]);
  });

  it("validates a setup request and maps the service's errors to their status", async () => {
    expect((await post("/setup", { mode: "other", hostname: "share.example.com" })).status).toBe(400);
    expect((await post("/setup", { mode: "named" })).status).toBe(400);
    const ok = await post("/setup", { mode: "shared", hostname: " Share.Example.com" });
    expect((await ok.json()).data).toEqual({ hostname: "share.example.com", tunnelName: "ppm-share-box", applied: { applied: true } });

    setupThrow = new SetupError(409, "a setup is already running");
    const busy = await post("/setup", { mode: "named", hostname: "share.example.com" });
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toBe("a setup is already running");
  });

  it("proposes the zone's share. address", async () => {
    const res = await app().request("http://localhost/api/share-host/zone");
    expect((await res.json()).data).toEqual({ zone: "example.com", proposedHostname: "share.example.com" });
  });
});
