import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { CMD_FILE, STATUS_FILE } from "../../../../src/services/supervisor-state.ts";
import { SetupError } from "../../../../src/services/named-tunnel/named-tunnel-setup.service.ts";
import { shareTunnelNameForHost } from "../../../../src/services/share-host/share-host-config.ts";
import {
  readShareZone, runShareHostSetup, setShareHostEnabled, shareHostSetupDeps, useTemporaryShareAddress,
} from "../../../../src/services/share-host/share-host-setup.service.ts";

// requestShareHostReload signals the recorded supervisor, which is this process here.
process.on("SIGUSR2", () => {});

// Synthetic fixtures only — never the real ~/.cloudflared/cert.pem on this host.
const ZONE_ID = "a".repeat(32);
const ACCOUNT_ID = "b".repeat(32);
const RUN_TOKEN = "x".repeat(120);
const PPM_TUNNEL = { name: "ppm-box", id: "11111111-1111-1111-1111-111111111111" };
const SHARE_TUNNEL_ID = "22222222-2222-2222-2222-222222222222";
const PPM_NAMED = {
  enabled: false, mode: "named" as const, namedTunnelName: PPM_TUNNEL.name, namedTunnelHostname: "ppm.example.com",
  namedTunnelToken: "p".repeat(120), zoneID: ZONE_ID, accountID: ACCOUNT_ID,
};

interface RunResult { code: number; stdout: string; stderr: string }
const runCalls: string[][] = [];
const runResults = new Map<string, RunResult>();
const originalRun = shareHostSetupDeps.runCloudflared;
const originalDelay = shareHostSetupDeps.reloadRetryDelayMs;
shareHostSetupDeps.runCloudflared = async (args: string[]) => {
  runCalls.push(args);
  const key = args.includes("create") ? "create" : args.includes("token") ? "token" : args.includes("dns") ? "route" : "?";
  return runResults.get(key) ?? { code: 0, stdout: "", stderr: "" };
};
shareHostSetupDeps.reloadRetryDelayMs = 10;
afterAll(() => {
  shareHostSetupDeps.runCloudflared = originalRun;
  shareHostSetupDeps.reloadRetryDelayMs = originalDelay;
});

/** Cloudflare as the setup sees it: zone name, DNS records by name, tunnels by name. */
const cf = {
  dns: new Map<string, { content: string }[]>(),
  tunnels: new Map<string, { id: string; connections: number }>(),
};
const originalFetch = globalThis.fetch;
function installFetchStub(): void {
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(url.toString());
    if (/\/zones\/[^/]+$/.test(u.pathname)) return Response.json({ success: true, result: { name: "example.com" } });
    if (u.pathname.endsWith("/dns_records")) return Response.json({ success: true, result: cf.dns.get(u.searchParams.get("name")!) ?? [] });
    if (u.pathname.endsWith("/cfd_tunnel")) {
      const t = cf.tunnels.get(u.searchParams.get("name")!);
      return Response.json({ success: true, result: t ? [{ id: t.id, connections: Array.from({ length: t.connections }, () => ({})) }] : [] });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as typeof fetch;
}

function writeCert(payload: unknown): void {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  writeFileSync(process.env.TUNNEL_ORIGIN_CERT!, `-----BEGIN ARGO TUNNEL TOKEN-----\n${b64}\n-----END ARGO TUNNEL TOKEN-----\n`);
}

const cmd = () => (existsSync(CMD_FILE()) ? JSON.parse(readFileSync(CMD_FILE(), "utf8")).action : null);
const routeCall = () => runCalls.find((a) => a.includes("dns"));

// Restore, never delete: the preload's PPM_HOME keeps later files away from the real ~/.ppm.
const ORIGINAL_PPM_HOME = process.env.PPM_HOME;
let ppmHome: string;
let certDir: string;

beforeEach(() => {
  ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-share-setup-"));
  process.env.PPM_HOME = ppmHome;
  _resetPpmDir();
  certDir = mkdtempSync(resolve(tmpdir(), "ppm-share-setup-cert-"));
  process.env.TUNNEL_ORIGIN_CERT = resolve(certDir, "cert.pem");
  setDb(openTestDb());
  configService.load();
  writeCert({ zoneID: ZONE_ID, accountID: ACCOUNT_ID, apiToken: "fake-api-token" });
  installFetchStub();
  cf.dns.clear();
  cf.tunnels.clear();
  runCalls.length = 0;
  runResults.clear();
  runResults.set("token", { code: 0, stdout: `${RUN_TOKEN}\n`, stderr: "" });
  writeFileSync(STATUS_FILE(), JSON.stringify({ supervisorPid: process.pid, capabilities: ["retunnel", "reshare"] }));
});

afterEach(() => {
  process.env.PPM_HOME = ORIGINAL_PPM_HOME;
  delete process.env.TUNNEL_ORIGIN_CERT;
  _resetPpmDir();
  rmSync(ppmHome, { recursive: true, force: true });
  rmSync(certDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

async function expectSetupError(p: Promise<unknown>, status: number, text: string): Promise<void> {
  const error = await p.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(SetupError);
  expect((error as SetupError).status).toBe(status);
  expect((error as SetupError).message).toContain(text);
}

describe("its own tunnel (named)", () => {
  test("creates the tunnel, routes the name, keeps the token, and tells the supervisor", async () => {
    const result = await runShareHostSetup("named", "Share.Example.com ");
    const name = shareTunnelNameForHost();
    expect(result).toEqual({ hostname: "share.example.com", tunnelName: name, applied: { applied: true } });
    expect(runCalls.map((a) => a.slice(a.indexOf("tunnel")).join(" "))).toEqual([
      `tunnel create ${name}`, `tunnel route dns ${name} share.example.com`, `tunnel token ${name}`,
    ]);
    // Setting a domain up is not turning the address on.
    expect(configService.get("share_host")).toEqual({
      enabled: false, mode: "named", hostname: "share.example.com", tunnelName: name, token: RUN_TOKEN,
      zoneID: ZONE_ID, accountID: ACCOUNT_ID,
    });
    expect(cmd()).toBe("reshare");
  });

  test("refuses PPM's own address, a name that points elsewhere, and a hostname outside the zone", async () => {
    configService.set("tunnel", PPM_NAMED);
    await expectSetupError(runShareHostSetup("named", "ppm.example.com"), 400, "PPM's own address");
    cf.dns.set("share.example.com", [{ content: "203.0.113.5" }]);
    await expectSetupError(runShareHostSetup("named", "share.example.com"), 400, "points somewhere else");
    await expectSetupError(runShareHostSetup("named", "share.other.org"), 400, "subdomain of example.com");
    expect(runCalls).toHaveLength(0);
    expect(configService.get("share_host").mode).toBe("quick");
  });

  test("re-points its own name with --overwrite-dns", async () => {
    cf.tunnels.set(shareTunnelNameForHost(), { id: SHARE_TUNNEL_ID, connections: 0 });
    cf.dns.set("share.example.com", [{ content: `${SHARE_TUNNEL_ID}.cfargotunnel.com` }]);
    await runShareHostSetup("named", "share.example.com");
    expect(routeCall()).toContain("--overwrite-dns");
  });

  test("will not join a tunnel of that name that another PPM is serving, but takes back its own", async () => {
    cf.tunnels.set(shareTunnelNameForHost(), { id: SHARE_TUNNEL_ID, connections: 2 });
    await expectSetupError(runShareHostSetup("named", "share.example.com"), 409, "already running elsewhere");
    configService.set("share_host", { enabled: true, mode: "quick", tunnelName: shareTunnelNameForHost() });
    await runShareHostSetup("named", "share.example.com");
    expect(configService.get("share_host")).toMatchObject({ enabled: true, mode: "named" });
  });

  test("saves the setting but says so when the supervisor predates the share host", async () => {
    writeFileSync(STATUS_FILE(), JSON.stringify({ supervisorPid: process.pid, capabilities: ["retunnel"] }));
    const result = await runShareHostSetup("named", "share.example.com");
    expect(result.applied).toEqual({ applied: false, message: expect.stringContaining("ppm restart") });
    expect(configService.get("share_host").mode).toBe("named");
    expect(cmd()).toBeNull();
  });
});

describe("on PPM's tunnel (shared)", () => {
  test("needs PPM's tunnel on a domain, and that tunnel to exist", async () => {
    await expectSetupError(runShareHostSetup("shared", "share.example.com"), 400, "Public link first");
    configService.set("tunnel", PPM_NAMED);
    await expectSetupError(runShareHostSetup("shared", "share.example.com"), 400, "no longer exists");
    expect(runCalls).toHaveLength(0);
  });

  test("routes the name to PPM's tunnel without creating one or fetching a token", async () => {
    configService.set("tunnel", PPM_NAMED);
    cf.tunnels.set(PPM_TUNNEL.name, { id: PPM_TUNNEL.id, connections: 1 });
    const result = await runShareHostSetup("shared", "share.example.com");
    expect(result.tunnelName).toBe(PPM_TUNNEL.name);
    expect(runCalls).toHaveLength(1);
    expect(routeCall()!.slice(routeCall()!.indexOf("tunnel")).join(" ")).toBe(`tunnel route dns ${PPM_TUNNEL.name} share.example.com`);
    expect(configService.get("share_host")).toMatchObject({ mode: "shared", hostname: "share.example.com" });
  });

  test("moves its own name between its own tunnel and PPM's, keeping the record of its own tunnel", async () => {
    configService.set("tunnel", PPM_NAMED);
    cf.tunnels.set(PPM_TUNNEL.name, { id: PPM_TUNNEL.id, connections: 1 });
    cf.tunnels.set(shareTunnelNameForHost(), { id: SHARE_TUNNEL_ID, connections: 0 });
    await runShareHostSetup("named", "share.example.com");
    cf.dns.set("share.example.com", [{ content: `${SHARE_TUNNEL_ID}.cfargotunnel.com` }]);
    runCalls.length = 0;

    await runShareHostSetup("shared", "share.example.com");
    expect(routeCall()).toContain("--overwrite-dns");
    expect(configService.get("share_host")).toMatchObject({
      mode: "shared", tunnelName: shareTunnelNameForHost(), token: RUN_TOKEN,
    });

    // And back: the name now points at PPM's tunnel, which is this installation's too.
    cf.dns.set("share.example.com", [{ content: `${PPM_TUNNEL.id}.cfargotunnel.com` }]);
    await runShareHostSetup("named", "share.example.com");
    expect(configService.get("share_host").mode).toBe("named");
  });

  test("does not take over a name on PPM's tunnel that this share host never had", async () => {
    configService.set("tunnel", PPM_NAMED);
    cf.tunnels.set(PPM_TUNNEL.name, { id: PPM_TUNNEL.id, connections: 1 });
    cf.dns.set("docs.example.com", [{ content: `${SHARE_TUNNEL_ID}.cfargotunnel.com` }]);
    await expectSetupError(runShareHostSetup("shared", "docs.example.com"), 400, "points somewhere else");
  });
});

describe("sign-in", () => {
  test("needs a Cloudflare login from the account PPM's tunnel is on", async () => {
    rmSync(process.env.TUNNEL_ORIGIN_CERT!);
    await expectSetupError(runShareHostSetup("named", "share.example.com"), 400, "Not logged in");
    writeCert({ zoneID: "c".repeat(32), accountID: "d".repeat(32), apiToken: "other" });
    configService.set("tunnel", PPM_NAMED);
    await expectSetupError(runShareHostSetup("named", "share.example.com"), 400, "different Cloudflare account");
  });

  test("proposes share.<zone>", async () => {
    expect(await readShareZone()).toEqual({ zone: "example.com", proposedHostname: "share.example.com" });
  });
});

describe("switches", () => {
  test("turning it on or off keeps every other field", async () => {
    configService.set("share_host", { enabled: false, mode: "named", hostname: "share.example.com", token: RUN_TOKEN, zoneID: ZONE_ID, accountID: ACCOUNT_ID });
    expect(await setShareHostEnabled(true)).toEqual({ applied: true });
    expect(configService.get("share_host")).toMatchObject({ enabled: true, mode: "named", token: RUN_TOKEN });
    expect(cmd()).toBe("reshare");
  });

  test("a temporary address keeps the domain fields, which record whose tunnel it is", async () => {
    configService.set("share_host", { enabled: true, mode: "named", hostname: "share.example.com", tunnelName: "ppm-share-x" });
    await useTemporaryShareAddress();
    expect(configService.get("share_host")).toMatchObject({ enabled: true, mode: "quick", hostname: "share.example.com", tunnelName: "ppm-share-x" });
  });

  test("reports a missing supervisor rather than pretending it applied", async () => {
    writeFileSync(STATUS_FILE(), JSON.stringify({}));
    expect(await setShareHostEnabled(true)).toEqual({ applied: false, message: expect.stringContaining("ppm start") });
  });

  test("runs one setup at a time", async () => {
    const first = runShareHostSetup("named", "share.example.com");
    await expectSetupError(runShareHostSetup("named", "other.example.com"), 409, "already running");
    await first;
  });
});
