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
      enabled: true,
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

describe("resolveTunnelConfig — master switch", () => {
  // Rows written before the switch existed have no `enabled`, and back then the
  // tunnel was unconditional — so absent has to read as on. Reading it as off
  // would silently take the public URL away from every existing install.
  test("absent `enabled` resolves to on", () => {
    expect(resolveTunnelConfig({}).enabled).toBe(true);
    expect(resolveTunnelConfig({ mode: "quick" }).enabled).toBe(true);
    expect(resolveTunnelConfig(FULL_NAMED).enabled).toBe(true);
  });

  test("explicit `enabled: false` resolves to off in both modes", () => {
    expect(resolveTunnelConfig({ mode: "quick", enabled: false }).enabled).toBe(false);
    expect(resolveTunnelConfig({ ...FULL_NAMED, enabled: false }).enabled).toBe(false);
  });

  // The switch is orthogonal to the mode: turning the tunnel off must not also
  // discard a configured hostname, or turning it back on would need a re-setup.
  test("off does not degrade a named row to quick", () => {
    const resolved = resolveTunnelConfig({ ...FULL_NAMED, enabled: false });
    expect(resolved.mode).toBe("named");
    expect(resolved.hostname).toBe("ppm.hienle.tech");
  });

  test("a non-boolean `enabled` is ignored rather than coerced", () => {
    expect(resolveTunnelConfig({ mode: "quick", enabled: "false" }).enabled).toBe(true);
    expect(resolveTunnelConfig({ mode: "quick", enabled: 0 }).enabled).toBe(true);
  });
});
