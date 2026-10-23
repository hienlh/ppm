import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import {
  planShareHost, resolveShareHostConfig, shareTunnelNameForHost, SHARED_NEEDS_NAMED_PPM,
} from "../../../../src/services/share-host/share-host-config.ts";
import {
  ingressConfigYaml, ppmIngressRunArgs, sharedOwnArgs, shareNamedArgs, shareQuickArgs,
} from "../../../../src/services/share-host/share-host-args.ts";
import { readShareHostLive } from "../../../../src/services/share-host/share-host-status.ts";
import { tunnelNameForHost } from "../../../../src/services/named-tunnel/named-tunnel-args.ts";
import { getQuickTunnelArgs } from "../../../../src/services/cloudflared.service.ts";
import type { ResolvedTunnelConfig } from "../../../../src/services/named-tunnel/named-tunnel-config.ts";

const TOKEN = "share-run-token-that-must-never-be-in-argv-0123456789";
const PPM_TOKEN = "ppm-run-token-that-must-never-be-in-argv-0123456789";
const NAMED_ROW = {
  enabled: true, mode: "named", hostname: "share.example.com", tunnelName: "ppm-share-box", token: TOKEN,
  zoneID: "a".repeat(32), accountID: "b".repeat(32),
};
const PPM_NAMED: ResolvedTunnelConfig = {
  enabled: false, mode: "named", hostname: "ppm.example.com", tunnelName: "ppm-box", token: PPM_TOKEN,
  zoneID: "a".repeat(32), accountID: "b".repeat(32), dismissed: false,
};
const PPM_QUICK: ResolvedTunnelConfig = {
  enabled: true, mode: "quick", hostname: null, tunnelName: null, token: null, zoneID: null, accountID: null, dismissed: false,
};

// Restore, never delete: the preload's PPM_HOME keeps later files away from the real ~/.ppm.
const ORIGINAL_PPM_HOME = process.env.PPM_HOME;
let ppmHome: string;
beforeEach(() => {
  ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-share-host-"));
  process.env.PPM_HOME = ppmHome;
  _resetPpmDir();
});
afterEach(() => {
  process.env.PPM_HOME = ORIGINAL_PPM_HOME;
  _resetPpmDir();
  rmSync(ppmHome, { recursive: true, force: true });
});

describe("resolveShareHostConfig", () => {
  it("is off and temporary until a row says otherwise", () => {
    for (const raw of [null, undefined, "", "not json", 42, {}]) {
      expect(resolveShareHostConfig(raw)).toMatchObject({ enabled: false, mode: "quick", hostname: null, token: null });
    }
    expect(resolveShareHostConfig({ enabled: "true" }).enabled).toBe(false);
    expect(resolveShareHostConfig(JSON.stringify({ enabled: true })).enabled).toBe(true);
  });

  it("takes a named row only with its whole identity", () => {
    expect(resolveShareHostConfig(NAMED_ROW)).toEqual({
      enabled: true, mode: "named", hostname: "share.example.com", tunnelName: "ppm-share-box", token: TOKEN,
      zoneID: "a".repeat(32), accountID: "b".repeat(32),
    });
    for (const missing of ["hostname", "token", "zoneID", "accountID"]) {
      const row: Record<string, unknown> = { ...NAMED_ROW };
      delete row[missing];
      expect(resolveShareHostConfig(row).mode).toBe("quick");
    }
  });

  it("takes a shared row with a hostname, never reading a token or tunnel of its own", () => {
    const shared = resolveShareHostConfig({ ...NAMED_ROW, mode: "shared" });
    expect(shared).toMatchObject({ mode: "shared", hostname: "share.example.com", token: null, tunnelName: null });
    expect(resolveShareHostConfig({ enabled: true, mode: "shared" }).mode).toBe("quick");
  });
});

describe("planShareHost", () => {
  const quick = resolveShareHostConfig({ enabled: true });
  const named = resolveShareHostConfig(NAMED_ROW);
  const shared = resolveShareHostConfig({ ...NAMED_ROW, mode: "shared" });

  it("runs nothing while off, whatever else is set", () => {
    expect(planShareHost({ ...named, enabled: false }, PPM_NAMED, true)).toEqual({ kind: "off" });
  });

  it("runs its own connector for quick and named", () => {
    expect(planShareHost(quick, null, false)).toEqual({ kind: "quick" });
    expect(planShareHost(named, PPM_QUICK, true)).toEqual({ kind: "named", hostname: "share.example.com", token: TOKEN });
  });

  it("puts the shared hostname on PPM's connector while PPM's link runs, and on its own while it does not", () => {
    expect(planShareHost(shared, PPM_NAMED, true)).toEqual({ kind: "shared-ppm", hostname: "share.example.com" });
    expect(planShareHost(shared, PPM_NAMED, false)).toEqual({ kind: "shared-own", hostname: "share.example.com", token: PPM_TOKEN });
  });

  it("cannot share a tunnel PPM does not have", () => {
    expect(planShareHost(shared, PPM_QUICK, true)).toEqual({ kind: "unavailable", reason: SHARED_NEEDS_NAMED_PPM });
    expect(planShareHost(shared, null, false)).toEqual({ kind: "unavailable", reason: SHARED_NEEDS_NAMED_PPM });
  });
});

describe("shareTunnelNameForHost", () => {
  it("is PPM's own name with share- after ppm-, within Cloudflare's length", () => {
    const name = shareTunnelNameForHost();
    expect(name.startsWith("ppm-share-")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name).not.toBe(tunnelNameForHost());
  });
});

describe("share host cloudflared argv", () => {
  it("writes ingress rules in order and ends with a 404 for every other hostname", () => {
    expect(ingressConfigYaml([{ hostname: "share.example.com", port: 4100 }, { hostname: "ppm.example.com", port: 8080 }])).toBe([
      "no-autoupdate: true",
      "ingress:",
      "  - hostname: share.example.com",
      "    service: http://127.0.0.1:4100",
      "  - hostname: ppm.example.com",
      "    service: http://127.0.0.1:8080",
      "  - service: http_status:404",
      "",
    ].join("\n"));
  });

  it("refuses a hostname or port that could write anything else into the file", () => {
    expect(() => ingressConfigYaml([{ hostname: "share.example.com\n  - service: http://127.0.0.1:8080", port: 1 }])).toThrow();
    expect(() => ingressConfigYaml([{ hostname: "*.example.com", port: 1 }])).toThrow();
    expect(() => ingressConfigYaml([{ hostname: "localhost", port: 1 }])).toThrow();
    expect(() => ingressConfigYaml([{ hostname: "share.example.com", port: 0 }])).toThrow();
    expect(() => ingressConfigYaml([{ hostname: "share.example.com", port: 70000 }])).toThrow();
  });

  it("aims a quick tunnel at the worker exactly as PPM's own", () => {
    expect(shareQuickArgs(4100)).toEqual(getQuickTunnelArgs(4100));
  });

  it("runs its own named tunnel from a private token file, never a token in argv", () => {
    const args = shareNamedArgs(TOKEN, 4100);
    expect(args.join(" ")).not.toContain(TOKEN);
    expect(args.slice(-2)).toEqual(["--url", "http://127.0.0.1:4100"]);
    const tokenFile = args[args.indexOf("--token-file") + 1]!;
    expect(readFileSync(tokenFile, "utf8")).toBe(TOKEN);
    if (process.platform !== "win32") expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });

  it("routes only the share hostname on PPM's tunnel while PPM's link is off", () => {
    const args = sharedOwnArgs(PPM_TOKEN, { hostname: "share.example.com", port: 4100 });
    expect(args.join(" ")).not.toContain(PPM_TOKEN);
    expect(args).not.toContain("--url");
    const config = readFileSync(args[args.indexOf("--config") + 1]!, "utf8");
    expect(config).toContain("hostname: share.example.com");
    expect(config).not.toContain("ppm.example.com");
    expect(config.trimEnd().endsWith("- service: http_status:404")).toBe(true);
  });

  it("gives PPM's own connector both hostnames when it carries the share host", () => {
    const args = ppmIngressRunArgs(PPM_TOKEN, [{ hostname: "share.example.com", port: 4100 }, { hostname: "ppm.example.com", port: 8080 }]);
    expect(args.join(" ")).not.toContain(PPM_TOKEN);
    expect(args).not.toContain("--url");
    const config = readFileSync(args[args.indexOf("--config") + 1]!, "utf8");
    expect(config.indexOf("share.example.com")).toBeLessThan(config.indexOf("ppm.example.com"));
  });
});

describe("readShareHostLive", () => {
  const named = resolveShareHostConfig(NAMED_ROW);
  const quick = resolveShareHostConfig({ enabled: true });
  const dead = 2 ** 22 + 12345; // above Linux's default pid_max

  it("is connected only while the supervisor, the worker and the connector all run", () => {
    const status = {
      supervisorPid: process.pid, shareHostPid: process.pid, shareHostTunnelPid: process.pid,
      shareHostUrl: "https://share.example.com/", shareHostWarning: null,
    };
    expect(readShareHostLive(named, status)).toMatchObject({
      enabled: true, supervised: true, running: true, connected: true, url: "https://share.example.com", warning: null,
    });
    expect(readShareHostLive(named, { ...status, shareHostTunnelPid: dead }).connected).toBe(false);
    expect(readShareHostLive(named, { ...status, shareHostPid: dead }).running).toBe(false);
    expect(readShareHostLive(named, { ...status, supervisorPid: dead })).toMatchObject({ supervised: false, connected: false });
  });

  it("keeps a domain's address while it reconnects, and drops a temporary one", () => {
    const down = { supervisorPid: process.pid, shareHostPid: process.pid, shareHostTunnelPid: null, shareHostUrl: null };
    expect(readShareHostLive(named, down)).toMatchObject({ connected: false, url: "https://share.example.com" });
    expect(readShareHostLive(quick, down)).toMatchObject({ connected: false, url: null });
    const up = { ...down, shareHostTunnelPid: process.pid, shareHostUrl: "https://a-b-c.trycloudflare.com" };
    expect(readShareHostLive(quick, up)).toMatchObject({ connected: true, url: "https://a-b-c.trycloudflare.com" });
  });

  it("reports nothing while switched off, even with a stale status left behind", () => {
    const stale = {
      supervisorPid: process.pid, shareHostPid: process.pid, shareHostTunnelPid: process.pid,
      shareHostUrl: "https://share.example.com", shareHostWarning: "old",
    };
    expect(readShareHostLive({ ...named, enabled: false }, stale)).toMatchObject({
      running: false, connected: false, url: null, warning: null,
    });
  });
});
