import { afterEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { isFaded, isStaleCandidate, learnedLastUsed, VOICE_FADE_DAYS, wordUsedIn } from "../../../../src/services/voice-message/voice-learned-fade.ts";
import { markLearnedUse, recordCleanupReplacements } from "../../../../src/services/voice-message/voice-learned-store.ts";
import { normalizeVoiceConfig, projectWordsOf, readVoiceSettings } from "../../../../src/services/voice-message/voice-settings.ts";
import { composeVoiceWords } from "../../../../src/services/voice-message/voice-vocabulary.ts";
import type { LearnedWord } from "../../../../src/shared/voice-message.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-01T10:00:00.000Z");
const at = (days: number) => new Date(T0 + days * DAY);
const iso = (days: number) => at(days).toISOString();
const cleanupWord = (over: Partial<LearnedWord> = {}): LearnedWord =>
  ({ word: "PPM", from: "BPM", at: iso(0), source: "cleanup", hits: 3, kind: "term", ...over });

afterEach(() => configService.set("voice_message", { review_before_send: true, words: [], projects: {} }));

function seed(learned: LearnedWord[], extra: Record<string, unknown> = {}) {
  configService.set("voice_message", {
    enabled: true, self_learning: true, review_before_send: true, words: ["Bun"],
    projects: { ppm: { words: ["Hono"], learned, ...extra } },
  });
}
const own = () => projectWordsOf(readVoiceSettings(), "ppm");

describe("isFaded", () => {
  it(`fades a word the clean-up taught once it has gone unused for ${VOICE_FADE_DAYS} days, and not a moment sooner`, () => {
    const w = cleanupWord();
    expect(isFaded(w, at(VOICE_FADE_DAYS).getTime())).toBe(false);
    expect(isFaded(w, at(VOICE_FADE_DAYS).getTime() + 1)).toBe(true);
  });

  it("counts from the last use, not from when it was learned", () => {
    const w = cleanupWord({ lastUsedAt: iso(20) });
    expect(learnedLastUsed(w)).toBe(iso(20));
    expect(isFaded(w, at(45).getTime())).toBe(false);
    expect(isFaded(w, at(51).getTime())).toBe(true);
  });

  it("never fades a word learned from the user's own edit, nor an entry from before sources existed", () => {
    expect(isFaded(cleanupWord({ source: "edit" }), at(400).getTime())).toBe(false);
    const { source: _s, ...legacy } = cleanupWord();
    expect(isFaded(legacy, at(400).getTime())).toBe(false);
  });

  it("drops a candidate not seen for the same window", () => {
    expect(isStaleCandidate({ from: "BPM", to: "PPM", hits: 2, at: iso(0) }, at(31).getTime())).toBe(true);
    expect(isStaleCandidate({ from: "BPM", to: "PPM", hits: 2, at: iso(0) }, at(29).getTime())).toBe(false);
  });
});

describe("wordUsedIn", () => {
  it("finds the word or phrase whole, whatever its case", () => {
    expect(wordUsedIn("Setting của ppm được.", "PPM")).toBe(true);
    expect(wordUsedIn("anh ra lệnh cho nó", "ra lệnh")).toBe(true);
    expect(wordUsedIn("the PPMX build", "PPM")).toBe(false);
    expect(wordUsedIn("anything", "")).toBe(false);
  });
});

describe("markLearnedUse", () => {
  it("marks a learned word said in the transcript as used, which keeps it past the window", () => {
    seed([cleanupWord()]);
    expect(markLearnedUse("ppm", ["deploy PPM đi"], at(25))).toEqual([]);
    expect(own().learned[0]?.lastUsedAt).toBe(iso(25));
    // Thirty days after learning, but only five after its last use: still there.
    expect(markLearnedUse("ppm", ["không nhắc tới"], at(35))).toEqual([]);
    expect(own().learned.map((l) => l.word)).toEqual(["PPM"]);
  });

  it("drops a word the clean-up taught that nobody said for the window, and answers with it", () => {
    seed([cleanupWord(), cleanupWord({ word: "Hano-fix", from: "x", source: "edit" })]);
    const faded = markLearnedUse("ppm", ["nothing relevant"], at(31));
    expect(faded.map((l) => l.word)).toEqual(["PPM"]);
    // The edit-learned one and the typed words stay; a faded word is not blocked, so it can be learned again.
    expect(own().learned.map((l) => l.word)).toEqual(["Hano-fix"]);
    expect(own().words).toEqual(["Hono"]);
    expect(readVoiceSettings().words).toEqual(["Bun"]);
    expect(own().blocked ?? []).toEqual([]);
  });

  it("drops stale candidates, and writes nothing when nothing changed", () => {
    seed([], { candidates: [{ from: "BPM", to: "PPM", hits: 2, at: iso(0) }] });
    markLearnedUse("ppm", ["x"], at(31));
    expect(own().candidates ?? []).toEqual([]);
    const before = JSON.stringify(configService.get("voice_message"));
    expect(markLearnedUse("ppm", ["x"], at(32))).toEqual([]);
    expect(JSON.stringify(configService.get("voice_message"))).toBe(before);
  });

  it("a word the clean-up fixes again counts as used", () => {
    seed([cleanupWord()]);
    recordCleanupReplacements("ppm", [{ from: "BPM", to: "PPM", kind: "term" }], new Set(), at(28));
    expect(own().learned[0]).toMatchObject({ hits: 4, lastUsedAt: iso(28) });
    expect(markLearnedUse("ppm", ["x"], at(50))).toEqual([]);
  });
});

describe("composeVoiceWords leaves faded words out before they are pruned", () => {
  it("does not hand Whisper or the clean-up a faded word", () => {
    const config = normalizeVoiceConfig({ enabled: true, self_learning: true, projects: { ppm: { words: [], learned: [cleanupWord()] } } });
    expect(composeVoiceWords(config, "ppm", { selfLearning: true, auto: [], nowMs: at(10).getTime() }).whisper).toEqual(["PPM"]);
    const later = composeVoiceWords(config, "ppm", { selfLearning: true, auto: [], nowMs: at(31).getTime() });
    expect(later.whisper).toEqual([]);
    expect(later.corrections).toEqual([]);
  });
});
