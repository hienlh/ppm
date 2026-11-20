import { afterEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { fixesToShow, readyToLearn, replacements } from "../../../../src/services/voice-message/voice-learn-from-cleanup.ts";
import { appendLearnedWords, recordCleanupReplacements } from "../../../../src/services/voice-message/voice-learned-store.ts";
import { projectWordsOf, readVoiceSettings, updateVoiceSettings } from "../../../../src/services/voice-message/voice-settings.ts";

afterEach(() => configService.set("voice_message", { review_before_send: true, words: [], projects: {} }));

describe("replacements", () => {
  it("finds a misheard term the clean-up replaced", () => {
    expect(replacements("setting của BPM được", "setting của PPM được.")).toEqual([{ from: "BPM", to: "PPM", kind: "term" }]);
  });

  it("widens a one-word Vietnamese fix by its neighbour, so one syllable alone is never learned", () => {
    expect(replacements("test tính năng ta lệnh bằng giọng nói", "Test tính năng ra lệnh bằng giọng nói."))
      .toEqual([{ from: "ta lệnh", to: "ra lệnh", kind: "phrase" }]);
  });

  it("ignores punctuation, case, dropped fillers and added words", () => {
    expect(replacements("ờ thì anh muốn deploy", "Anh muốn deploy.")).toEqual([]);
    expect(replacements("deploy app", "deploy the app")).toEqual([]);
  });

  it("does not take a rewrite of many words for a misheard word", () => {
    expect(replacements("one two three four five six", "seven eight nine ten eleven twelve")).toEqual([]);
  });

  it("counts a project's own word as a term even without a capital or digit", () => {
    expect(replacements("dọn work tree đi", "dọn worktree đi", new Set(["worktree"]))).toEqual([{ from: "work tree", to: "worktree", kind: "term" }]);
  });

  it("fixesToShow lists what the card names", () => {
    expect(fixesToShow("của BPM, ta lệnh", "của PPM, ra lệnh")).toEqual([{ from: "BPM", to: "PPM" }, { from: "ta lệnh", to: "ra lệnh" }]);
  });
});

describe("readyToLearn", () => {
  const term = { from: "BPM", to: "PPM", kind: "term" as const };
  it("learns a term the project already uses after two messages, anything else after three", () => {
    expect(readyToLearn(term, 2, new Set(["ppm"]))).toBe(true);
    expect(readyToLearn(term, 2, new Set())).toBe(false);
    expect(readyToLearn(term, 3, new Set())).toBe(true);
    expect(readyToLearn({ from: "ta lệnh", to: "ra lệnh", kind: "phrase" }, 2, new Set(["ra lệnh"]))).toBe(false);
  });
});

describe("recordCleanupReplacements", () => {
  const bpm = [{ from: "BPM", to: "PPM", kind: "term" as const }];
  const own = () => projectWordsOf(readVoiceSettings(), "ppm");

  it("counts a replacement per message and learns it on the message that reaches the bar", () => {
    expect(recordCleanupReplacements("ppm", bpm, new Set(), new Date("2026-11-20T10:00:00Z"))).toEqual([]);
    expect(recordCleanupReplacements("ppm", bpm, new Set(), new Date("2026-11-20T11:00:00Z"))).toEqual([]);
    expect(own().candidates).toMatchObject([{ from: "BPM", to: "PPM", hits: 2 }]);
    const learned = recordCleanupReplacements("ppm", bpm, new Set(), new Date("2026-11-20T12:00:00Z"));
    expect(learned).toEqual([{ word: "PPM", from: "BPM", at: "2026-11-20T12:00:00.000Z", source: "cleanup", hits: 3, kind: "term" }]);
    expect(own().candidates ?? []).toEqual([]);
    // Seen again once learned: the learned word's count goes up, nothing is added.
    expect(recordCleanupReplacements("ppm", bpm, new Set())).toEqual([]);
    expect(own().learned[0]).toMatchObject({ word: "PPM", hits: 4 });
  });

  it("counts a pair once per message however often it appears in it", () => {
    recordCleanupReplacements("ppm", [...bpm, ...bpm], new Set(["ppm"]));
    expect(own().candidates).toMatchObject([{ hits: 1 }]);
  });

  it("never relearns an undone word until it is restored, and keeps projects apart", () => {
    recordCleanupReplacements("ppm", bpm, new Set(["ppm"]));
    recordCleanupReplacements("ppm", bpm, new Set(["ppm"]));
    expect(own().learned.map((l) => l.word)).toEqual(["PPM"]);
    expect(projectWordsOf(readVoiceSettings(), "other").learned).toEqual([]);
    updateVoiceSettings({ project: "ppm", removeLearned: ["PPM"] });
    expect(own().blocked).toMatchObject([{ word: "PPM", from: "BPM" }]);
    for (let i = 0; i < 4; i++) recordCleanupReplacements("ppm", bpm, new Set(["ppm"]));
    expect(own().learned).toEqual([]);
    expect(own().candidates ?? []).toEqual([]);
    updateVoiceSettings({ project: "ppm", restoreBlocked: ["ppm"] });
    // Restored as it was learned: its source, count and kind come back with it.
    expect(own().learned).toMatchObject([{ word: "PPM", from: "BPM", source: "cleanup", hits: 2, kind: "term" }]);
    expect(own().blocked ?? []).toEqual([]);
  });

  it("does not count a word the user typed into a list themself", () => {
    updateVoiceSettings({ words: ["PPM"] });
    recordCleanupReplacements("ppm", bpm, new Set(), new Date());
    expect(own().candidates ?? []).toEqual([]);
  });

  it("a correction the user typed lifts an undone word: the edit is explicit", () => {
    updateVoiceSettings({ project: "ppm", removeLearned: [] });
    configService.set("voice_message", {
      review_before_send: true, words: [],
      projects: { ppm: { words: [], learned: [], blocked: [{ word: "Hono", from: "hồ nô", at: "2026-11-19T10:00:00.000Z" }] } },
    });
    expect(appendLearnedWords("ppm", [{ word: "Hono", from: "hồ nô", at: "2026-11-20T10:00:00.000Z" }])).toHaveLength(1);
    expect(own().blocked ?? []).toEqual([]);
    expect(own().learned).toMatchObject([{ word: "Hono", source: "edit" }]);
  });
});
