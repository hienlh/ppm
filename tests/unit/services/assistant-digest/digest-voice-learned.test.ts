import { describe, expect, it } from "bun:test";
import { isMonday, voiceLearnedThisWeek } from "../../../../src/services/assistant-digest/digest-voice-learned.ts";
import { normalizeVoiceConfig } from "../../../../src/services/voice-message/voice-settings.ts";

const NOW = Date.parse("2026-11-23T08:00:00+07:00"); // a Monday
const config = (over: Record<string, unknown> = {}) => normalizeVoiceConfig({
  enabled: true, self_learning: true,
  projects: {
    ppm: { words: [], learned: [
      { word: "PPM", from: "BPM", at: "2026-11-22T10:00:00.000Z" },
      { word: "Old", from: "old", at: "2026-11-01T10:00:00.000Z" },
    ] },
    __assistant__: { words: [], learned: [{ word: "Hono", from: "Hano", at: "2026-11-21T10:00:00.000Z" }] },
  },
  ...over,
});

describe("voiceLearnedThisWeek", () => {
  it("lists the week's words on Mondays, newest first, naming the Assistant's plainly", () => {
    expect(voiceLearnedThisWeek(config(), "2026-11-23", NOW)).toEqual([
      { word: "PPM", from: "BPM", project: "ppm" },
      { word: "Hono", from: "Hano", project: "PPM Assistant" },
    ]);
  });

  it("lists nothing on other days, with the summary off, or with self-learning off", () => {
    expect(voiceLearnedThisWeek(config(), "2026-11-24", NOW)).toEqual([]);
    expect(voiceLearnedThisWeek(config({ weekly_summary: false }), "2026-11-23", NOW)).toEqual([]);
    expect(voiceLearnedThisWeek(config({ self_learning: false }), "2026-11-23", NOW)).toEqual([]);
  });

  it("isMonday reads the digest's local date", () => {
    expect(isMonday("2026-11-23")).toBe(true);
    expect(isMonday("2026-11-22")).toBe(false);
    expect(isMonday("nope")).toBe(false);
  });
});
