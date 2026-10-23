import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { rmSync } from "node:fs";
import { STATUS_FILE, writeStatus } from "../../../src/services/supervisor-state.ts";
import { tunnelService } from "../../../src/services/tunnel.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import {
  ADDRESS_CACHE_MS, getForwardedShareHosts, getShareAddress, getShareTunnelAddress, resetShareAddressCache,
  SHARE_HOST_NOT_CONNECTED,
} from "../../../src/services/design/share/design-share-address.ts";
import { NOT_SUPERVISED_MESSAGE, OUTDATED_SUPERVISOR_MESSAGE } from "../../../src/services/share-host/share-host-status.ts";

/** The tunnel service's private state, set directly to stand in for a tunnel it holds. */
const tunnelState = tunnelService as unknown as {
  url: string | null; externalPid: number | null; childProcess: { pid: number } | null; supervisorManaged: boolean;
};

/** A pid that belonged to a process which has exited. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc.pid;
}

describe("design share address", () => {
  beforeEach(() => {
    resetShareAddressCache();
    rmSync(STATUS_FILE(), { force: true });
  });
  afterEach(() => {
    tunnelState.url = null;
    tunnelState.externalPid = null;
    tunnelState.childProcess = null;
    tunnelState.supervisorManaged = false;
    rmSync(STATUS_FILE(), { force: true });
    configService.set("share_host", { enabled: false, mode: "quick" });
  });

  it("is none when the supervisor nulled shareUrl, though getTunnelUrl() still holds the old one", () => {
    tunnelState.url = "https://stale-name.trycloudflare.com";
    writeStatus({ supervisorPid: process.pid, shareUrl: null, tunnelPid: null, tunnelMode: "quick" });
    expect(tunnelService.getTunnelUrl()).toBe("https://stale-name.trycloudflare.com");
    expect(getShareTunnelAddress()).toEqual({ kind: "none", url: null, warning: null, via: "ppm" });
  });

  it("names the named tunnel, passing its warning through", () => {
    writeStatus({
      supervisorPid: process.pid, shareUrl: "https://ppm.example.com/", tunnelPid: process.pid,
      tunnelMode: "named", tunnelWarning: "Named tunnel is not connected",
    });
    expect(getShareTunnelAddress()).toEqual({ kind: "named", url: "https://ppm.example.com", warning: "Named tunnel is not connected", via: "ppm" });
  });

  it("reports a quick tunnel, and none once its process has died", async () => {
    writeStatus({ supervisorPid: process.pid, shareUrl: "https://abc-def.trycloudflare.com", tunnelPid: process.pid, tunnelMode: "quick" });
    expect(getShareTunnelAddress()).toEqual({ kind: "quick", url: "https://abc-def.trycloudflare.com", warning: null, via: "ppm" });
    writeStatus({ supervisorPid: process.pid, shareUrl: "https://abc-def.trycloudflare.com", tunnelPid: await deadPid(), tunnelMode: "quick" });
    resetShareAddressCache();
    expect(getShareTunnelAddress().kind).toBe("none");
  });

  it("without a live supervisor, uses only a tunnel this process runs", async () => {
    writeStatus({ supervisorPid: await deadPid(), shareUrl: "https://left-over.trycloudflare.com", tunnelPid: await deadPid() });
    expect(getShareTunnelAddress().kind).toBe("none");
    tunnelState.childProcess = { pid: process.pid };
    tunnelState.url = "https://own-child.trycloudflare.com";
    resetShareAddressCache();
    expect(getShareTunnelAddress()).toEqual({ kind: "quick", url: "https://own-child.trycloudflare.com", warning: null, via: "ppm" });
  });

  it("caches the tunnel for a few seconds", () => {
    const now = Date.now();
    writeStatus({ supervisorPid: process.pid, shareUrl: "https://one.trycloudflare.com", tunnelPid: process.pid });
    expect(getShareTunnelAddress(now).url).toBe("https://one.trycloudflare.com");
    writeStatus({ supervisorPid: process.pid, shareUrl: "https://two.trycloudflare.com", tunnelPid: process.pid });
    expect(getShareTunnelAddress(now + ADDRESS_CACHE_MS - 1).url).toBe("https://one.trycloudflare.com");
    expect(getShareTunnelAddress(now + ADDRESS_CACHE_MS).url).toBe("https://two.trycloudflare.com");
  });


  it("reads it fresh for the owner's dialog, and caches what it read", () => {
    writeStatus({ supervisorPid: process.pid, shareUrl: "https://one.trycloudflare.com", tunnelPid: process.pid });
    expect(getShareTunnelAddress().url).toBe("https://one.trycloudflare.com");
    writeStatus({ supervisorPid: process.pid, shareUrl: "https://two.trycloudflare.com", tunnelPid: process.pid });
    expect(getShareAddress().url).toBe("https://two.trycloudflare.com");
    expect(getShareTunnelAddress().url).toBe("https://two.trycloudflare.com");
  });
  it("reads the sign-in state live", () => {
    const previous = { ...configService.get("auth") };
    try {
      configService.set("auth", { ...previous, enabled: true });
      expect(getShareAddress()).toMatchObject({ kind: "none", authEnabled: true, enabled: true });
      configService.set("auth", { ...previous, enabled: false });
      expect(getShareAddress().authEnabled).toBe(false);
    } finally {
      configService.set("auth", previous);
    }
  });

  describe("with the review address on", () => {
    const PPM_UP = {
      supervisorPid: process.pid, capabilities: ["retunnel", "reshare"],
      shareUrl: "https://ppm.example.com", tunnelPid: process.pid, tunnelMode: "named",
    };
    const NAMED_SHARE = {
      enabled: true, mode: "named" as const, hostname: "share.example.com", tunnelName: "ppm-share-x",
      token: "t".repeat(120), zoneID: "a".repeat(32), accountID: "b".repeat(32),
    };

    it("is the review address, never PPM's own link, while it is connected", () => {
      configService.set("share_host", { enabled: true, mode: "quick" });
      writeStatus({
        ...PPM_UP, shareHostPid: process.pid, shareHostTunnelPid: process.pid, shareHostUrl: "https://calm-lake-3.trycloudflare.com",
      });
      expect(getShareTunnelAddress()).toEqual({
        kind: "quick", url: "https://calm-lake-3.trycloudflare.com", warning: null, via: "share-host",
      });
      expect(getForwardedShareHosts().sort()).toEqual(["calm-lake-3.trycloudflare.com", "ppm.example.com"]);
    });

    it("keeps a domain while it reconnects, saying it is not connected", async () => {
      configService.set("share_host", NAMED_SHARE);
      writeStatus({ ...PPM_UP, shareHostPid: process.pid, shareHostTunnelPid: await deadPid(), shareHostUrl: "https://share.example.com" });
      expect(getShareTunnelAddress()).toEqual({
        kind: "named", url: "https://share.example.com", warning: SHARE_HOST_NOT_CONNECTED, via: "share-host",
      });
    });

    it("has no address while a temporary one is not up, rather than falling back to PPM's link", () => {
      configService.set("share_host", { enabled: true, mode: "quick" });
      writeStatus({ ...PPM_UP, shareHostPid: process.pid, shareHostTunnelPid: null, shareHostUrl: null, shareHostWarning: "starting" });
      expect(getShareTunnelAddress()).toEqual({ kind: "none", url: null, warning: "starting", via: "share-host" });
      // PPM's link still reaches PPM, so its host still counts as one of this machine's tunnels.
      expect(getForwardedShareHosts()).toEqual(["ppm.example.com"]);
    });

    it("says a supervisor from before review addresses will not bring it up, rather than \"reconnecting\"", async () => {
      configService.set("share_host", NAMED_SHARE);
      writeStatus({ ...PPM_UP, capabilities: ["retunnel"] });
      expect(getShareTunnelAddress()).toEqual({
        kind: "named", url: "https://share.example.com", warning: OUTDATED_SUPERVISOR_MESSAGE, via: "share-host",
      });
      resetShareAddressCache();
      configService.set("share_host", { enabled: true, mode: "quick" });
      expect(getShareTunnelAddress()).toEqual({ kind: "none", url: null, warning: OUTDATED_SUPERVISOR_MESSAGE, via: "share-host" });
    });

    it("says nothing runs it without a supervisor", () => {
      configService.set("share_host", { enabled: true, mode: "quick" });
      expect(getShareTunnelAddress()).toEqual({ kind: "none", url: null, warning: NOT_SUPERVISED_MESSAGE, via: "share-host" });
    });

    it("is PPM's own link again once switched off", () => {
      configService.set("share_host", { ...NAMED_SHARE, enabled: false });
      writeStatus({ ...PPM_UP, shareHostPid: process.pid, shareHostTunnelPid: process.pid, shareHostUrl: "https://share.example.com" });
      expect(getShareTunnelAddress()).toEqual({ kind: "named", url: "https://ppm.example.com", warning: null, via: "ppm" });
    });
  });
});
