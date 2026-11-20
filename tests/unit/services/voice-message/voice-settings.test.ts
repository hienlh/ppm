import { afterEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { configService } from "../../../../src/services/config.service.ts";
import {
  appendLearnedWords, normalizeVoiceConfig, readVoiceSettings, updateVoiceSettings, VOICE_LIMITS, vocabularyOf, voiceMessagesEnabled,
} from "../../../../src/services/voice-message/voice-settings.ts";

const AT = "2026-11-20T10:00:00.000Z";

afterEach(() => configService.set("voice_message", { review_before_send: true, words: [], projects: {} }));

describe("normalizeVoiceConfig", () => {
  it("gives the defaults for anything that is not an object", () => {
    for (const raw of [undefined, null, "x", 3, []]) {
      expect(normalizeVoiceConfig(raw)).toEqual({ review_before_send: true, cleanup_enabled: true, words: [], projects: {} });
    }
  });

  it("keeps the Haiku clean-up on for a row written before the switch existed, off only when it says false", () => {
    expect(normalizeVoiceConfig({ review_before_send: true, words: [], projects: {} }).cleanup_enabled).toBe(true);
    expect(normalizeVoiceConfig({ cleanup_enabled: "no" }).cleanup_enabled).toBe(true);
    expect(normalizeVoiceConfig({ cleanup_enabled: false }).cleanup_enabled).toBe(false);
  });

  it("keeps enabled only when it is a boolean, and review on unless it is false", () => {
    expect(normalizeVoiceConfig({ enabled: "yes", review_before_send: "no" })).toEqual({ review_before_send: true, cleanup_enabled: true, words: [], projects: {} });
    expect(normalizeVoiceConfig({ enabled: false, review_before_send: false })).toMatchObject({ enabled: false, review_before_send: false });
  });

  it("trims, dedupes without case, drops bad words and caps the global list", () => {
    const words = ["  Hono ", "hono", "", 5, "x".repeat(61), "a  b", ...Array.from({ length: 400 }, (_, i) => `w${i}`)];
    const config = normalizeVoiceConfig({ words });
    expect(config.words.slice(0, 2)).toEqual(["Hono", "a b"]);
    expect(config.words).toHaveLength(VOICE_LIMITS.globalWords);
  });

  it("caps project words and keeps the newest learned entries, dropping malformed ones", () => {
    const learned = [
      { word: "bad", from: "x", at: "not a date" },
      { word: "", from: "x", at: AT },
      ...Array.from({ length: 250 }, (_, i) => ({ word: `L${i}`, from: `l${i}`, at: AT })),
    ];
    const config = normalizeVoiceConfig({ projects: { ppm: { words: Array.from({ length: 350 }, (_, i) => `p${i}`), learned }, "": {}, bad: 3 } });
    expect(Object.keys(config.projects)).toEqual(["ppm"]);
    expect(config.projects.ppm!.words).toHaveLength(VOICE_LIMITS.projectWords);
    expect(config.projects.ppm!.learned).toHaveLength(VOICE_LIMITS.learned);
    expect(config.projects.ppm!.learned.at(-1)!.word).toBe("L249");
    expect(config.projects.ppm!.learned[0]!.word).toBe("L50");
  });

  it("looks projects up by own key only, so a project named like an Object member has no words of its own", () => {
    const config = normalizeVoiceConfig({ words: ["Bun"], projects: JSON.parse('{"__proto__": {"words": ["evil"]}, "ppm": {"words": ["Hono"]}}') });
    expect(Object.getPrototypeOf(config.projects)).toBe(Object.prototype);
    expect(Object.keys(config.projects)).toEqual(["ppm"]);
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(vocabularyOf(config, name)).toEqual(["Bun"]);
    }
    expect(vocabularyOf(config, "ppm")).toEqual(["Hono", "Bun"]);
  });
});

describe("reading and writing the row", () => {
  it("reads a hand-broken row safely and treats a missing answer as off", () => {
    configService.set("voice_message", { words: "nope", projects: [] } as never);
    expect(readVoiceSettings()).toEqual({ review_before_send: true, cleanup_enabled: true, words: [], projects: {} });
    expect(voiceMessagesEnabled()).toBe(false);
  });

  it("applies a patch and leaves out what it does not name", () => {
    updateVoiceSettings({ enabled: true, words: ["Bun"] });
    updateVoiceSettings({ project: "ppm", projectWords: ["Hono", "hono"] });
    const config = readVoiceSettings();
    expect(config).toMatchObject({ enabled: true, review_before_send: true, words: ["Bun"] });
    expect(config.projects.ppm).toEqual({ words: ["Hono"], learned: [] });
    expect(voiceMessagesEnabled()).toBe(true);
  });

  it("learns only words no list holds yet, and forgets a learned one on request", () => {
    updateVoiceSettings({ words: ["Bun"], project: "ppm", projectWords: ["Hono"] });
    const added = appendLearnedWords("ppm", [
      { word: "bun", from: "bân", at: AT },
      { word: "Zustand", from: "du tan", at: AT },
      { word: "zustand", from: "zu", at: AT },
    ]);
    expect(added.map((l) => l.word)).toEqual(["Zustand"]);
    expect(vocabularyOf(readVoiceSettings(), "ppm")).toEqual(["Hono", "Zustand", "Bun"]);
    updateVoiceSettings({ project: "ppm", removeLearned: ["ZUSTAND"] });
    expect(readVoiceSettings().projects.ppm!.learned).toEqual([]);
  });
});
