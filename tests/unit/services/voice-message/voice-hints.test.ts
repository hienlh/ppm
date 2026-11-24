/**
 * What a voice message sent as heard carries for its reader: the learned corrections whose heard
 * side is in the transcript, and the project's words that sound like a word of it — only matches,
 * never the whole list — and nothing at all when the surface tidies with Haiku instead.
 */
import { describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { soundKey, voiceHintsFor, voiceHintsForMessage } from "../../../../src/services/voice-message/voice-hints.ts";
import { normalizeVoiceConfig } from "../../../../src/services/voice-message/voice-settings.ts";
import { encodeVoicePart, type LearnedWord } from "../../../../src/shared/voice-message.ts";

const NOW = Date.parse("2026-11-24T01:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const learned = (word: string, from: string, extra: Partial<LearnedWord> = {}): LearnedWord => ({ word, from, at: daysAgo(1), ...extra });

const config = (over: Record<string, unknown> = {}) => normalizeVoiceConfig({
  enabled: true, self_learning: true, review_before_send: true, words: [],
  projects: {
    ppm: {
      words: ["Hono", "Telegram", "PPM"],
      learned: [
        learned("PPM", "BPM", { source: "cleanup", hits: 4 }),
        learned("Slack", "scale", { source: "edit" }),
        learned("Haiku", "hai cu", { source: "cleanup", lastUsedAt: daysAgo(40) }),
      ],
    },
    other: { words: [], learned: [learned("Grafana", "gờ ra pha na", { source: "edit" })] },
  },
  ...over,
});
const hintsFor = (transcript: string, over: Record<string, unknown> = {}, project = "ppm") =>
  voiceHintsFor({ config: config(over), project, transcript, auto: [], nowMs: NOW });

describe("voiceHintsFor", () => {
  it("names the corrections whose heard side was said, and only those", () => {
    expect(hintsFor("sửa cái BPM rồi báo scale nhé")?.misheard).toEqual([{ heard: "BPM", meant: "PPM" }, { heard: "scale", meant: "Slack" }]);
    expect(hintsFor("báo scale")?.misheard).toEqual([{ heard: "scale", meant: "Slack" }]);
  });

  it("leaves out a correction the transcript already spells right, and one that faded", () => {
    expect(hintsFor("BPM thì PPM")?.misheard ?? []).not.toContainEqual({ heard: "BPM", meant: "PPM" });
    expect(hintsFor("hỏi hai cu xem")?.misheard ?? []).toEqual([]);
  });

  it("finds a project word said with other marks, case or spacing, and one letter off for a longer word", () => {
    expect(soundKey("hồ nô")).toBe(soundKey("Hono"));
    expect(hintsFor("deploy cái hồ nô app")?.close).toEqual(["Hono"]);
    expect(hintsFor("gửi qua telegran")?.close).toEqual(["Telegram"]);
  });

  it("does not stretch a short word: three letters must match exactly", () => {
    // "PPM" is close to "BPM" only through the learned correction, never by spelling.
    const out = hintsFor("mở APM");
    expect(out?.close ?? []).not.toContain("PPM");
  });

  it("answers null when nothing in the message looks misheard", () => {
    expect(hintsFor("hôm nay trời đẹp")).toBeNull();
  });

  it("without self-learning keeps the user's own corrections and drops what the clean-up taught", () => {
    const out = hintsFor("sửa cái BPM rồi báo scale", { self_learning: false });
    expect(out?.misheard).toEqual([{ heard: "scale", meant: "Slack" }]);
  });

  it("gives the Assistant every project's corrections, a project only its own", () => {
    const assistant = normalizeVoiceConfig({ ...config(), projects: { ...config().projects, __assistant__: { words: [], learned: [] } } });
    const t = "mở gờ ra pha na";
    expect(voiceHintsFor({ config: assistant, project: "__assistant__", transcript: t, auto: [], nowMs: NOW })?.misheard)
      .toEqual([{ heard: "gờ ra pha na", meant: "Grafana" }]);
    expect(hintsFor(t)).toBeNull();
  });

  it("stays quick on a two-minute transcript against a full word list", () => {
    const words = Array.from({ length: 400 }, (_, i) => `Identifier${i}x`);
    const big = normalizeVoiceConfig({ ...config(), words });
    const transcript = Array.from({ length: 700 }, (_, i) => `từ${i % 50} nói`).join(" ");
    const run = () => voiceHintsFor({ config: big, project: "ppm", transcript, auto: [], nowMs: NOW });
    run(); // the first call compiles; a send pays that once per process
    const started = performance.now();
    for (let i = 0; i < 10; i++) run();
    // Measured 0.9 ms a call; the bound is loose for a loaded test machine.
    expect((performance.now() - started) / 10).toBeLessThan(30);
  });
});

describe("voiceHintsForMessage", () => {
  const message = (transcript: string) => encodeVoicePart({ path: "/x/uploads/a1-voice.webm", durationSec: 4, transcript });
  const deps = (over: Record<string, unknown> = {}, auto: string[] = []) => {
    const calls = { auto: 0 };
    return {
      calls,
      d: {
        read: () => config(over),
        autoVocabulary: async () => { calls.auto++; return auto.map((term) => ({ term, score: 1, strong: true })); },
        now: () => NOW,
      },
    };
  };

  it("attaches hints to a voice message from a surface set to hints", async () => {
    const { d } = deps();
    expect((await voiceHintsForMessage(message("sửa BPM"), "ppm", "composer", d))?.misheard).toEqual([{ heard: "BPM", meant: "PPM" }]);
  });

  it("attaches nothing to a message without a voice part, with voice off, or from a surface set to Haiku", async () => {
    expect(await voiceHintsForMessage("sửa BPM", "ppm", "composer", deps().d)).toBeNull();
    expect(await voiceHintsForMessage(message("sửa BPM"), "ppm", "composer", deps({ enabled: false }).d)).toBeNull();
    const telegramHaiku = deps({ transcript_fix: { composer: "hints", telegram: "haiku" } }).d;
    expect(await voiceHintsForMessage(message("sửa BPM"), "ppm", "telegram", telegramHaiku)).toBeNull();
    expect(await voiceHintsForMessage(message("sửa BPM"), "ppm", "composer", telegramHaiku)).not.toBeNull();
  });

  it("reads the picked-up words only when self-learning asks for them", async () => {
    const on = deps({}, ["Mission Center"]);
    expect((await voiceHintsForMessage(message("mở mission cen ter"), "ppm", "composer", on.d))?.close).toEqual(["Mission Center"]);
    const off = deps({ self_learning: false }, ["Mission Center"]);
    expect(await voiceHintsForMessage(message("mở mission cen ter"), "ppm", "composer", off.d)).toBeNull();
    expect(off.calls.auto).toBe(0);
  });

  it("sends the message without hints rather than failing it when reading the words fails", async () => {
    const broken = { read: () => { throw new Error("row unreadable"); } };
    expect(await voiceHintsForMessage(message("sửa BPM"), "ppm", "composer", broken)).toBeNull();
  });
});
