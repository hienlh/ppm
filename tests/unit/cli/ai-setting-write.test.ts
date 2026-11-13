/**
 * `ppm ai set`: a provider's API key is never written from a command line, the settings that
 * decide what PPM runs are refused from an AI chat (and allowed for a person), and the PUT body
 * carries only the one setting, typed as it is stored.
 */
import { describe, expect, it } from "bun:test";
import { aiSettingRefusal, planAiSettingWrite } from "../../../src/cli/utils/ai-setting-write.ts";

const current = {
  default_provider: "claude",
  share_provider_context: true,
  session_collab: { max_open_sessions: 4 },
  providers: { claude: { type: "agent-sdk", model: "claude-opus-5-5", max_turns: 100, api_key: "[REDACTED]" }, codex: { type: "cli" } },
};
const person = { aiChat: false };
const aiChat = { aiChat: true };

describe("aiSettingRefusal", () => {
  it("refuses a provider's API key for everyone", () => {
    for (const caller of [person, aiChat]) {
      expect(aiSettingRefusal("providers.claude.api_key", caller)).toContain("is a secret");
      expect(aiSettingRefusal("ai.providers.codex.api_key", caller)).toContain("is a secret");
    }
  });

  it("refuses what decides what PPM runs from an AI chat only", () => {
    for (const key of [
      "providers.claude.cli_command", "providers.claude.base_url", "providers.claude.api_key_env",
      "providers.codex.permission_mode", "ppm_tools.open_url", "tab_tools",
    ]) {
      expect({ key, refusal: aiSettingRefusal(key, aiChat) }).toEqual({ key, refusal: expect.stringContaining("refused here from an AI chat") });
      expect({ key, refusal: aiSettingRefusal(key, person) }).toEqual({ key, refusal: null });
    }
  });

  it("lets an AI chat change a plain preference", () => {
    expect(aiSettingRefusal("default_provider", aiChat)).toBeNull();
    expect(aiSettingRefusal("providers.claude.model", aiChat)).toBeNull();
  });
});

describe("planAiSettingWrite", () => {
  it("sends only the one setting, typed as stored", () => {
    expect(planAiSettingWrite("default_provider", "codex", current, person)).toEqual({ ok: true, body: { default_provider: "codex" }, value: "codex" });
    expect(planAiSettingWrite("ai.share_provider_context", "false", current, person)).toEqual({ ok: true, body: { share_provider_context: false }, value: false });
    expect(planAiSettingWrite("providers.claude.max_turns", "50", current, person)).toEqual({ ok: true, body: { providers: { claude: { max_turns: 50 } } }, value: 50 });
    expect(planAiSettingWrite("providers.codex.effort", "high", current, person)).toEqual({ ok: true, body: { providers: { codex: { effort: "high" } } }, value: "high" });
    expect(planAiSettingWrite("ppm_tools.open_url", "false", current, person)).toEqual({ ok: true, body: { ppm_tools: { open_url: false } }, value: false });
    expect(planAiSettingWrite("session_collab.max_open_sessions", "6", current, person)).toEqual({ ok: true, body: { session_collab: { max_open_sessions: 6 } }, value: 6 });
  });

  it("says what is wrong with a value, a provider or a key", () => {
    const error = (key: string, value: string) => {
      const plan = planAiSettingWrite(key, value, current, person);
      return plan.ok ? null : plan.error;
    };
    expect(error("providers.claude.max_turns", "many")).toContain("expects a number");
    expect(error("providers.gemini.model", "x")).toContain('No provider "gemini"');
    expect(error("providers.claude.colour", "x")).toContain("is not a provider setting");
    expect(error("ppm_tools.launch_rockets", "true")).toContain("is not one of PPM's tools");
    expect(error("providers", "x")).toContain("is not an AI setting");
    expect(error("providers.claude", "x")).toContain("is not an AI setting");
  });

  it("refuses a secret or, from an AI chat, an exposure key before planning anything", () => {
    expect(planAiSettingWrite("providers.claude.api_key", "sk-x", current, person).ok).toBe(false);
    expect(planAiSettingWrite("providers.claude.cli_command", "sh", current, aiChat).ok).toBe(false);
    expect(planAiSettingWrite("providers.claude.cli_command", "claude", current, person)).toEqual({ ok: true, body: { providers: { claude: { cli_command: "claude" } } }, value: "claude" });
  });
});
