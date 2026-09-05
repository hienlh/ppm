import { describe, it, expect } from "bun:test";
import {
  sanitizeConfig,
  validateDefaultProvider,
  type PpmConfig,
  DEFAULT_CONFIG,
} from "../../src/types/config.ts";

/** Helper: create a minimal valid PpmConfig for testing */
function makeConfig(overrides: Partial<PpmConfig> = {}): PpmConfig {
  return structuredClone({ ...DEFAULT_CONFIG, ...overrides });
}

describe("sanitizeConfig — multi-provider", () => {
  it("returns false for a valid default config", () => {
    const config = makeConfig();
    expect(sanitizeConfig(config)).toBe(false);
  });

  it("fixes invalid default_provider to claude", () => {
    const config = makeConfig();
    config.ai.default_provider = "nonexistent";
    const dirty = sanitizeConfig(config);
    expect(dirty).toBe(true);
    expect(config.ai.default_provider).toBe("claude");
  });

  it("accepts cursor as valid default_provider", () => {
    const config = makeConfig();
    config.ai.default_provider = "cursor";
    config.ai.providers.cursor = { type: "cli", cli_command: "cursor-agent" };
    const dirty = sanitizeConfig(config);
    // cursor is in VALID_PROVIDERS, so no correction needed for that field
    expect(config.ai.default_provider).toBe("cursor");
  });

  it("ensures default provider has a config entry", () => {
    const config = makeConfig();
    // Remove the claude provider config
    delete config.ai.providers.claude;
    const dirty = sanitizeConfig(config);
    expect(dirty).toBe(true);
    // Should recreate claude config entry
    expect(config.ai.providers.claude).toBeDefined();
    expect(config.ai.providers.claude.type).toBe("agent-sdk");
  });

  it("preserves max effort", () => {
    const config = makeConfig();
    (config.ai.providers.claude as any).effort = "max";
    sanitizeConfig(config);
    expect(config.ai.providers.claude.effort).toBe("max");
  });

  it("does not modify valid effort values", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const config = makeConfig();
      config.ai.providers.claude.effort = effort;
      sanitizeConfig(config);
      expect(config.ai.providers.claude.effort).toBe(effort);
    }
  });

  it("fixes invalid permission_mode to bypassPermissions", () => {
    const config = makeConfig();
    (config.ai.providers.claude as any).permission_mode = "invalidMode";
    const dirty = sanitizeConfig(config);
    expect(dirty).toBe(true);
    expect(config.ai.providers.claude.permission_mode).toBe("bypassPermissions");
  });

  it("preserves valid permission_mode values", () => {
    for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"] as const) {
      const config = makeConfig();
      config.ai.providers.claude.permission_mode = mode;
      const dirty = sanitizeConfig(config);
      expect(config.ai.providers.claude.permission_mode).toBe(mode);
    }
  });

  it("migrates a legacy string theme to the {style, mode} object", () => {
    const config = makeConfig();
    (config as any).theme = "neon"; // invalid legacy string
    const dirty = sanitizeConfig(config);
    expect(dirty).toBe(true);
    expect(config.theme).toEqual({ style: "aurora", mode: "system" });
  });

  it("migrates legacy 'dark' string to {aurora, dark}", () => {
    const config = makeConfig();
    (config as any).theme = "dark";
    const dirty = sanitizeConfig(config);
    expect(dirty).toBe(true);
    expect(config.theme).toEqual({ style: "aurora", mode: "dark" });
  });

  it("handles config with multiple providers (cursor + claude)", () => {
    const config = makeConfig();
    config.ai.providers.cursor = {
      type: "cli",
      cli_command: "cursor-agent",
      permission_mode: "bypassPermissions",
    };
    const dirty = sanitizeConfig(config);
    // Both providers should survive sanitization
    expect(config.ai.providers.claude).toBeDefined();
    expect(config.ai.providers.cursor).toBeDefined();
  });

  it("preserves max effort in CLI provider too", () => {
    const config = makeConfig();
    config.ai.providers.cursor = {
      type: "cli",
      cli_command: "cursor-agent",
      effort: "max" as any,
    };
    sanitizeConfig(config);
    expect(config.ai.providers.cursor.effort).toBe("max");
  });
});

describe("sanitizeConfig — tunnel", () => {
  it("returns false for the default {mode:'quick'} tunnel row", () => {
    const config = makeConfig();
    expect(sanitizeConfig(config)).toBe(false);
  });

  it("leaves an incomplete-but-typed named row unchanged — no strip", () => {
    const config = makeConfig();
    config.tunnel = { mode: "quick", namedTunnelHostname: "ppm.x", namedTunnelToken: "t" } as any;
    const dirty = sanitizeConfig(config);
    expect(dirty).toBe(false);
    expect(config.tunnel).toEqual({ mode: "quick", namedTunnelHostname: "ppm.x", namedTunnelToken: "t" });
  });

  it("resets tunnel to default when the raw value is not an object", () => {
    const config = makeConfig();
    (config as any).tunnel = "not-an-object";
    const dirty = sanitizeConfig(config);
    expect(dirty).toBe(true);
    expect(config.tunnel).toEqual({ mode: "quick" });
  });

  it("resets tunnel to default when mode is neither quick nor named", () => {
    const config = makeConfig();
    (config as any).tunnel = { mode: "bogus" };
    const dirty = sanitizeConfig(config);
    expect(dirty).toBe(true);
    expect(config.tunnel).toEqual({ mode: "quick" });
  });

  it("preserves a fully-populated named tunnel row", () => {
    const config = makeConfig();
    config.tunnel = {
      mode: "named", namedTunnelName: "ppm-host", namedTunnelHostname: "ppm.hienle.tech",
      namedTunnelToken: "tok", zoneID: "a".repeat(32), accountID: "b".repeat(32),
    };
    const dirty = sanitizeConfig(config);
    expect(dirty).toBe(false);
    expect(config.tunnel.namedTunnelToken).toBe("tok");
  });
});

describe("validateDefaultProvider", () => {
  it("returns null when provider exists", () => {
    const result = validateDefaultProvider("claude", { claude: {} });
    expect(result).toBeNull();
  });

  it("returns error when provider does not exist", () => {
    const result = validateDefaultProvider("cursor", { claude: {} });
    expect(result).not.toBeNull();
    expect(result).toContain("cursor");
    expect(result).toContain("not found");
  });

  it("accepts any string key that exists in providers", () => {
    const result = validateDefaultProvider("custom", { custom: { type: "cli" } });
    expect(result).toBeNull();
  });
});
