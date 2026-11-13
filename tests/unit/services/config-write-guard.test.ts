/**
 * Which keys `config set` and `PUT /api/settings/config-key` may write: secrets never, keys with
 * routes of their own never, exposure keys only for a person, plain preferences always — typed to
 * the value the key already holds.
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { configKeyTier, configWriteRefusal, prepareConfigWrite } from "../../../src/services/config-write-guard.ts";
import { isSecretConfigKey, redactSecretConfigValue } from "../../../src/services/config-secret-keys.ts";
import { DEFAULT_CONFIG } from "../../../src/types/config.ts";

const current = () => structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
const person = { aiChat: false };
const ai = { aiChat: true };

describe("tiers", () => {
  it("sorts keys into secret, dedicated, exposure, allowed and unknown", () => {
    expect(configKeyTier("auth.token")).toBe("secret");
    expect(configKeyTier("ai.providers.claude.api_key")).toBe("secret");
    expect(configKeyTier("ai.providers.codex.api_key")).toBe("secret");
    expect(configKeyTier("ntfy.token")).toBe("secret");
    expect(configKeyTier("theme.mode")).toBe("dedicated");
    expect(configKeyTier("ai.providers.claude.model")).toBe("dedicated");
    expect(configKeyTier("ntfy.server")).toBe("dedicated");
    expect(configKeyTier("telegram.bot_username")).toBe("dedicated");
    expect(configKeyTier("host")).toBe("exposure");
    expect(configKeyTier("auth.enabled")).toBe("exposure");
    expect(configKeyTier("tunnel.enabled")).toBe("exposure");
    expect(configKeyTier("ai.ppm_tools")).toBe("exposure");
    expect(configKeyTier("log_level")).toBe("allowed");
    expect(configKeyTier("ai.default_provider")).toBe("allowed");
    expect(configKeyTier("feature_intros")).toBe("unknown");
  });

  it("treats every provider's api_key as a secret, in redaction too", () => {
    expect(isSecretConfigKey("ai.providers.anything.api_key")).toBe(true);
    expect(isSecretConfigKey("ai.providers.claude.api_key_env")).toBe(false);
    const shown = redactSecretConfigValue("ai", { providers: { claude: { api_key: "sk-1", model: "m" } } }) as any;
    expect(shown.providers.claude).toEqual({ api_key: "[REDACTED]", model: "m" });
  });
});

describe("configWriteRefusal", () => {
  it("refuses a secret to everyone", () => {
    expect(configWriteRefusal("auth.token", person)).toContain("is a secret");
    expect(configWriteRefusal("ai.providers.claude.api_key", person)).toContain("is a secret");
  });

  it("refuses a dedicated key to everyone and says where to change it", () => {
    expect(configWriteRefusal("ntfy.server", person)).toContain("drops the stored token");
    expect(configWriteRefusal("theme.mode", person)).toContain("Appearance");
  });

  it("points notification, Telegram and PPMBot keys at their own commands", () => {
    expect(configWriteRefusal("ntfy.server", person)).toContain("ppm notify ntfy set");
    expect(configWriteRefusal("notifications.delay_seconds", person)).toContain("ppm notify delay");
    expect(configWriteRefusal("telegram.bot_username", person)).toContain("ppm telegram-bot set --token-prompt");
    expect(configWriteRefusal("clawbot.enabled", person)).toContain("ppm ppmbot set");
  });

  it("refuses an exposure key only from an AI chat", () => {
    expect(configWriteRefusal("host", person)).toBeNull();
    expect(configWriteRefusal("host", ai)).toContain("not changed from an AI chat");
    expect(configWriteRefusal("log_level", ai)).toBeNull();
  });
});

describe("prepareConfigWrite", () => {
  it("types the value to what the key holds", () => {
    const port = prepareConfigWrite("port", "9090", current(), person);
    expect(port).toEqual({ ok: true, topKey: "port", topValue: 9090, value: 9090 });
    const audit = prepareConfigWrite("query_audit.retention_days", "7", current(), person);
    expect(audit.ok && audit.topValue).toEqual({ retention_days: 7, max_size_mb: 500 });
    const share = prepareConfigWrite("ai.share_provider_context", "false", current(), person);
    expect(share.ok && share.value).toBe(false);
  });

  it("checks values and gives the right status", () => {
    expect(prepareConfigWrite("port", "nine", current(), person)).toMatchObject({ ok: false, status: 400 });
    expect(prepareConfigWrite("port", "70000", current(), person)).toMatchObject({ ok: false, status: 400 });
    expect(prepareConfigWrite("log_level", "loud", current(), person)).toMatchObject({ ok: false, status: 400 });
    expect(prepareConfigWrite("ai.default_provider", "nobody", current(), person)).toMatchObject({ ok: false, status: 400 });
    expect(prepareConfigWrite("auth.token", "x", current(), person)).toMatchObject({ ok: false, status: 403 });
    expect(prepareConfigWrite("tunnel", "x", current(), person)).toMatchObject({ ok: false, status: 400 });
  });

  it("normalizes a log level and sets an allowed key that is not stored yet", () => {
    expect(prepareConfigWrite("log_level", "DEBUG", current(), person)).toMatchObject({ ok: true, value: "debug" });
    expect(prepareConfigWrite("ai.leftover_processes_idle_minutes", "30", current(), person)).toMatchObject({ ok: true, value: 30 });
  });

  it("does not change the config it was given", () => {
    const cfg = current();
    prepareConfigWrite("query_audit.retention_days", "7", cfg, person);
    expect((cfg.query_audit as { retention_days: number }).retention_days).toBe(30);
  });
});
