import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { rmSync } from "node:fs";
import { STATUS_FILE, writeStatus } from "../../../src/services/supervisor-state.ts";
import { tunnelService } from "../../../src/services/tunnel.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import {
  ADDRESS_CACHE_MS, getShareAddress, getShareTunnelAddress, resetShareAddressCache,
} from "../../../src/services/design/share/design-share-address.ts";

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
  });

  it("is none when the supervisor nulled shareUrl, though getTunnelUrl() still holds the old one", () => {
    tunnelState.url = "https://stale-name.trycloudflare.com";
    writeStatus({ supervisorPid: process.pid, shareUrl: null, tunnelPid: null, tunnelMode: "quick" });
    expect(tunnelService.getTunnelUrl()).toBe("https://stale-name.trycloudflare.com");
    expect(getShareTunnelAddress()).toEqual({ kind: "none", url: null, warning: null });
  });

  it("names the named tunnel, passing its warning through", () => {
    writeStatus({
      supervisorPid: process.pid, shareUrl: "https://ppm.example.com/", tunnelPid: process.pid,
      tunnelMode: "named", tunnelWarning: "Named tunnel is not connected",
    });
    expect(getShareTunnelAddress()).toEqual({ kind: "named", url: "https://ppm.example.com", warning: "Named tunnel is not connected" });
  });

  it("reports a quick tunnel, and none once its process has died", async () => {
    writeStatus({ supervisorPid: process.pid, shareUrl: "https://abc-def.trycloudflare.com", tunnelPid: process.pid, tunnelMode: "quick" });
    expect(getShareTunnelAddress()).toEqual({ kind: "quick", url: "https://abc-def.trycloudflare.com", warning: null });
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
    expect(getShareTunnelAddress()).toEqual({ kind: "quick", url: "https://own-child.trycloudflare.com", warning: null });
  });

  it("caches the tunnel for a few seconds", () => {
    const now = Date.now();
    writeStatus({ supervisorPid: process.pid, shareUrl: "https://one.trycloudflare.com", tunnelPid: process.pid });
    expect(getShareTunnelAddress(now).url).toBe("https://one.trycloudflare.com");
    writeStatus({ supervisorPid: process.pid, shareUrl: "https://two.trycloudflare.com", tunnelPid: process.pid });
    expect(getShareTunnelAddress(now + ADDRESS_CACHE_MS - 1).url).toBe("https://one.trycloudflare.com");
    expect(getShareTunnelAddress(now + ADDRESS_CACHE_MS).url).toBe("https://two.trycloudflare.com");
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
});
