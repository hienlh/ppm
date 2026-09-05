import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { STATUS_FILE, CMD_FILE } from "../../../../src/services/supervisor-state.ts";
import { globalWebSocket } from "../../../../src/server/ws/global.ts";

// Synthetic fixtures only — never the real ~/.cloudflared/cert.pem on this host.
const FAKE_ZONE_ID = "a".repeat(32);
const FAKE_ACCOUNT_ID = "b".repeat(32);
const FAKE_API_TOKEN = "fake-token-not-a-real-secret";
const VALID_RUN_TOKEN = "x".repeat(120); // matches /^[A-Za-z0-9._-]{100,}$/
const HOSTNAME = "ppm.example.com";

interface RunResult { code: number; stdout: string; stderr: string }

// cloudflared-exec.ts is the ONE module.mock in this suite: it is a brand-new
// file with no other consumer or dedicated test, so nothing else in the
// process-wide bun:test module registry competes for it. Every other
// dependency below (cert, zone/DNS lookups, config, supervisor state, the
// global WS bus) is the REAL module, driven through the same env-var/fs/fetch
// seams their own dedicated test files use — mocking any of those would
// silently replace the module for those other files too (bun:test's
// mock.module is process-wide, not per-file).
const runCalls: string[] = [];
const runResults = new Map<string, RunResult>();
mock.module("../../../../src/services/named-tunnel/cloudflared-exec.ts", () => ({
  runCloudflared: async (args: string[]) => {
    runCalls.push(args.join(" "));
    const key = args.includes("create") ? "create" : args.includes("token") ? "token" : args.includes("dns") ? "route" : "unknown";
    return runResults.get(key) ?? { code: 0, stdout: "", stderr: "" };
  },
}));

const {
  runSetup, readZoneInfo, disableNamedTunnel, currentCertState, SetupError,
} = await import("../../../../src/services/named-tunnel/named-tunnel-setup.service.ts");

function pemWithPayload(payload: unknown): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  return `-----BEGIN ARGO TUNNEL TOKEN-----\n${b64}\n-----END ARGO TUNNEL TOKEN-----\n`;
}

let openFakeClient: { data: { type: string }; send: (raw: string) => void } | null = null;
function captureBroadcasts(): unknown[] {
  const captured: unknown[] = [];
  openFakeClient = { data: { type: "global" }, send: (raw: string) => captured.push(JSON.parse(raw)) };
  globalWebSocket.open(openFakeClient as any);
  return captured;
}

/** Fake Cloudflare REST responses for fetchZoneName/fetchDnsRecords/fetchTunnelIdByName. */
const fetchState = { zone: "example.com", dnsRecords: [] as { content: string }[], existingTunnelId: null as string | null };
const originalFetch = globalThis.fetch;
function installFetchStub(): void {
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (/\/zones\/[^/]+$/.test(u)) {
      return new Response(JSON.stringify({ success: true, result: { name: fetchState.zone } }), { status: 200 });
    }
    if (u.includes("/dns_records")) {
      return new Response(JSON.stringify({ success: true, result: fetchState.dnsRecords }), { status: 200 });
    }
    if (u.includes("/cfd_tunnel")) {
      const result = fetchState.existingTunnelId ? [{ id: fetchState.existingTunnelId }] : [];
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as typeof fetch;
}

describe("named-tunnel-setup.service", () => {
  let ppmHome: string;
  let certDir: string;

  beforeEach(() => {
    ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-nt-setup-"));
    process.env.PPM_HOME = ppmHome;
    _resetPpmDir();
    certDir = mkdtempSync(resolve(tmpdir(), "ppm-nt-setup-cert-"));
    process.env.TUNNEL_ORIGIN_CERT = resolve(certDir, "cert.pem");

    setDb(openTestDb());
    configService.load();

    writeFileSync(process.env.TUNNEL_ORIGIN_CERT!, pemWithPayload({ zoneID: FAKE_ZONE_ID, accountID: FAKE_ACCOUNT_ID, apiToken: FAKE_API_TOKEN }));
    installFetchStub();
    fetchState.zone = "example.com";
    fetchState.dnsRecords = [];
    fetchState.existingTunnelId = null;

    runCalls.length = 0;
    runResults.clear();
    runResults.set("create", { code: 0, stdout: "", stderr: "" });
    runResults.set("route", { code: 0, stdout: "", stderr: "" });
    runResults.set("token", { code: 0, stdout: VALID_RUN_TOKEN, stderr: "" });

    // Real STATUS_FILE, real requestTunnelReload — supervisorPid: self, so the
    // (POSIX-only) liveness probe passes; win32 skips that probe entirely.
    writeFileSync(STATUS_FILE(), JSON.stringify({
      supervisorPid: process.pid, capabilities: ["retunnel"], tunnelMode: "named", shareUrl: `https://${HOSTNAME}`,
    }));
  });

  afterEach(() => {
    if (openFakeClient) {
      globalWebSocket.close(openFakeClient as any);
      openFakeClient = null;
    }
    delete process.env.PPM_HOME;
    delete process.env.TUNNEL_ORIGIN_CERT;
    _resetPpmDir();
    rmSync(ppmHome, { recursive: true, force: true });
    rmSync(certDir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  });

  describe("currentCertState", () => {
    test("none when the cert file is absent", () => {
      process.env.TUNNEL_ORIGIN_CERT = resolve(certDir, "does-not-exist.pem");
      expect(currentCertState()).toBe("none");
    });

    test("invalid when the cert file cannot be parsed", () => {
      writeFileSync(process.env.TUNNEL_ORIGIN_CERT!, "garbage, not a PEM block");
      expect(currentCertState()).toBe("invalid");
    });

    test("ok when the cert parses", () => {
      expect(currentCertState()).toBe("ok");
    });
  });

  describe("readZoneInfo", () => {
    test("throws a 400 SetupError when not logged in", async () => {
      process.env.TUNNEL_ORIGIN_CERT = resolve(certDir, "does-not-exist.pem");
      await expect(readZoneInfo()).rejects.toThrow("Not logged in to Cloudflare");
    });

    test("returns zone + proposed hostname when the cert is parsed", async () => {
      const info = await readZoneInfo();
      expect(info.zone).toBe("example.com");
      expect(info.proposedHostname).toBe("ppm.example.com");
      expect(info.zoneID).toBe(FAKE_ZONE_ID);
      expect(info.accountID).toBe(FAKE_ACCOUNT_ID);
    });
  });

  describe("runSetup — hostname validation", () => {
    test("rejects the zone apex with 400, no cloudflared call", async () => {
      await expect(runSetup("example.com")).rejects.toThrow(SetupError);
      expect(runCalls).toHaveLength(0);
    });

    test("rejects www with 400, no cloudflared call", async () => {
      await expect(runSetup("www.example.com")).rejects.toThrow(SetupError);
      expect(runCalls).toHaveLength(0);
    });
  });

  describe("runSetup — DNS collision precheck", () => {
    test("rejects a hostname whose record points to a different tunnel, no route dns call", async () => {
      fetchState.dnsRecords = [{ content: "someone-elses-uuid.cfargotunnel.com" }];
      await expect(runSetup(HOSTNAME)).rejects.toThrow("already points somewhere else");
      expect(runCalls.some((c) => c.includes("dns"))).toBe(false);
    });

    test("reuses + overwrites when the record already points at our own tunnel", async () => {
      fetchState.existingTunnelId = "own-uuid-1234";
      fetchState.dnsRecords = [{ content: "own-uuid-1234.cfargotunnel.com" }];
      const result = await runSetup(HOSTNAME);
      expect(result.ok).toBe(true);
      const routeCall = runCalls.find((c) => c.includes("dns"))!;
      expect(routeCall).toContain("--overwrite-dns");
    });

    test("no existing record — proceeds without --overwrite-dns", async () => {
      const result = await runSetup(HOSTNAME);
      expect(result.ok).toBe(true);
      const routeCall = runCalls.find((c) => c.includes("dns"))!;
      expect(routeCall).not.toContain("--overwrite-dns");
    });
  });

  describe("runSetup — tunnel create reuse", () => {
    test("'already exists' on create is treated as success-by-reuse", async () => {
      runResults.set("create", { code: 1, stdout: "", stderr: "tunnel with name already exists" });
      const result = await runSetup(HOSTNAME);
      expect(result.ok).toBe(true);
    });

    test("a genuine create failure is a 500 SetupError", async () => {
      runResults.set("create", { code: 1, stdout: "", stderr: "permission denied" });
      await expect(runSetup(HOSTNAME)).rejects.toThrow("cloudflared tunnel create failed");
    });
  });

  describe("runSetup — token validation", () => {
    test("rejects a malformed token shape rather than persisting it", async () => {
      runResults.set("token", { code: 0, stdout: "not a real token", stderr: "" });
      await expect(runSetup(HOSTNAME)).rejects.toThrow("unexpected cloudflared output");
      expect(configService.get("tunnel").mode).not.toBe("named");
    });
  });

  describe("runSetup — persistence and confirmation", () => {
    test("persists zoneID/accountID/token and confirms via status.json before ok:true", async () => {
      const captured = captureBroadcasts();
      const result = await runSetup(HOSTNAME);
      expect(result).toEqual({ ok: true, hostname: HOSTNAME, tunnelName: expect.any(String) });
      const tunnel = configService.get("tunnel");
      expect(tunnel.mode).toBe("named");
      expect(tunnel.namedTunnelToken).toBe(VALID_RUN_TOKEN);
      expect(tunnel.zoneID).toBe(FAKE_ZONE_ID);
      expect(tunnel.accountID).toBe(FAKE_ACCOUNT_ID);
      expect(captured.some((e: any) => e.type === "tunnel:setup_done")).toBe(true);
    });

    test("pending shape when the supervisor lacks the retunnel capability, config still saved", async () => {
      writeFileSync(STATUS_FILE(), JSON.stringify({ supervisorPid: process.pid })); // no capabilities array
      const result = await runSetup(HOSTNAME);
      expect(result.ok).toBe("pending");
      if (result.ok === "pending") expect(result.message).toContain("ppm restart");
      expect(configService.get("tunnel").mode).toBe("named"); // config write is not undone
      expect(existsSync(CMD_FILE())).toBe(false); // never even asked the supervisor
    });

    test("pending shape when the recorded supervisorPid is absent (no-supervisor)", async () => {
      writeFileSync(STATUS_FILE(), JSON.stringify({ capabilities: ["retunnel"] })); // no supervisorPid
      const result = await runSetup(HOSTNAME);
      expect(result.ok).toBe("pending");
      if (result.ok === "pending") expect(result.message).toContain("ppm restart");
    });
  });

  describe("runSetup — concurrency guard", () => {
    test("a second concurrent call is rejected with 409 while one is running", async () => {
      const first = runSetup(HOSTNAME);
      await expect(runSetup(HOSTNAME)).rejects.toThrow("a setup is already running");
      await first; // let the first one finish so it doesn't leak into other tests
    });
  });

  describe("disableNamedTunnel", () => {
    test("flips mode to quick, keeps other fields, and asks the supervisor to reload", async () => {
      configService.set("tunnel", { mode: "named", namedTunnelHostname: HOSTNAME, namedTunnelToken: VALID_RUN_TOKEN });
      await disableNamedTunnel();
      const tunnel = configService.get("tunnel");
      expect(tunnel.mode).toBe("quick");
      expect(tunnel.namedTunnelHostname).toBe(HOSTNAME); // kept for Retry
      expect(existsSync(CMD_FILE())).toBe(true); // supervisor was asked to reload
    });
  });
});
