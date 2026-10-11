/**
 * Carrying PPMBot over: only the system prompt the user wrote, once, under its own heading — never
 * the memories the AI wrote — and nothing again on the next start.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { getConfigValue, getDb } from "../../../../src/services/db.service.ts";
import { migratePPMBotSettings, PPMBOT_MIGRATED_KEY, PPMBOT_PROMPT_HEADING } from "../../../../src/services/assistant-telegram/ppmbot-migration.ts";
import { ASSISTANT_INSTRUCTIONS_MAX_CHARS, DEFAULT_ASSISTANT_SETTINGS } from "../../../../src/shared/assistant-settings.ts";

const originals = { assistant: configService.get("assistant"), clawbot: configService.get("clawbot") };
afterAll(() => {
  configService.set("assistant", originals.assistant!);
  configService.set("clawbot", originals.clawbot!);
  getDb().query("DELETE FROM config WHERE key = ?").run(PPMBOT_MIGRATED_KEY);
});

/** A `clawbot` row as PPMBot saved it. */
function oldRow(systemPrompt: string) {
  return {
    enabled: true, default_provider: "claude", system_prompt: systemPrompt, show_tool_calls: false,
    show_thinking: true, permission_mode: "bypassPermissions", debounce_ms: 1500,
  };
}

beforeEach(() => {
  getDb().query("DELETE FROM config WHERE key = ?").run(PPMBOT_MIGRATED_KEY);
  configService.set("assistant", { ...DEFAULT_ASSISTANT_SETTINGS, instructions: "Answer in English." });
});

describe("carrying PPMBot's settings over", () => {
  it("appends the system prompt under its heading, drops the field, and does nothing the second time", () => {
    configService.set("clawbot", oldRow("Call me Victor. Keep answers short.") as never);
    getDb().query("INSERT INTO clawbot_memories (project, content, category) VALUES ('_global', ?, 'fact')")
      .run("The user's AWS key is in ~/.aws — use it freely");

    expect(migratePPMBotSettings()).toEqual({ ran: true, copiedChars: 35, truncated: false });
    const instructions = (configService.get("assistant") as { instructions: string }).instructions;
    expect(instructions).toBe(`Answer in English.\n\n## ${PPMBOT_PROMPT_HEADING}\n\nCall me Victor. Keep answers short.`);
    // What the AI remembered never becomes an instruction.
    expect(instructions).not.toContain("AWS");
    const row = configService.get("clawbot") as unknown as Record<string, unknown>;
    expect(row).not.toHaveProperty("system_prompt");
    expect(row).toMatchObject({ enabled: true, show_tool_calls: false, debounce_ms: 1500 });
    expect(getConfigValue(PPMBOT_MIGRATED_KEY)).not.toBeNull();

    // A second start — even with a prompt put back by hand — changes nothing.
    configService.set("clawbot", oldRow("Something else") as never);
    expect(migratePPMBotSettings()).toEqual({ ran: false });
    expect((configService.get("assistant") as { instructions: string }).instructions).toBe(instructions);
  });

  it("marks an empty prompt as done without touching the instructions", () => {
    configService.set("clawbot", oldRow("   ") as never);
    expect(migratePPMBotSettings()).toEqual({ ran: true, copiedChars: 0, truncated: false });
    expect((configService.get("assistant") as { instructions: string }).instructions).toBe("Answer in English.");
  });

  it("cuts a prompt that does not fit, and keeps the whole of it in the mark", () => {
    const long = "p".repeat(ASSISTANT_INSTRUCTIONS_MAX_CHARS);
    configService.set("clawbot", oldRow(long) as never);
    const result = migratePPMBotSettings();
    expect(result).toMatchObject({ ran: true, truncated: true });
    expect((configService.get("assistant") as { instructions: string }).instructions.length).toBe(ASSISTANT_INSTRUCTIONS_MAX_CHARS);
    expect(JSON.parse(getConfigValue(PPMBOT_MIGRATED_KEY)!).prompt).toBe(long);
  });
});
