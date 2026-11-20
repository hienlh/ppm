/**
 * The voice clean-up's Haiku call: thinking off (with it on, Haiku thought for ~32 s before tidying
 * one sentence and the clean-up timed out), a wait long enough for a slow API moment, and the raw
 * transcript when even that runs out.
 */
import { describe, expect, it } from "bun:test";
import { CLEANUP_TIMEOUT_MS, cleanupTranscript } from "../../../../src/services/voice-message/voice-cleanup.ts";
import { voiceHaikuCall, withTimeout } from "../../../../src/services/voice-message/voice-haiku.ts";
import { LOGS_AI_MODEL } from "../../../../src/services/logs/log-ai.ts";

const EMPTY_CONTEXT = { recentMessages: [], typed: "", instructions: "", memory: "", fileNames: [], words: [] };

describe("the voice Haiku call", () => {
  it("asks Claude Haiku with thinking off", () => {
    expect(voiceHaikuCall({ prompt: "p", systemPrompt: "s", timeoutMs: 1000 })).toEqual({
      prompt: "p", systemPrompt: "s", timeoutMs: 1000, model: LOGS_AI_MODEL, noThinking: true,
    });
  });

  it("waits 45 s for the clean-up and hands that wait to the call", async () => {
    expect(CLEANUP_TIMEOUT_MS).toBe(45_000);
    let seen = 0;
    const result = await cleanupTranscript("ok hô nô", EMPTY_CONTEXT, async (input) => {
      seen = input.timeoutMs;
      return JSON.stringify({ text: "OK, Hono." });
    });
    expect(seen).toBe(45_000);
    expect(result).toEqual({ ok: true, text: "OK, Hono." });
  });

  it("falls back to the raw transcript with the reason when the wait runs out", async () => {
    const never = () => new Promise<string>(() => {});
    const result = await cleanupTranscript("ok hô nô", EMPTY_CONTEXT, never, 30);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("did not answer within");
  });

  it("names the wait in seconds when it gives up", async () => {
    await expect(withTimeout(new Promise(() => {}), 1_000)).rejects.toThrow("Claude Haiku did not answer within 1 s");
  });
});
