import { describe, expect, it } from "bun:test";
import { normalizeVoiceConfig } from "../../../../src/services/voice-message/voice-settings.ts";
import { composeVoiceWords, looksLikePromptEcho, whisperPromptPreview } from "../../../../src/services/voice-message/voice-vocabulary.ts";
import type { RankedTerm } from "../../../../src/services/voice-message/voice-auto-vocabulary.ts";

const AT = "2026-11-20T10:00:00.000Z";
const config = normalizeVoiceConfig({
  enabled: true, self_learning: true, words: ["Bun"],
  projects: {
    ppm: {
      words: ["Hono"],
      learned: [
        { word: "PPM", from: "BPM", at: AT, source: "cleanup", hits: 3, kind: "term" },
        { word: "ra lệnh", from: "ta lệnh", at: AT, source: "cleanup", hits: 3, kind: "phrase" },
      ],
    },
    nxsys: { words: ["Paye"], learned: [{ word: "HMRC", from: "HM RC", at: AT, source: "cleanup", hits: 2, kind: "term" }] },
  },
});
const auto: RankedTerm[] = [
  { term: "ppm/53", score: 6, strong: true },
  { term: "worktree", score: 1, strong: false },
];

describe("composeVoiceWords", () => {
  it("leads Whisper with the user's own words, keeps phrases and weak words to the clean-up", () => {
    const lists = composeVoiceWords(config, "ppm", { selfLearning: true, auto });
    expect(lists.whisper).toEqual(["Hono", "PPM", "Bun", "ppm/53"]);
    expect(lists.cleanup).toEqual(["Hono", "PPM", "Bun", "ppm/53", "worktree"]);
    expect(lists.corrections).toEqual([{ heard: "BPM", meant: "PPM" }, { heard: "ta lệnh", meant: "ra lệnh" }]);
  });

  it("never gives one project another project's words", () => {
    const lists = composeVoiceWords(config, "ppm", { selfLearning: true, auto });
    expect([...lists.whisper, ...lists.cleanup]).not.toContain("HMRC");
    expect([...lists.whisper, ...lists.cleanup]).not.toContain("Paye");
  });

  it("gives the Assistant every project's learned terms", () => {
    const lists = composeVoiceWords(config, "__assistant__", { selfLearning: true, auto: [] });
    expect(lists.whisper).toEqual(expect.arrayContaining(["PPM", "HMRC"]));
    expect(lists.whisper).not.toContain("ra lệnh");
  });

  it("with self-learning off adds nothing picked up, pauses what the clean-up taught, and passes no corrections", () => {
    const lists = composeVoiceWords(config, "ppm", { selfLearning: false, auto });
    expect(lists.whisper).toEqual(["Hono", "Bun"]);
    expect(lists.cleanup).toEqual(["Hono", "Bun"]);
    expect(lists.corrections).toEqual([]);
  });

  it("caps task codes in Whisper's prompt", () => {
    const codes = Array.from({ length: 14 }, (_, i): RankedTerm => ({ term: `ppm/${i}`, score: 1, strong: true }));
    const lists = composeVoiceWords(normalizeVoiceConfig({}), "ppm", { selfLearning: true, auto: codes });
    expect(lists.whisper).toHaveLength(10);
  });

  it("the preview says where each word came from", () => {
    expect(whisperPromptPreview(config, "ppm", { selfLearning: true, auto })).toEqual([
      { word: "Hono", source: "typed" }, { word: "PPM", source: "learned" }, { word: "Bun", source: "typed" }, { word: "ppm/53", source: "picked" },
    ]);
  });
});

describe("looksLikePromptEcho", () => {
  const prompt = ["PPM", "Hono", "Telegram", "Whisper", "ppm/53"];
  it("catches Whisper writing its word list back", () => {
    expect(looksLikePromptEcho("PPM, Hono, Telegram, Whisper, ppm/53.", prompt)).toBe(true);
  });
  it("leaves real speech alone, commas and all", () => {
    expect(looksLikePromptEcho("Anh nói PPM, Hono và Telegram, rồi deploy, nhé", prompt)).toBe(false);
    expect(looksLikePromptEcho("PPM, Hono", prompt)).toBe(false);
    // Listing the project's names is a normal thing to say: not the prompt read back.
    expect(looksLikePromptEcho("Dùng PPM, TypeScript, WebSocket, Hono.", ["PPM", "Hono", "TypeScript", "WebSocket"])).toBe(false);
    expect(looksLikePromptEcho("Hono, PPM, Telegram, Whisper, ppm/53", prompt)).toBe(false);
  });
});
