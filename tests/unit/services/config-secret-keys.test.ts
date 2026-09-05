import { describe, it, expect } from "bun:test";
import { SECRET_CONFIG_KEYS, isSecretConfigKey } from "../../../src/services/config-secret-keys.ts";

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
