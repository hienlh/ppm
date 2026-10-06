import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { getLocalIp } from "../../../src/lib/network-utils.ts";
import { notificationLink } from "../../../src/services/notification-link.ts";
import { ppmPublicPort, tailscaleAppService } from "../../../src/services/tailscale/tailscale-app-service.ts";
import { tunnelService } from "../../../src/services/tunnel.service.ts";
import type { TailscaleSetupState } from "../../../src/shared/tailscale-setup.ts";

const originals = { readState: tailscaleAppService.readState, getTunnelUrl: tunnelService.getTunnelUrl };
afterAll(() => {
  tailscaleAppService.readState = originals.readState;
  tunnelService.getTunnelUrl = originals.getTunnelUrl;
});

const payload = { project: "ppm", sessionId: "s1", providerId: "codex" };
const chatPath = "/project/ppm?openChat=codex%2Fs1";

const tailscale = (over: { enabled?: boolean; approved?: boolean; pointsAtPpm?: boolean } = {}): TailscaleSetupState => ({
  installed: true, backendState: "Running", canManage: true, osUser: "dev", platform: "linux",
  tailnet: "user@example.com", dnsSuffix: "tail1234.ts.net", magicDns: true, httpsCertificates: true,
  device: { name: "devbox", dnsName: "devbox.tail1234.ts.net", ips: ["100.64.0.7"], tags: ["tag:server"] },
  service: {
    name: "ppm", url: "https://ppm.tail1234.ts.net/", defined: true, approved: over.approved ?? true,
    advertised: true, target: "http://127.0.0.1:8080", pointsAtPpm: over.pointsAtPpm ?? true,
  },
  enabled: over.enabled ?? true, ppmPort: 8080,
});

let tunnelUrl: string | null;
let state: TailscaleSetupState | Error;
let tailscaleAsked: number;

beforeEach(() => {
  tunnelUrl = null;
  state = new Error("tailscale is not installed");
  tailscaleAsked = 0;
  tunnelService.getTunnelUrl = () => tunnelUrl;
  tailscaleAppService.readState = async () => {
    tailscaleAsked++;
    if (state instanceof Error) throw state;
    return state;
  };
});

describe("notificationLink", () => {
  it("prefers the tunnel, which reaches PPM from anywhere", async () => {
    tunnelUrl = "https://quiet-river.trycloudflare.com";
    state = tailscale();
    expect(await notificationLink(payload)).toBe(`https://quiet-river.trycloudflare.com${chatPath}`);
    expect(tailscaleAsked).toBe(0);
  });

  it("uses PPM's Tailscale address when the service serves PPM", async () => {
    state = tailscale();
    expect(await notificationLink(payload)).toBe(`https://ppm.tail1234.ts.net${chatPath}`);
  });

  it.each([
    ["the switch is off", { enabled: false }],
    ["the host is not approved yet", { approved: false }],
    ["the service points somewhere else", { pointsAtPpm: false }],
  ])("falls back to localhost when %s", async (_why, over) => {
    state = tailscale(over);
    expect(await notificationLink(payload)).toBe(`http://localhost:${ppmPublicPort()}${chatPath}`);
  });

  it("falls back to localhost, never the LAN address, when there is neither", async () => {
    const link = await notificationLink(payload);
    expect(link).toBe(`http://localhost:${ppmPublicPort()}${chatPath}`);
    const lanIp = getLocalIp();
    if (lanIp) expect(link).not.toContain(lanIp);
  });
});
