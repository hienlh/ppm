import { describe, test, expect } from "bun:test";
import { resolveTunnelConfig, maskToken } from "../../../../src/services/named-tunnel/named-tunnel-config.ts";

const FULL_NAMED = {
  mode: "named",
  namedTunnelName: "ppm-host",
  namedTunnelHostname: "ppm.hienle.tech",
  namedTunnelToken: "secret-token",
  zoneID: "a".repeat(32),
  accountID: "b".repeat(32),
};

describe("resolveTunnelConfig", () => {
  test("undefined resolves to quick", () => {
    expect(resolveTunnelConfig(undefined).mode).toBe("quick");
  });

  test("{} resolves to quick", () => {
    expect(resolveTunnelConfig({}).mode).toBe("quick");
  });

  test("{mode:'named'} missing every field resolves to quick", () => {
    expect(resolveTunnelConfig({ mode: "named" }).mode).toBe("quick");
  });

  test("{mode:'named'} missing zoneID resolves to quick", () => {
    const { zoneID, ...rest } = FULL_NAMED;
    expect(resolveTunnelConfig(rest).mode).toBe("quick");
  });

  test("fully-populated named row resolves to named with all fields", () => {
    const resolved = resolveTunnelConfig(FULL_NAMED);
    expect(resolved).toEqual({
      mode: "named",
      hostname: "ppm.hienle.tech",
      tunnelName: "ppm-host",
      token: "secret-token",
      zoneID: "a".repeat(32),
      accountID: "b".repeat(32),
      dismissed: false,
    });
  });

  test("accepts a raw JSON string, not just an object", () => {
    expect(resolveTunnelConfig(JSON.stringify(FULL_NAMED)).mode).toBe("named");
  });

  test("mode:'quick' with named fields still present degrades to quick (Retry contract)", () => {
    // /disable keeps namedTunnel* fields for Retry but flips mode back to quick —
    // the resolver must not resurrect a tunnel the user explicitly turned off.
    const resolved = resolveTunnelConfig({ ...FULL_NAMED, mode: "quick" });
    expect(resolved.mode).toBe("quick");
  });

  test("dismissed flag passes through regardless of mode", () => {
    expect(resolveTunnelConfig({ dismissed: true }).dismissed).toBe(true);
    expect(resolveTunnelConfig({ ...FULL_NAMED, dismissed: true }).dismissed).toBe(true);
  });
});

describe("maskToken", () => {
  test("null stays null", () => {
    expect(maskToken(null)).toBeNull();
  });

  test("masks to 6 chars + ellipsis", () => {
    expect(maskToken("abcdefghijklmnop")).toBe("abcdef...");
  });
});
