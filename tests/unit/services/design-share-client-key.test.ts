import { afterEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { clientKeyDeps, isLoopbackAddress, shareClientKey } from "../../../src/services/design/share/design-share-client-key.ts";
import {
  MAX_CLIENT_KEYS, resetShareRateLimits, shareLimiterSizes, takeShareRead, takeShareWrite,
} from "../../../src/services/design/share/design-share-rate-limit.ts";

const req = new Request("http://localhost/s/x");
const server = (address: string) => ({ requestIP: () => ({ address, family: "IPv4", port: 1 }) });
const realTunnelUrl = clientKeyDeps.tunnelUrl;

describe("share client key", () => {
  afterEach(() => {
    clientKeyDeps.tunnelUrl = realTunnelUrl;
    resetShareRateLimits();
  });

  it("trusts CF-Connecting-IP only from loopback with the tunnel's own Host", () => {
    clientKeyDeps.tunnelUrl = () => "https://review.example.com";
    const base = { req, env: server("127.0.0.1"), host: "Review.Example.com", cfConnectingIp: "203.0.113.9" };
    expect(shareClientKey(base)).toBe("cf:203.0.113.9");
    expect(shareClientKey({ ...base, env: server("::1") })).toBe("cf:203.0.113.9");
    expect(shareClientKey({ ...base, env: server("::ffff:127.0.0.1") })).toBe("cf:203.0.113.9");
  });

  it("ignores the header under a spoofed Host, from a LAN peer, or when it is not an address", () => {
    clientKeyDeps.tunnelUrl = () => "https://review.example.com";
    const base = { req, env: server("127.0.0.1"), host: "review.example.com", cfConnectingIp: "203.0.113.9" };
    expect(shareClientKey({ ...base, host: "evil.example.com" })).toBe("local");
    expect(shareClientKey({ ...base, host: undefined })).toBe("local");
    expect(shareClientKey({ ...base, cfConnectingIp: "not-an-ip" })).toBe("local");
    expect(shareClientKey({ ...base, env: server("192.168.1.20") })).toBe("ip:192.168.1.20");
    clientKeyDeps.tunnelUrl = () => null;
    expect(shareClientKey(base)).toBe("local");
  });

  it("keys a request with no server (no c.env) as local", () => {
    expect(shareClientKey({ req, env: undefined, host: "x", cfConnectingIp: "203.0.113.9" })).toBe("local");
    expect(shareClientKey({ req, env: { requestIP: () => { throw new Error("closed"); } }, host: "x", cfConnectingIp: undefined })).toBe("local");
  });

  it("recognises loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.8.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("::ffff:10.0.0.1")).toBe(false);
  });

  it("caps writes per link whatever client keys the writers present", () => {
    for (let i = 0; i < 30; i++) expect(takeShareWrite(`cf:203.0.113.${i}`, "abcdef012345")).toBe(0);
    expect(takeShareWrite("cf:203.0.113.200", "abcdef012345")).toBeGreaterThan(0);
    // The refused write was not counted against its client.
    expect(takeShareWrite("cf:203.0.113.200", "0123456789ab")).toBe(0);
  });

  it("keeps the budget maps bounded however many keys a forger mints", () => {
    for (let i = 0; i < MAX_CLIENT_KEYS + 500; i++) takeShareRead("api", `cf:198.51.${i >> 8}.${i & 255}`);
    expect(shareLimiterSizes().api).toBe(MAX_CLIENT_KEYS);
  });
});
