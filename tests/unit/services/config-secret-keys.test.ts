import { describe, it, expect } from "bun:test";
import {
  SECRET_CONFIG_KEYS,
  isSecretConfigKey,
  redactSecretConfigValue,
} from "../../../src/services/config-secret-keys.ts";

describe("isSecretConfigKey", () => {
  it("flags every key in the denylist", () => {
    for (const key of SECRET_CONFIG_KEYS) expect(isSecretConfigKey(key)).toBe(true);
  });

  it("flags a dotted descendant of a secret key", () => {
    expect(isSecretConfigKey("tunnel.namedTunnelToken.raw")).toBe(true);
  });

  it("does not flag an unrelated key", () => {
    expect(isSecretConfigKey("tunnel.mode")).toBe(false);
  });

  it("does not flag a key that merely shares a prefix string", () => {
    // "auth.tokenExpiry" must not match "auth.token" via a bare startsWith
    // without the trailing dot separator.
    expect(isSecretConfigKey("auth.tokenExpiry")).toBe(false);
  });
});

describe("redactSecretConfigValue", () => {
  it("masks a leaf secret value requested directly", () => {
    expect(redactSecretConfigValue("tunnel.namedTunnelToken", "abc123")).toBe("[REDACTED]");
    expect(redactSecretConfigValue("auth.token", "s3cr3t")).toBe("[REDACTED]");
  });

  it("masks the secret leaf inside an ANCESTOR object result, keeping siblings intact", () => {
    // This is the case a bare isSecretConfigKey(key) check misses: "tunnel" is
    // not itself in the denylist, only "tunnel.namedTunnelToken" is.
    const tunnel = { mode: "named", hostname: "ppm.example.com", namedTunnelToken: "abc123" };
    const result = redactSecretConfigValue("tunnel", tunnel) as Record<string, unknown>;
    expect(result.namedTunnelToken).toBe("[REDACTED]");
    expect(result.mode).toBe("named");
    expect(result.hostname).toBe("ppm.example.com");
  });

  it("masks the secret leaf inside the root config object (no key prefix)", () => {
    const all = { auth: { enabled: true, token: "s3cr3t" }, tunnel: { mode: "quick" } };
    const result = redactSecretConfigValue("", all) as any;
    expect(result.auth.token).toBe("[REDACTED]");
    expect(result.auth.enabled).toBe(true);
    expect(result.tunnel.mode).toBe("quick");
  });

  it("never deletes the secret key — it stays present, masked", () => {
    const auth = { token: "s3cr3t" };
    const result = redactSecretConfigValue("auth", auth) as Record<string, unknown>;
    expect("token" in result).toBe(true);
    expect(result.token).not.toBe("s3cr3t");
  });

  it("passes an unrelated value through unchanged", () => {
    expect(redactSecretConfigValue("tunnel.mode", "quick")).toBe("quick");
  });
});
